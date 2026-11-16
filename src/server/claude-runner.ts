import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { randomUUID } from 'node:crypto';
import type { SpokenTurn } from '../shared/conversation';
import { failureReason } from '../shared/trace';
import { DelegationReply } from './delegation';
import type { Job, Session, SessionReporter } from './sessions';
import { WakeSignal } from './signals';

/**
 * Sends spoken requests from a Claude voice call to its BB backing thread and streams the reply
 * back into the session. It starts or steers only voice-owned work in that thread.
 */
export function createClaudeRunner(bb: Pick<BbPluginApi, 'sdk'>, report: SessionReporter) {
  const { trace, emit, changed } = report;
  async function run(session: Session, job: Job, text: string, turns: SpokenTurn[], previous: Job | null): Promise<void> {
    const marker = `[voice-request:${randomUUID()}]`;
    job.reply = new DelegationReply(marker);
    const signal = job.abort.signal;
    const latest = await bb.sdk.threads.events.list({ threadId: session.threadId, order: 'desc', limit: '1', signal });
    let cursor = latest[0]?.seq ?? 0;
    const thread = await bb.sdk.threads.get({ threadId: session.threadId, signal });
    if (signal.aborted) return;
    const active = thread.status !== 'idle' && thread.status !== 'error';
    if (active && (!previous || previous.finished || !previous.reply.accepted)) throw new Error('The backing thread is already working on another task. Wait or cancel it in BB.');
    const prepared = session.context.prepare(marker, text, turns);
    trace(session, 'backing.submit', () => ({ id: job.id, ...(session.diagnostics === 'detailed' ? { text } : {}), state: active ? 'steer' : 'start' }));
    const sent = await bb.sdk.threads.send({ threadId: session.threadId, mode: active ? 'steer' : 'start', input: prepared.input });
    if (sent.delivery !== 'sent') throw new Error('The backing thread did not accept this request immediately.');
    if (previous) { session.superseded.add(previous.id); previous.abort.abort(); }
    let committed = false;
    const deadline = Date.now() + 10 * 60_000;
    const streamed = new Map<string, string>();
    while (!signal.aborted && Date.now() < deadline) {
      const rows = await bb.sdk.threads.events.list({ threadId: session.threadId, afterSeq: String(cursor), order: 'asc', limit: '100', signal });
      for (const row of rows) {
        cursor = Math.max(cursor, row.seq); job.reply.consume(row);
        if (job.reply.accepted && !committed) { prepared.accept(); committed = true; trace(session, 'backing.accepted', { id: job.id }); }
        if (!job.reply.accepted || row.scope.kind !== 'turn' || row.scope.turnId !== job.reply.turnId || session.job !== job) continue;
        if (row.type === 'item/agentMessage/delta' && !row.data.parentToolCallId) {
          streamed.set(row.data.itemId, (streamed.get(row.data.itemId) ?? '') + row.data.delta);
          emit(session, job.id, row.data.delta);
        }
        if (row.type === 'item/completed' && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId) {
          const before = streamed.get(row.data.item.id) ?? '';
          const full = row.data.item.text;
          if (full.startsWith(before)) { if (full.length > before.length) emit(session, job.id, full.slice(before.length)); }
          else emit(session, job.id, 'Correction to the preceding backing-agent text: ' + full);
          streamed.set(row.data.item.id, full);
        }
      }
      if (job.reply.done) {
        if (session.job === job) {
          const error = job.reply.error ?? (!job.reply.text.trim() && !streamed.size ? 'The backing agent finished without a final answer.' : null);
          emit(session, job.id, error ?? '', true);
        }
        return;
      }
      if (rows.length < 100) await job.signal.wait(signal);
    }
    if (!signal.aborted) throw new Error('The backing agent is still working after ten minutes. Check the BB thread for its result.');
  }
  function delegate(session: Session, id: string, text: string, turns: SpokenTurn[]): { accepted: boolean } {
    if (session.seen.has(id)) return { accepted: true };
    if (session.seen.size >= 100) throw new Error('Start a fresh voice call to continue.');
    session.seen.add(id);
    const previous = session.job;
    const job: Job = { id, abort: new AbortController(), signal: new WakeSignal(), reply: new DelegationReply('pending'), finished: false, emitted: false };
    session.job = job; changed(session);
    const abort = () => job.abort.abort(); session.abort.signal.addEventListener('abort', abort, { once: true });
    void run(session, job, text, turns, previous).catch(error => {
      if (!job.abort.signal.aborted) {
        trace(session, 'backing.failed', { id: job.id, reason: failureReason(error) });
        emit(session, id, 'The request could not be completed: ' + (error instanceof Error ? error.message : String(error)), true);
        if (previous && !previous.finished) session.job = previous;
      }
    }).finally(() => {
      job.finished = true; session.abort.signal.removeEventListener('abort', abort);
      if (session.job === job) session.job = null;
      session.attention = false; changed(session);
    });
    return { accepted: true };
  }
  return { delegate };
}

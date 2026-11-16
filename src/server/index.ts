import { selectedVoice, voiceNames, type Voice } from '../shared/voices';
import { createHash, randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract } from '../shared/contract';
import { createSubscriptionCall } from './codex';
import type { SpokenTurn } from '../shared/conversation';
import { DelegationContext, DelegationReply } from './delegation';
import { nativeVoice } from './native';
import { WakeSignal } from './signals';
import { createTraceStore } from './trace-store';
import { acceptsTrace, failureReason, rateLimitedWarning, selectTrace, type Diagnostics, type TraceData } from '../shared/trace';
import { createBriefingCache } from './briefing/briefing-cache';
import { synthesizeBriefing } from './briefing/synthesize';

type BackgroundMode = 'off' | 'cached';

type Update = { seq: number; id: string; text: string; channel: 'speakable' | 'developer'; final: boolean };
interface Job { id: string; abort: AbortController; signal: WakeSignal; reply: DelegationReply; finished: boolean; emitted: boolean; }
interface Session {
  id: string; threadId: string; adapter: 'native' | 'delegated'; abort: AbortController; touched: number; startedAt: number; backgroundMode: BackgroundMode; title: string | null; diagnostics: Diagnostics; warn(): void;
  updates: Update[]; sequence: number; superseded: Set<string>; seen: Set<string>; job: Job | null; attention: boolean;
  context: DelegationContext; backgroundContext: string | null; ended: string | null;
  nativeSignal: WakeSignal; nativeCursor: number; nativeWorking: boolean; notifying: boolean;
}

export function createPlugin(connect?: (sdp: string, startupBriefing?: string | null, voice?: Voice) => Promise<string>, nativeConnect: typeof nativeVoice = nativeVoice, synthesize: typeof synthesizeBriefing = synthesizeBriefing) {
  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({ diagnostics: { type: 'select', label: 'Diagnostics', description: 'Basic saves compact metadata. Detailed records private text, deltas and chunk timing for troubleshooting. Applies to new calls.', options: ['basic', 'detailed'], default: 'basic' }, voice: { type: 'select', label: 'Voice', description: 'Voice for new Codex and Claude calls. Default keeps Codex’s voice choice (normally Cove). End and start a new call after changing this setting.', options: ['default', ...voiceNames], default: 'default' }, cachedBriefing: { type: 'boolean', label: 'Cached briefing', description: 'Experimental: supply a current prepared briefing when a new call starts. If unavailable, use retrieval for that call. Changes apply to new calls.', default: false }, codexCommand: { type: 'string', label: 'Codex executable', description: 'Official Codex CLI on the BB server, signed in with ChatGPT. Used for briefing synthesis and Claude’s voice transport. Native Codex voice uses its provider connection.', default: 'codex' } });
    const openCall = connect ?? (async (sdp: string, startupBriefing?: string | null, voice?: Voice) => createSubscriptionCall(sdp, (await settings.get()).codexCommand, startupBriefing, voice));
    const sessions = new Map<string, Session>();
    const traces = createTraceStore(bb);
    const briefings = createBriefingCache(bb, traces.database, async (source, signal) => synthesize(source, (await settings.get()).codexCommand, signal));
    settings.onChange(next => { if (!next.cachedBriefing) briefings.cancel(); });
    let traceSequence = 0;
    function trace(session: Session, name: string, data: TraceData | (() => TraceData) = {}): void {
      if (!acceptsTrace(name, session.diagnostics)) return;
      const selected = selectTrace(name, typeof data === 'function' ? data() : data, session.diagnostics);
      if (!selected) return;
      try { traces.write(session.id, 'server', [{ seq: ++traceSequence, at: Date.now(), elapsedMs: Math.max(0, Date.now() - session.startedAt), name, data: selected }]); }
      catch { session.warn(); }
    }
    function changed(session: Session): void {
      if (session.abort.signal.aborted || session.notifying) return;
      session.notifying = true;
      queueMicrotask(() => { session.notifying = false; if (!session.abort.signal.aborted) bb.realtime.publish('voice-changed', { sessionId: session.id }); });
    }
    function emit(session: Session, id: string, text: string, final = false, channel: Update['channel'] = 'speakable'): void {
      if (session.abort.signal.aborted) return;
      const first = session.job?.id === id && !session.job.emitted && !!text;
      if (session.job?.id === id && text) session.job.emitted = true;
      if (session.diagnostics === 'detailed' || first || final) trace(session, session.diagnostics === 'detailed' ? 'backing.update' : 'backing.milestone', () => ({ id, ...(session.diagnostics === 'detailed' ? { text: text.slice(0, 32000), truncated: text.length > 32000 } : {}), characters: text.length, final, channel, updateSeq: session.sequence + 1, state: final ? 'completed' : 'first-result' }));
      session.updates.push({ seq: ++session.sequence, id, text, final, channel });
      while (session.updates.length > 512 || session.updates.reduce((sum, update) => sum + update.text.length, 0) > 128000) session.updates.shift();
      changed(session);
    }
    async function end(id: string): Promise<boolean> {
      const session = sessions.get(id);
      if (!session) return false;
      trace(session, 'session.stop');
      sessions.delete(id); session.abort.abort(); session.job?.abort.abort();
      if (session.adapter === 'native') await nativeConnect(bb, session.threadId, { action: 'stop', sessionId: id }).catch(() => {});
      return true;
    }
    function get(id: string): Session {
      const session = sessions.get(id);
      if (!session) throw new Error('Voice session ended. Start voice again.');
      session.touched = Date.now(); return session;
    }
    async function observeNative(session: Session): Promise<void> {
      while (!session.abort.signal.aborted) {
        const rows = await bb.sdk.threads.events.list({ threadId: session.threadId, afterSeq: String(session.nativeCursor), order: 'asc', limit: '100', ...(session.diagnostics === 'basic' ? { types: ['turn/started', 'turn/completed', 'thread/extensionState/updated'] as const } : {}), signal: session.abort.signal });
        for (const row of rows) {
          session.nativeCursor = Math.max(session.nativeCursor, row.seq);
          if (row.type === 'item/agentMessage/delta' && !row.data.parentToolCallId) trace(session, 'native.backing.delta', () => ({ id: row.data.itemId, text: row.data.delta.slice(0, 32000), characters: row.data.delta.length, truncated: row.data.delta.length > 32000, eventAt: row.createdAt, updateSeq: row.seq }));
          if (row.type === 'item/completed' && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId) { const item = row.data.item; trace(session, 'native.backing.completed', () => ({ id: item.id, text: item.text.slice(0, 32000), characters: item.text.length, truncated: item.text.length > 32000, eventAt: row.createdAt, updateSeq: row.seq })); }
          if (row.type === 'turn/started' || row.type === 'turn/completed') { trace(session, 'native.backing.turn', { type: row.type, eventAt: row.createdAt, updateSeq: row.seq }); session.nativeWorking = row.type === 'turn/started'; changed(session); }
          if (row.type !== 'thread/extensionState/updated' || row.data.kind !== 'provider-codex/voice') continue;
          const state = z.object({ sessionId: z.string(), status: z.string(), message: z.string().nullable(), backgroundContext: z.string().optional() }).safeParse(row.data.payload);
          if (!state.success || state.data.sessionId !== session.id) continue;
          trace(session, 'native.state', { state: state.data.status, ...(state.data.status === 'active' ? {} : { reason: failureReason(state.data.message) }), characters: state.data.backgroundContext?.length });

          if (state.data.status !== 'active') session.ended = state.data.message ?? 'Native voice session ended';
          changed(session);
        }
        if (rows.length < 100) await session.nativeSignal.wait(session.abort.signal);
      }
    }
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
    bb.rpc.register(rpcContract, {
      trace: ({ sessionId, entries }) => ({ saved: traces.write(sessionId, 'browser', entries) }),
      traceSessions: ({ threadId }) => traces.list(threadId) as { sessionId: string; threadId: string; adapter: string; startedAt: number; diagnostics: Diagnostics; bytes: number; dropped: number }[],
      traceRead: ({ sessionId, afterId }) => traces.read(sessionId, afterId),
      briefingStatus: ({ threadId }) => briefings.inspect(threadId),
      prepareBriefing: ({ threadId }) => briefings.request(threadId),
      forgetBriefing: ({ threadId }) => { briefings.forget(threadId); return { forgotten: true }; },
      available: async ({ threadId }) => { const thread = await bb.sdk.threads.get({ threadId }); return { available: ['codex', 'claude-code', 'claude'].includes(thread.providerId) }; },
      start: async ({ sessionId, threadId, sdp }) => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (sessions.has(sessionId) || [...sessions.values()].some(session => session.threadId === threadId)) throw new Error('This thread already has a Tandem call. End it first.');
        if (sessions.size >= 4) throw new Error('Four Tandem calls are already open. End a call first.');
        const callConfig = await settings.get();
        const voice = selectedVoice(callConfig.voice);
        const adapter: Session['adapter'] = thread.providerId === 'codex' ? 'native' : 'delegated';
        const session: Session = { id: sessionId, threadId, adapter, abort: new AbortController(), touched: Date.now(), startedAt: Date.now(), backgroundMode: callConfig.cachedBriefing ? 'cached' : 'off', title: thread.title, diagnostics: callConfig.diagnostics as Diagnostics, warn: rateLimitedWarning(() => bb.log.warn('Voice diagnostic records could not be saved')), updates: [], sequence: 0, superseded: new Set(), seen: new Set(), job: null, attention: false, context: new DelegationContext(), backgroundContext: null, ended: null, nativeSignal: new WakeSignal(), nativeCursor: 0, nativeWorking: thread.status === 'active', notifying: false };
        sessions.set(sessionId, session);
        try { traces.start(sessionId, threadId, adapter, session.diagnostics); trace(session, 'session.start', { state: adapter }); trace(session, 'session.voice', { state: voice ?? 'default' }); trace(session, 'context.policy', { state: session.backgroundMode }); trace(session, 'diagnostics.policy', { state: session.diagnostics }); } catch { session.warn(); }
        try {
          const startup = session.backgroundMode === 'cached' ? await briefings.startupStatus(threadId) : undefined;
          const startupBriefing = startup?.text;
          if (startup) trace(session, 'context.startup', () => ({ state: startup.state, reason: 'attempt', ...(startup.generatedAt ? { ageMs: Math.max(0, Date.now() - startup.generatedAt) } : {}), characters: startupBriefing?.length ?? 0, ...(startupBriefing ? { fingerprint: createHash('sha256').update(startupBriefing).digest('hex'), ...(session.diagnostics === 'detailed' ? { text: startupBriefing } : {}) } : {}) }));
          let answer: string;
          if (adapter === 'native') {
            const latest = await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '1' }); session.nativeCursor = latest[0]?.seq ?? 0;
            const result = await nativeConnect(bb, threadId, { action: 'start', sessionId, sdp, ...(voice ? { experimental_voice: voice } : {}), ...(session.backgroundMode === 'cached' ? { experimental_startupBriefing: startupBriefing ?? null } : {}) });
            if (!result.sdp) throw new Error('Native Codex did not return an SDP answer');
            answer = result.sdp;
            void observeNative(session).catch(error => { if (!session.abort.signal.aborted) { session.ended = String(error); trace(session, 'session.failed', { reason: failureReason(error) }); changed(session); } });
          } else answer = await openCall(sdp, startupBriefing, voice);
          if (session.abort.signal.aborted) throw new Error('Voice call ended while connecting.');
          trace(session, 'session.connect', { state: 'negotiated' });
          return { sdp: answer, adapter, diagnostics: session.diagnostics, ...(session.backgroundMode === 'cached' ? { briefing: startupBriefing ? 'ready' as const : 'lookup' as const } : {}) };
        } catch (error) { trace(session, 'session.failed', { reason: failureReason(error) }); await end(sessionId); throw error; }
      },
      stop: async ({ sessionId }) => ({ stopped: await end(sessionId) }),
      control: async ({ sessionId }) => {
        const session = get(sessionId);
        if (session.adapter === 'delegated' && !session.job) return { requested: false };
        await bb.sdk.threads.stop({ threadId: session.threadId });
        session.job?.signal.notify(); session.nativeSignal.notify(); changed(session);
        return { requested: true };
      },
      context: async ({ sessionId }) => {
        const session = get(sessionId);
        return { text: session.backgroundContext };
      },
      poll: async ({ sessionId, afterSeq }) => {
        const session = get(sessionId);
        if (session.adapter === 'native') await nativeConnect(bb, session.threadId, { action: 'keepAlive', sessionId });
        if (session.job || session.nativeWorking) session.attention = (await bb.sdk.threads.interactions.list({ threadId: session.threadId })).length > 0;
        if (afterSeq !== undefined && session.updates.length && afterSeq < session.updates[0]!.seq - 1) throw new Error('Voice updates expired before delivery. Restart voice and check the complete backing answer in BB.');
        return { updates: session.updates.filter(update => update.seq > (afterSeq ?? 0) && !session.superseded.has(update.id)), state: session.attention ? 'attention' as const : (session.job || session.nativeWorking) ? 'working' as const : 'ready' as const, backgroundContext: session.backgroundContext, ended: session.ended };
      },
      delegate: ({ sessionId, id, text, turns }) => {
        const session = get(sessionId);
        if (session.adapter === 'native') throw new Error('Native Codex owns its delegations; the plugin must not execute them twice.');
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
      },
    });
    bb.events.on('experimental_thread.events', ({ thread }) => { for (const session of sessions.values()) if (session.threadId === thread.id) { session.job?.signal.notify(); session.nativeSignal.notify(); } });
    const wake = ({ thread }: { thread: { id: string } }) => { for (const session of sessions.values()) if (session.threadId === thread.id) { session.job?.signal.notify(); session.nativeSignal.notify(); changed(session); } };
    bb.events.on('thread.idle', async event => { wake(event); if ((await settings.get()).cachedBriefing && briefings.watched(event.thread.id)) await briefings.request(event.thread.id); });
    bb.events.on('thread.active', event => briefings.invalidate(event.thread.id)); bb.events.on('thread.failed', wake);
    bb.events.on('interaction.pending', event => { for (const session of sessions.values()) if (session.threadId === event.thread.id) { session.attention = true; changed(session); } });
    const warnCleanup = rateLimitedWarning(() => bb.log.warn('Voice trace retention cleanup failed'));
    const timer = setInterval(() => { try { traces.prune(); briefings.prune(); } catch { warnCleanup(); } for (const session of sessions.values()) if (Date.now() - session.touched > 60000) void end(session.id); }, 10000);
    timer.unref?.();
    bb.onDispose(async () => { clearInterval(timer); await briefings.dispose(); await Promise.all([...sessions.keys()].map(end)); });
    const terminal = async ({ thread }: { thread: { id: string } }) => { briefings.forget(thread.id); await Promise.all([...sessions.values()].filter(session => session.threadId === thread.id).map(session => end(session.id))); };
    bb.events.on('thread.archived', terminal); bb.events.on('thread.deleted', terminal);
  };
}

export default createPlugin();

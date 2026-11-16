import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { Database } from '../storage';
import { z } from 'zod';
import type { BriefingStatus as Status } from '../../shared/contract';
import { startupReference } from '../prompts';
import { briefingEvidence, briefingRevision, type Evidence } from './briefing';

const rowSchema = z.object({ revision: z.string().nullable(), generated_at: z.number().nullable(), text: z.string().nullable(), status: z.string(), error: z.string().nullable() });
export function createBriefingCache(bb: BbPluginApi, db: Database, generate: (source: Evidence, signal: AbortSignal) => Promise<string>) {
  const queue = new Set<string>();
  let worker: Promise<void> | null = null, current: { threadId: string; abort: AbortController } | null = null, disposed = false;
  function watched(threadId: string): boolean { return !!db.prepare('SELECT thread_id FROM voice_briefings WHERE thread_id = ?').get(threadId); }
  function prune() {
    db.prepare('DELETE FROM voice_briefings WHERE touched < ? OR thread_id NOT IN (SELECT thread_id FROM voice_briefings ORDER BY touched DESC, rowid DESC LIMIT 20)').run(Date.now() - 7 * 86400000);
  }
  function watch(threadId: string) { db.prepare('INSERT INTO voice_briefings (thread_id, touched) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET touched = excluded.touched').run(threadId, Date.now()); prune(); }
  async function inspect(threadId: string): Promise<Status> {
    const head = await briefingRevision(bb, threadId);
    const raw = db.prepare('SELECT * FROM voice_briefings WHERE thread_id = ?').get(threadId);
    const row = raw ? rowSchema.parse(raw) : null;
    const state = head.thread.status !== 'idle' ? 'busy' : row?.status === 'preparing' ? 'preparing' : row?.text && row.revision === head.revision && row.generated_at && Date.now() - row.generated_at < 86400000 ? 'ready' : row?.text ? 'stale' : row?.status === 'error' ? 'error' : 'missing';
    return { state, generatedAt: row?.generated_at ?? null, text: state === 'ready' ? row!.text : null, error: row?.error ?? null };
  }
  async function work() {
    while (!disposed && queue.size) {
      const threadId = queue.values().next().value!; queue.delete(threadId);
      current = { threadId, abort: new AbortController() };
      const signal = current.abort.signal;
      try {
        const head = await briefingRevision(bb, threadId, signal);
        if (signal.aborted) continue;
        if (head.thread.status !== 'idle' || head.thread.archivedAt !== null || !watched(threadId)) continue;
        const row = rowSchema.parse(db.prepare('SELECT * FROM voice_briefings WHERE thread_id = ?').get(threadId));
        if (row.text && row.revision === head.revision && row.generated_at && Date.now() - row.generated_at < 86400000) continue;
        db.prepare("UPDATE voice_briefings SET status = 'preparing', error = NULL WHERE thread_id = ?").run(threadId);
        const source = await briefingEvidence(bb, threadId, signal);
        if (signal.aborted) continue;
        if (source.items.length === 0) { db.prepare("UPDATE voice_briefings SET status = 'missing' WHERE thread_id = ?").run(threadId); continue; }
        const text = await generate(source, signal);
        if (disposed || signal.aborted) continue;
        const latest = await briefingRevision(bb, threadId, signal);
        if (latest.thread.status !== 'idle' || latest.revision !== source.revision) {
          db.prepare("UPDATE voice_briefings SET status = 'stale' WHERE thread_id = ?").run(threadId);
          if (latest.thread.status === 'idle') queue.add(threadId);
          continue;
        }
        db.prepare("UPDATE voice_briefings SET revision = ?, generated_at = ?, text = ?, status = 'ready', error = NULL WHERE thread_id = ?").run(source.revision, Date.now(), text, threadId);
      } catch (error) {
        if (!disposed && watched(threadId)) db.prepare("UPDATE voice_briefings SET status = 'error', error = ? WHERE thread_id = ?").run((signal.aborted ? 'Preparation cancelled' : String(error)).slice(0, 300), threadId);
      } finally { current = null; }
    }
  }
  function enqueue(threadId: string) {
    if (disposed) return;
    queue.add(threadId);
    if (!worker) worker = work().finally(() => { worker = null; if (!disposed && queue.size) enqueue(queue.values().next().value!); });
  }
  return {
    watched, inspect, prune,
    async request(threadId: string) { watch(threadId); const status = await inspect(threadId); if (status.state !== 'busy' && status.state !== 'ready') enqueue(threadId); return status; },
    async startup(threadId: string) { return (await this.startupStatus(threadId)).text; },
    async startupStatus(threadId: string) {
      watch(threadId);
      const status = await inspect(threadId);
      if (status.state !== 'ready') { if (status.state !== 'busy') enqueue(threadId); return { state: status.state, generatedAt: status.generatedAt, text: null }; }
      return { state: status.state, generatedAt: status.generatedAt, text: startupReference(status.text!) };
    },
    invalidate(threadId: string) { if (!disposed && watched(threadId)) { db.prepare("UPDATE voice_briefings SET status = 'stale', text = NULL WHERE thread_id = ?").run(threadId); if (current?.threadId === threadId) current.abort.abort(); } },
    forget(threadId: string) { queue.delete(threadId); if (current?.threadId === threadId) current.abort.abort(); db.prepare('DELETE FROM voice_briefings WHERE thread_id = ?').run(threadId); },
    cancel() { queue.clear(); current?.abort.abort(); },
    async dispose() { disposed = true; queue.clear(); current?.abort.abort(); await worker; },
  };
}

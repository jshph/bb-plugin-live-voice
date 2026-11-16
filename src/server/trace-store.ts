import type { Database } from './storage';
import { diagnosticsSchema, selectTrace, type Diagnostics, type TraceEntry } from '../shared/trace';

/** Diagnostics traces in the plugin database, with bounded per-call and total retention. */
export function createTraceStore(db: Database) {
  const prune = db.transaction(() => {
    db.prepare('DELETE FROM voice_trace_sessions WHERE started_at < ? OR id NOT IN (SELECT id FROM voice_trace_sessions ORDER BY started_at DESC, rowid DESC LIMIT 20)').run(Date.now() - 7 * 86400000);
    db.prepare('DELETE FROM voice_trace_events WHERE session_id NOT IN (SELECT id FROM voice_trace_sessions)').run();
  });
  prune();
  const write = db.transaction((sessionId: string, source: string, entries: TraceEntry[]) => {
    const session = db.prepare('SELECT bytes, diagnostics FROM voice_trace_sessions WHERE id = ?').get(sessionId) as { bytes: number; diagnostics: string } | undefined;
    if (!session) return false;
    let bytes = session.bytes, dropped = 0;
    const mode = diagnosticsSchema.parse(session.diagnostics);
    const budget = mode === 'basic' ? 256000 : 2_000_000;
    for (const entry of entries) {
      const data = selectTrace(entry.name, entry.data, mode);
      if (!data) continue;
      const limit = ['session.stop', 'session.failed', 'client.stop', 'context.failed', 'backing.failed', 'delegation.unsent', 'audio.play.blocked'].includes(entry.name) || entry.name === 'realtime.received' && data.type === 'error' ? budget : budget - 32000;
      if (bytes >= limit) { dropped++; continue; }
      const json = JSON.stringify({ ...entry, data }), length = Buffer.byteLength(json);
      if (bytes + length > limit) { dropped++; continue; }
      const result = db.prepare('INSERT OR IGNORE INTO voice_trace_events VALUES (?, ?, ?, ?, ?)').run(sessionId, source, entry.seq, Date.now(), json);
      if (result.changes) bytes += length;
    }
    db.prepare('UPDATE voice_trace_sessions SET bytes = ?, dropped = dropped + ? WHERE id = ?').run(bytes, dropped, sessionId);
    return true;
  });
  return {
    start(id: string, threadId: string, adapter: string, diagnostics: Diagnostics = 'basic') { db.prepare('INSERT OR REPLACE INTO voice_trace_sessions (id, thread_id, adapter, started_at, diagnostics) VALUES (?, ?, ?, ?, ?)').run(id, threadId, adapter, Date.now(), diagnostics); prune(); },
    write,
    prune,
    list(threadId?: string) { prune(); return db.prepare('SELECT id AS sessionId, thread_id AS threadId, adapter, started_at AS startedAt, diagnostics, bytes, dropped FROM voice_trace_sessions WHERE (? IS NULL OR thread_id = ?) ORDER BY started_at DESC, rowid DESC').all(threadId ?? null, threadId ?? null); },
    read(id: string, afterId: number) { prune(); return db.prepare('SELECT rowid AS cursor, source, received_at AS receivedAt, entry FROM voice_trace_events WHERE session_id = ? AND rowid > ? ORDER BY rowid LIMIT 200').all(id, afterId).map((row: unknown) => { const r = row as { cursor: number; source: string; receivedAt: number; entry: string }; return { ...r, entry: JSON.parse(r.entry) as TraceEntry }; }); },
  };
}

import type { BbPluginApi } from '@get-bb/plugin-sdk';

export type Database = ReturnType<BbPluginApi['storage']['database']>;

/**
 * The plugin database's migrations, shared by diagnostics traces and the briefing cache.
 * Existing installations have applied these in order: never edit, reorder or remove one; append only.
 */
export const migrations = [
  'CREATE TABLE voice_trace_sessions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, adapter TEXT NOT NULL, started_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE voice_trace_events (session_id TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL, received_at INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(session_id, source, seq))',
  'CREATE TABLE voice_briefings (thread_id TEXT PRIMARY KEY, touched INTEGER NOT NULL, revision TEXT, generated_at INTEGER, text TEXT, status TEXT NOT NULL DEFAULT \'missing\', error TEXT)',
  "ALTER TABLE voice_trace_sessions ADD COLUMN diagnostics TEXT NOT NULL DEFAULT 'detailed'",
] as const;

export function openDatabase(bb: Pick<BbPluginApi, 'storage'>): Database {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...migrations]);
  return db;
}

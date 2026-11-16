import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { migrations, openDatabase } from './storage';
import { createTraceStore } from './trace-store';

it('keeps the applied migrations byte-for-byte and in order', () => {
  // Installed databases have applied these four statements. New migrations may only be appended.
  expect(createHash('sha256').update(JSON.stringify(migrations.slice(0, 4))).digest('hex')).toBe('bfa16393899dc007d41ac23fbba8daa17ae8c9fe1612eeb63089e1b5b631b7fd');
});

it('creates the trace and briefing tables in one plugin database', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice' });
  try {
    const db = openDatabase(bb);
    const traces = createTraceStore(db);
    traces.start('call', 'thread', 'native', 'basic');
    expect(traces.list()).toMatchObject([{ sessionId: 'call', diagnostics: 'basic' }]);
    db.prepare('INSERT INTO voice_briefings (thread_id, touched) VALUES (?, ?)').run('thread', Date.now());
    expect(db.prepare("SELECT status FROM voice_briefings WHERE thread_id = 'thread'").get()).toEqual({ status: 'missing' });
  } finally { await harness.lifecycle.dispose(); }
});

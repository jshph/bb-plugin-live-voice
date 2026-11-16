import { describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { BrowserTrace, describeVoiceEvent, type TraceEntry } from '../shared/trace';
import { createPlugin } from './index';
import { createTraceStore } from './trace-store';

const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
const entry: TraceEntry = { seq: 1, at: 100, elapsedMs: 5, name: 'context.sent', data: { text: 'quoted background', channel: 'developer', bytes: 17 } };

describe('diagnostic tracing', () => {
  it('selects transcript/turn data without recording audio, SDP, credentials or unrelated payloads', () => {
    expect(describeVoiceEvent({ type: 'output_audio.delta', delta: 'audio bytes' })).toBeNull();
    expect(describeVoiceEvent({ type: 'session.created', sdp: 'secret' })).toBeNull();
    expect(describeVoiceEvent({ type: 'turn.done', turn: { role: 'user', id: 'turn' }, token: 'secret', sdp: 'secret' })).toEqual({ type: 'turn.done', role: 'user', id: 'turn' });
    expect(describeVoiceEvent({ type: 'output_transcript.added', item: { text: 'hello', id: 'speech' }, audio: 'bytes' }, 'detailed')).toEqual({ type: 'output_transcript.added', id: 'speech', text: 'hello', characters: 5, truncated: false });
    expect(describeVoiceEvent({ type: 'input_transcript.added', item: { text: 'x'.repeat(33000) } }, 'detailed')).toMatchObject({ characters: 33000, truncated: true, text: 'x'.repeat(32000) });
  });
  it('flushes ordered batches and marks failed batches with sequence gaps instead of blocking later delivery', async () => {
    const batches: TraceEntry[][] = [];
    const send = vi.fn(async (entries: TraceEntry[]) => { batches.push(entries); if (batches.length === 1) throw new Error('offline'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const trace = new BrowserTrace(send); trace.configure('detailed');
      for (let i = 0; i < 55; i++) trace.record('turn', { id: String(i) });
      await trace.flush();
      expect(batches.map(batch => batch.length)).toEqual([50, 5]);
      expect(batches[1]![0]!.seq).toBe(51);
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });
  it('retains per-call traces after call end, with idempotent browser batches', async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: { get: async () => makeThreadResponse({ id: 'thread', providerId: 'claude', status: 'idle' }) } } });
    const plugin = createPlugin(async () => 'answer');
    await plugin(bb);
    try {
      await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'sensitive SDP' });
      await harness.behavior.callRpc('stop', { sessionId });
      await harness.behavior.callRpc('trace', { sessionId, entries: [entry] });
      await harness.behavior.callRpc('trace', { sessionId, entries: [entry] });
      const rows = await harness.behavior.callRpc('traceRead', { sessionId }) as { source: string; entry: TraceEntry }[];
      expect(rows.filter(row => row.source === 'browser')).toHaveLength(1);
      expect(rows.some(row => row.entry.name === 'session.stop')).toBe(true);
      expect(JSON.stringify(rows)).not.toContain('sensitive SDP');
      expect(await harness.behavior.callRpc('traceSessions', { threadId: 'other' })).toEqual([]);
      expect(await harness.behavior.callRpc('traceSessions', { threadId: 'thread' })).toMatchObject([{ sessionId, adapter: 'delegated', dropped: 0 }]);
    } finally { await harness.lifecycle.dispose(); }
  });
  it('bounds retained calls and bytes, reports drops, and returns stable cursor pages', async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice' });
    try {
      const store = createTraceStore(bb);
      for (let i = 0; i < 21; i++) store.start('call-' + i, 'thread', 'native');
      expect(store.list()).toHaveLength(20);
      store.start(sessionId, 'thread', 'native', 'detailed');
      for (let i = 1; i <= 100; i++) store.write(sessionId, 'browser', [{ ...entry, seq: i, data: { text: 'x'.repeat(32000) } }]);
      const session = store.list().find((row: unknown) => (row as { sessionId: string }).sessionId === sessionId) as { bytes: number; dropped: number };
      expect(session.bytes).toBeLessThanOrEqual(2_000_000);
      expect(session.dropped).toBeGreaterThan(0);
      const page = store.read(sessionId, 0);
      expect(page.length).toBeGreaterThan(0);
      expect(store.read(sessionId, page.at(-1)!.cursor)).toEqual([]);
    } finally { await harness.lifecycle.dispose(); }
  });
});

it('basic browser diagnostics omit text and skip detailed payload construction before sending', async () => {
  const batches: TraceEntry[][] = [];
  const trace = new BrowserTrace(async entries => { batches.push(entries); });
  const expensive = vi.fn(() => ({ text: 'private result' }));
  for (let i = 0; i < 300; i++) trace.record('native.backing.delta', expensive);
  trace.record('context.sent', { text: 'private background', bytes: 18 });
  trace.record('adapter.selected', { state: 'native' });
  trace.record('realtime.received', { type: 'session.context.appended' });
  trace.record('realtime.received', { type: 'output_transcript.delta', text: 'private transcript' });
  trace.record('realtime.received', { type: 'turn.done', role: 'user', text: 'private words' });
  await trace.flush();
  expect(expensive).not.toHaveBeenCalled();
  expect(batches.flat().map(row => row.name)).toEqual(['context.sent', 'realtime.received']);
  expect(JSON.stringify(batches)).not.toContain('private');
  expect(describeVoiceEvent({ type: 'output_transcript.added', item: { text: 'private words' } })).toBeNull();
  expect(describeVoiceEvent({ type: 'session.context.appended' }, 'detailed')).toBeNull();
});
it('detailed browser diagnostics retain exact chunks when explicitly enabled', async () => {
  const batches: TraceEntry[][] = [];
  const trace = new BrowserTrace(async entries => { batches.push(entries); });
  trace.configure('detailed');
  trace.record('delegation.sent', () => ({ text: 'Exact α chunk', bytes: 14, updateSeq: 8 }));
  await trace.flush();
  expect(batches.flat()[0]?.data).toEqual({ text: 'Exact α chunk', bytes: 14, updateSeq: 8 });
});
it('enforces the frozen diagnostics policy at ingestion, including after call end', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: { get: async () => makeThreadResponse({ id: 'thread', providerId: 'claude', status: 'idle' }) } } });
  await createPlugin(async () => 'answer')(bb);
  try {
    const result = await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'offer' });
    expect(result).toMatchObject({ diagnostics: 'basic' });
    await harness.behavior.setSettings({ diagnostics: 'detailed' });
    await harness.behavior.callRpc('stop', { sessionId });
    await harness.behavior.callRpc('trace', { sessionId, entries: [entry, { ...entry, seq: 2, name: 'native.backing.delta', data: { text: 'private delta' } }] });
    const rows = await harness.behavior.callRpc('traceRead', { sessionId }) as { entry: TraceEntry }[];
    expect(JSON.stringify(rows)).not.toContain('private delta');
    expect(JSON.stringify(rows)).not.toContain('quoted background');
    expect(await harness.behavior.callRpc('traceSessions', {})).toMatchObject([{ diagnostics: 'basic' }]);
    const second = 'a77bc81a-9777-466c-b231-e04784794cf7';
    expect(await harness.behavior.callRpc('start', { sessionId: second, threadId: 'thread', sdp: 'offer' })).toMatchObject({ diagnostics: 'detailed' });
    await harness.behavior.callRpc('trace', { sessionId: second, entries: [entry] });
    expect(JSON.stringify(await harness.behavior.callRpc('traceRead', { sessionId: second }))).toContain('quoted background');
  } finally { await harness.lifecycle.dispose(); }
});
it('reserves capacity for stop and failure evidence after detailed content reaches its limit', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice' });
  try {
    const store = createTraceStore(bb);
    store.start(sessionId, 'thread', 'native', 'detailed');
    for (let seq = 1; seq <= 100; seq++) store.write(sessionId, 'browser', [{ ...entry, seq, data: { text: 'x'.repeat(32000) } }]);
    store.write(sessionId, 'server', [{ ...entry, seq: 101, name: 'session.failed', data: { reason: 'connection' } }, { ...entry, seq: 102, name: 'session.stop', data: {} }]);
    expect(store.read(sessionId, 0).map((row: { entry: TraceEntry }) => row.entry.name)).toEqual(expect.arrayContaining(['session.failed', 'session.stop']));
    expect(store.list()).toMatchObject([{ dropped: expect.any(Number), bytes: expect.any(Number) }]);
    expect((store.list()[0] as { bytes: number }).bytes).toBeLessThanOrEqual(2_000_000);
  } finally { await harness.lifecycle.dispose(); }
});
it('rate-limits storage warnings while continuing later batches', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const trace = new BrowserTrace(async () => { throw new Error('storage offline'); });
  try {
    for (let i = 0; i < 4; i++) { trace.record('client.start'); await trace.flush(); }
    expect(warn).toHaveBeenCalledOnce();
  } finally { warn.mockRestore(); }
});
it('keeps native state observation while filtering diagnostic-only events in basic mode', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: { get: async () => makeThreadResponse({ id: 'thread', providerId: 'codex', status: 'idle' }), events: { list: async () => [] } } } });
  await createPlugin(async () => 'unused', async (_bb, _thread, command) => ({ sdp: command.action === 'start' ? 'answer' : null }))(bb);
  try {
    await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'offer' });
    const calls = harness.inspection.sdk.callsTo('threads.events.list');
    expect(JSON.stringify(calls)).toContain('thread/extensionState/updated');
    expect(JSON.stringify(calls)).not.toContain('item/agentMessage/delta');
  } finally { await harness.lifecycle.dispose(); }
});

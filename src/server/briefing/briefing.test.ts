import { expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { startupReference } from '../prompts';
import { briefingEvidence, briefingRevision, validateBriefing } from './briefing';
import { createBriefingCache } from './briefing-cache';
import { createTraceStore } from '../trace-store';
import { createPlugin } from '../index';
import type { NativeVoiceCommand } from '../native';

type Row = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
const summary = JSON.stringify({ subject: 'Voice', goals: ['Keep continuity'], decisions: [], findings: [{ fact: 'Tool verified the build', evidence: [3] }], openQuestions: [] });
function fixture(providerId = 'claude', cached = false) {
  let status: 'active' | 'idle' = 'idle';
  const rows: Row[] = [];
  const add = (type: string, data: unknown, scope: Row['scope'] = { kind: 'turn', turnId: 'turn' }) => rows.push({ id: `e${rows.length}`, seq: rows.length + 1, threadId: 'thread', createdAt: 0, type, data, scope } as Row);
  add('client/turn/requested', { input: [{ type: 'text', text: 'Keep continuity' }, { type: 'text', text: 'hidden wrapper', visibility: 'agent-only' }] }, { kind: 'thread' });
  add('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'I will check the build' } });
  add('item/completed', { item: { id: 't', type: 'commandExecution', command: 'build', aggregatedOutput: 'Build passed', exitCode: 0 } });
  const host = createFakePluginHost({ pluginId: 'live-voice', settings: { cachedBriefing: cached }, sdk: { threads: {
    get: async () => makeThreadResponse({ id: 'thread', providerId, status }),
    events: { list: async args => {
      let result = rows.filter(row => (!args.types || args.types.includes(row.type)) && row.seq > Number(args.afterSeq ?? 0));
      if (args.order === 'desc') result = result.reverse();
      return result.slice(0, Number(args.limit ?? 100));
    } },
  } } });
  return { ...host, rows, add, active: () => { status = 'active'; }, idle: () => { status = 'idle'; } };
}
it('compiles visible user words and actual tool results, excluding reasoning, nested agents and cleared history', async () => {
  const f = fixture();
  try {
    f.add('item/completed', { item: { type: 'reasoning', text: 'private reasoning' } });
    f.add('item/completed', { item: { type: 'agentMessage', parentToolCallId: 'child', text: 'nested answer' } });
    let evidence = await briefingEvidence(f.bb, 'thread', new AbortController().signal);
    expect(evidence.items.map(item => item.seq)).toEqual([1, 2, 3]);
    expect(evidence.items[0]!.text).toBe('Keep continuity');
    expect(evidence.items[2]!.text).toContain('Build passed');
    expect(() => validateBriefing(JSON.parse(summary), evidence)).not.toThrow();
    expect(() => validateBriefing({ ...JSON.parse(summary), findings: [{ fact: 'Invented', evidence: [999] }] }, evidence)).toThrow('evidence');
    const before = await briefingRevision(f.bb, 'thread');
    f.add('thread/extensionState/updated', {});
    expect((await briefingRevision(f.bb, 'thread')).revision).toBe(before.revision);
    f.add('thread/context/cleared', {}, { kind: 'thread' });
    f.add('client/turn/requested', { input: [{ type: 'text', text: 'Fresh start' }] }, { kind: 'thread' });
    evidence = await briefingEvidence(f.bb, 'thread', new AbortController().signal);
    expect(evidence.items).toMatchObject([{ kind: 'user', text: 'Fresh start' }]);
  } finally { await f.harness.lifecycle.dispose(); }
});
it('bounds source size and marks partial tool evidence', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 120; i++) f.add('item/completed', { item: { id: String(i), type: 'commandExecution', aggregatedOutput: 'x'.repeat(10000) } });
    const source = await briefingEvidence(f.bb, 'thread', new AbortController().signal);
    expect(source.items.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(60000);
    expect(source.items.some(item => item.shortened && item.text.includes('[Middle omitted]'))).toBe(true);
    expect(source.items.every(item => item.text.length <= 6000)).toBe(true);
  } finally { await f.harness.lifecycle.dispose(); }
});
it('returns immediately on cache miss, discards a changed revision and prepares the replacement', async () => {
  const f = fixture();
  const results: ((text: string) => void)[] = [];
  const generate = vi.fn(() => new Promise<string>(resolve => results.push(resolve)));
  const cache = createBriefingCache(f.bb, createTraceStore(f.bb).database, generate);
  try {
    expect(await cache.startup('thread')).toBeNull();
    await vi.waitFor(() => expect(results).toHaveLength(1));
    f.add('item/completed', { item: { id: 'new', type: 'agentMessage', text: 'A newer decision' } });
    results[0]!(summary);
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect((await cache.inspect('thread')).state).toBe('preparing');
    results[1]!(summary);
    await vi.waitFor(async () => expect((await cache.inspect('thread')).state).toBe('ready'));
    expect(await cache.startup('thread')).toBe(startupReference(summary));
    f.active(); cache.invalidate('thread');
    expect(await cache.startup('thread')).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  } finally { await cache.dispose(); await f.harness.lifecycle.dispose(); }
});
it('falls back after compiler failure and removes cached history when forgotten', async () => {
  const f = fixture();
  const cache = createBriefingCache(f.bb, createTraceStore(f.bb).database, async () => { throw new Error('subscription unavailable'); });
  try {
    await cache.request('thread');
    await vi.waitFor(async () => expect((await cache.inspect('thread')).state).toBe('error'));
    expect(await cache.startup('thread')).toBeNull();
    cache.forget('thread');
    expect(cache.watched('thread')).toBe(false);
    expect((await cache.inspect('thread')).text).toBeNull();
  } finally { await cache.dispose(); await f.harness.lifecycle.dispose(); }
});
for (const providerId of ['codex', 'claude']) it(`${providerId} supplies a briefing only at startup and keeps a missed call retrieval-only after preparation finishes`, async () => {
  const f = fixture(providerId, true);
  const commands: NativeVoiceCommand[] = [];
  const connect = vi.fn(async () => 'answer');
  let resolve!: (text: string) => void;
  const synthesize = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  await createPlugin(connect, async (_bb, _thread, command) => { commands.push(command); return { sdp: command.action === 'start' ? 'answer' : null }; }, synthesize)(f.bb);
  const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
  try {
    expect(await f.harness.behavior.callRpc('start', { threadId: 'thread', sessionId, sdp: 'offer' })).toMatchObject({ briefing: 'lookup' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    resolve(summary);
    await vi.waitFor(async () => expect(await f.harness.behavior.callRpc('briefingStatus', { threadId: 'thread' })).toMatchObject({ state: 'ready' }));
    expect(await f.harness.behavior.callRpc('context', { sessionId })).toEqual({ text: null });
    expect(await f.harness.behavior.callRpc('poll', { sessionId })).toMatchObject({ backgroundContext: null });
    await f.harness.behavior.callRpc('stop', { sessionId });
    expect(await f.harness.behavior.callRpc('start', { threadId: 'thread', sessionId, sdp: 'offer' })).toMatchObject({ briefing: 'ready' });
    if (providerId === 'codex') {
      expect(commands.filter(command => command.action === 'start')).toMatchObject([{ experimental_startupBriefing: null }, { experimental_startupBriefing: startupReference(summary) }]);
      expect(connect).not.toHaveBeenCalled();
    } else expect(connect.mock.calls).toEqual([['offer', null, undefined], ['offer', startupReference(summary), undefined]]);
    expect(f.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  } finally { await f.harness.lifecycle.dispose(); }
});
it('switching off aborts preparation and prevents idle events from starting new jobs', async () => {
  const f = fixture('claude', true);
  let signal: AbortSignal | undefined;
  const synthesize = vi.fn((_source, _command, abort: AbortSignal) => new Promise<string>((_resolve, reject) => { signal = abort; abort.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
  await createPlugin(async () => 'answer', undefined, synthesize)(f.bb);
  try {
    await f.harness.behavior.callRpc('prepareBriefing', { threadId: 'thread' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await f.harness.behavior.setSettings({ cachedBriefing: false });
    expect(signal!.aborted).toBe(true);
    await f.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thread', status: 'idle' }), lastAssistantText: null });
    expect(synthesize).toHaveBeenCalledOnce();
  } finally { await f.harness.lifecycle.dispose(); }
});

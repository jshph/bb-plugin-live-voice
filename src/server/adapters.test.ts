import { expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createPlugin } from './index';
import { nativeVoice, type NativeVoiceCommand } from './native';

type Row = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
const start = { sessionId, threadId: 'thread', sdp: 'offer' };

it('keeps native Codex delegation on the existing provider connection and ends only voice', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: { get: async () => makeThreadResponse({ id: 'thread', providerId: 'codex' }), events: { list: async () => [] } } } });
  const detached = vi.fn(async () => 'unused');
  const commands: NativeVoiceCommand[] = [];
  await createPlugin(detached, async (_bb, _threadId, command) => { commands.push(command); return { sdp: command.action === 'start' ? 'native-answer' : null }; })(bb);
  try {
    expect(await harness.behavior.callRpc('start', start)).toEqual({ sdp: 'native-answer', adapter: 'native', diagnostics: 'basic' });
    await harness.behavior.callRpc('poll', { sessionId });
    await expect(harness.behavior.callRpc('delegate', { sessionId, id: 'duplicate', text: 'Read a file', turns: [] })).rejects.toThrow('must not execute them twice');
    await harness.behavior.callRpc('stop', { sessionId });
    expect(commands.map(command => command.action)).toEqual(['start', 'keepAlive', 'stop']);
    expect(detached).not.toHaveBeenCalled();
    expect(harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo('threads.stop')).toHaveLength(0);
  } finally { await harness.lifecycle.dispose(); }
});

it('fails clearly when stock BB lacks the native transport instead of spawning another writer', async () => {
  const bb = { sdk: { threads: {} } } as unknown as BbPluginApi;
  await expect(nativeVoice(bb, 'thread', { action: 'keepAlive', sessionId })).rejects.toThrow('native voice transport bridge');
});

it('streams Claude output before completion and steers only the voice-owned turn', async () => {
  let rows: Row[] = [];
  let active = false;
  const requests: Parameters<BbPluginApi['sdk']['threads']['send']>[0][] = [];
  const add = (type: string, data: unknown) => { rows.push({ id: `evt${rows.length}`, seq: rows.length + 1, createdAt: 0, threadId: 'thread', scope: { kind: 'turn', turnId: 'owned' }, type, data } as Row); };
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: {
    get: async () => makeThreadResponse({ id: 'thread', providerId: 'claude-code', status: active ? 'active' : 'idle' }),
    events: { list: async args => { const result = rows.filter(row => row.seq > Number(args.afterSeq ?? 0)); return (args.order === 'desc' ? result.reverse() : result).slice(0, Number(args.limit ?? 100)); } },
    interactions: { list: async () => [] },
    send: async args => { requests.push(args); active = true; const requestId = `req${requests.length}`; add('client/turn/requested', { requestId, input: args.input }); add('turn/input/accepted', { clientRequestId: requestId }); return { ok: true, delivery: 'sent' }; },
  } } });
  const event = () => harness.behavior.emitThreadEvent('experimental_thread.events', { thread: makeThreadResponse({ id: 'thread', providerId: 'claude-code' }), sequence: rows.length });
  await createPlugin(async () => 'answer')(bb);
  try {
    await harness.behavior.callRpc('start', start);
    await harness.behavior.callRpc('delegate', { sessionId, id: 'first', text: 'Look up notes', turns: [] });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    add('item/agentMessage/delta', { itemId: 'a', delta: 'I found one relevant note.' }); await event();
    await vi.waitFor(async () => expect(await harness.behavior.callRpc('poll', { sessionId })).toMatchObject({ state: 'working', updates: [expect.objectContaining({ text: 'I found one relevant note.', final: false })] }));
    await harness.behavior.callRpc('delegate', { sessionId, id: 'correction', text: 'Focus on hospitality', turns: [] });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.mode).toBe('steer');
    await new Promise(resolve => setTimeout(resolve, 20));
    add('item/agentMessage/delta', { itemId: 'b', delta: 'Hospitality is the key theme.' });
    add('item/completed', { item: { id: 'b', type: 'agentMessage', text: 'Hospitality is the key theme.' } });
    add('turn/completed', { status: 'completed' }); await event();
    await vi.waitFor(async () => expect(await harness.behavior.callRpc('poll', { sessionId })).toMatchObject({ state: 'ready', updates: expect.arrayContaining([expect.objectContaining({ id: 'correction', text: 'Hospitality is the key theme.' }), expect.objectContaining({ id: 'correction', final: true })]) }));
    const all = await harness.behavior.callRpc('poll', { sessionId });
    const updates = (all as { updates: { seq: number }[] }).updates;
    expect(await harness.behavior.callRpc('poll', { sessionId, afterSeq: updates.at(-1)!.seq })).toMatchObject({ updates: [] });
  } finally { await harness.lifecycle.dispose(); }
});

it('distinguishes ending a Claude call from explicitly cancelling its work', async () => {
  const rows: Row[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: {
    get: async () => makeThreadResponse({ id: 'thread', providerId: 'claude-code', status: 'idle' }),
    events: { list: async args => rows.filter(row => row.seq > Number(args.afterSeq ?? 0)) },
    interactions: { list: async () => [] },
    send: async args => {
      rows.push({ id: 'request', seq: 1, createdAt: 0, threadId: 'thread', scope: { kind: 'thread' }, type: 'client/turn/requested', data: { requestId: 'request', input: args.input } } as Row);
      rows.push({ id: 'accepted', seq: 2, createdAt: 0, threadId: 'thread', scope: { kind: 'turn', turnId: 'owned' }, type: 'turn/input/accepted', data: { clientRequestId: 'request' } } as Row);
      return { ok: true, delivery: 'sent' };
    },
    stop: async () => ({ ok: true }),
  } } });
  await createPlugin(async () => 'answer')(bb);
  try {
    await harness.behavior.callRpc('start', start);
    await harness.behavior.callRpc('delegate', { sessionId, id: 'work', text: 'Read the note', turns: [] });
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
    expect(await harness.behavior.callRpc('control', { sessionId, action: 'cancelWork' })).toMatchObject({ requested: true });
    expect(harness.inspection.sdk.callsTo('threads.stop')).toHaveLength(1);
    await harness.behavior.callRpc('stop', { sessionId });
    expect(harness.inspection.sdk.callsTo('threads.stop')).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

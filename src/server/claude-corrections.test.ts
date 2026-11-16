import { expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createPlugin } from './index';

type Row = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
type Send = Parameters<BbPluginApi['sdk']['threads']['send']>[0];
const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';

// A Claude backing thread whose acceptance of each request is controlled by the test.
async function setup(options: { acceptanceTimeoutMs?: number; status?: 'idle' | 'active' } = {}) {
  const rows: Row[] = [];
  const requests: Send[] = [];
  let status: 'idle' | 'active' = options.status ?? 'idle';
  const add = (type: string, data: unknown, turnId: string | null = 'owned') => { rows.push({ id: `evt${rows.length}`, seq: rows.length + 1, createdAt: 0, threadId: 'thread', scope: turnId ? { kind: 'turn', turnId } : { kind: 'thread' }, type, data } as Row); };
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: {
    get: async () => makeThreadResponse({ id: 'thread', providerId: 'claude', status }),
    events: { list: async args => { const result = rows.filter(row => row.seq > Number(args.afterSeq ?? 0)); return (args.order === 'desc' ? result.reverse() : result).slice(0, Number(args.limit ?? 100)); } },
    interactions: { list: async () => [] },
    send: async args => { requests.push(args); status = 'active'; add('client/turn/requested', { requestId: `req${requests.length}`, input: args.input }, null); return { ok: true, delivery: 'sent' }; },
    stop: async () => ({ ok: true }),
  } } });
  await createPlugin(async () => 'answer', undefined, undefined, options)(bb);
  await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'offer' });
  const event = () => harness.behavior.emitThreadEvent('experimental_thread.events', { thread: makeThreadResponse({ id: 'thread', providerId: 'claude' }), sequence: rows.length });
  const poll = async () => (await harness.behavior.callRpc('poll', { sessionId })) as { updates: { id: string; text: string; final: boolean }[] };
  const delegate = (id: string, text: string) => harness.behavior.callRpc('delegate', { sessionId, id, text, turns: [] });
  return { harness, rows, requests, add, event, poll, delegate, setStatus: (next: 'idle' | 'active') => { status = next; } };
}

it('holds a correction until the previous voice request is accepted, then steers that turn', async () => {
  const t = await setup();
  try {
    await t.delegate('first', 'Look up notes');
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await t.delegate('correction', 'Only hospitality notes');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(t.requests).toHaveLength(1);
    expect((await t.poll()).updates).toEqual([]);
    t.add('turn/input/accepted', { clientRequestId: 'req1' }); await t.event();
    await vi.waitFor(() => expect(t.requests).toHaveLength(2));
    expect(t.requests[1]?.mode).toBe('steer');
    expect(JSON.stringify(t.requests[1]?.input)).toContain('Only hospitality notes');
    t.add('turn/input/accepted', { clientRequestId: 'req2' });
    t.add('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Hospitality is the theme.' } });
    t.add('turn/completed', { status: 'completed' }); await t.event();
    await vi.waitFor(async () => expect((await t.poll()).updates).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'correction', text: 'Hospitality is the theme.' }), expect.objectContaining({ id: 'correction', final: true })])));
    expect((await t.poll()).updates.some(update => update.id === 'first')).toBe(false);
    expect(t.harness.inspection.sdk.callsTo('threads.stop')).toHaveLength(0);
  } finally { await t.harness.lifecycle.dispose(); }
});

it('starts the correction when the previous request is rejected', async () => {
  const t = await setup();
  try {
    await t.delegate('first', 'Look up notes');
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await t.delegate('correction', 'Only hospitality notes');
    t.setStatus('idle');
    t.add('client/turn/rejected', { requestId: 'req1', message: 'Busy' }, null); await t.event();
    await vi.waitFor(() => expect(t.requests).toHaveLength(2));
    expect(t.requests[1]?.mode).toBe('start');
  } finally { await t.harness.lifecycle.dispose(); }
});

it('fails a correction clearly when acceptance never arrives, leaving existing work running', async () => {
  const t = await setup({ acceptanceTimeoutMs: 40 });
  try {
    await t.delegate('first', 'Look up notes');
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await t.delegate('correction', 'Only hospitality notes');
    await vi.waitFor(async () => expect((await t.poll()).updates).toEqual([expect.objectContaining({ id: 'correction', final: true, text: expect.stringContaining('did not confirm the previous voice request') })]));
    expect(t.requests).toHaveLength(1);
    expect(t.harness.inspection.sdk.callsTo('threads.stop')).toHaveLength(0);
    t.add('turn/input/accepted', { clientRequestId: 'req1' });
    t.add('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Late answer for the first request.' } });
    t.add('turn/completed', { status: 'completed' }); await t.event();
    await vi.waitFor(async () => expect((await t.poll()).updates).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'first', text: 'Late answer for the first request.' })])));
  } finally { await t.harness.lifecycle.dispose(); }
});

it('drops a waiting correction without sending or cancelling work when the call ends', async () => {
  const t = await setup();
  try {
    await t.delegate('first', 'Look up notes');
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await t.delegate('correction', 'Only hospitality notes');
    await t.harness.behavior.callRpc('stop', { sessionId });
    t.add('turn/input/accepted', { clientRequestId: 'req1' }); await t.event();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(t.requests).toHaveLength(1);
    expect(t.harness.inspection.sdk.callsTo('threads.stop')).toHaveLength(0);
  } finally { await t.harness.lifecycle.dispose(); }
});

it('does not steer unrelated work that starts after the voice turn completes', async () => {
  const t = await setup();
  try {
    await t.delegate('first', 'Look up notes');
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    t.add('turn/input/accepted', { clientRequestId: 'req1' });
    t.add('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Done.' } });
    t.add('turn/completed', { status: 'completed' }); await t.event();
    await vi.waitFor(async () => expect((await t.poll()).updates).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'first', final: true })])));
    t.setStatus('active');
    await t.delegate('follow-up', 'And the other notes');
    await vi.waitFor(async () => expect((await t.poll()).updates).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'follow-up', text: expect.stringContaining('already working') })])));
    expect(t.requests).toHaveLength(1);
  } finally { await t.harness.lifecycle.dispose(); }
});

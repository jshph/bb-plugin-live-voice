import { describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './index';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { backendInstructions } from './delegation';

const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
const input = { sessionId, threadId: 'th_test', sdp: 'offer' };

function host(status: 'idle' | 'active' = 'idle') {
  return createFakePluginHost({
    pluginId: 'live-voice',
    sdk: { threads: {
      get: async () => makeThreadResponse({ id: 'th_test', providerId: 'claude', status }),
      output: async () => ({ output: 'Verified final answer with tool evidence.' }),
      events: { list: async () => [] },
      send: async () => ({ ok: true, delivery: 'sent' }),
      interactions: { list: async () => [] },
    } },
  });
}

describe('voice sessions', () => {
  it('rejects concurrent calls and releases the thread after stop', async () => {
    const { bb, harness } = host();
    const connect = vi.fn(async () => 'answer');
    await createPlugin(connect)(bb);
    try {
      expect(await harness.behavior.callRpc('start', input)).toEqual({ sdp: 'answer', adapter: 'delegated', diagnostics: 'basic' });
      await expect(harness.behavior.callRpc('start', { ...input, sessionId: 'a77bc81a-9777-466c-b231-e04784794cf7' })).rejects.toThrow('already');
      await harness.behavior.callRpc('stop', { sessionId });
      await harness.behavior.callRpc('start', input);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally { await harness.lifecycle.dispose(); }
  });
  it('cleans up a failed transport without retaining a session', async () => {
    const { bb, harness } = host();
    await createPlugin(async () => { throw new Error('subscription unavailable'); })(bb);
    try {
      await expect(harness.behavior.callRpc('start', input)).rejects.toThrow('subscription unavailable');
      await expect(harness.behavior.callRpc('poll', { sessionId })).rejects.toThrow('ended');
    } finally { await harness.lifecycle.dispose(); }
  });
  it('does not return a call that ended while authentication was pending', async () => {
    const { bb, harness } = host();
    let finish!: (answer: string) => void;
    await createPlugin(() => new Promise(resolve => { finish = resolve; }))(bb);
    try {
      const start = harness.behavior.callRpc('start', input);
      const assertion = expect(start).rejects.toThrow('ended while connecting');
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await harness.behavior.callRpc('stop', { sessionId });
      finish('answer');
      await assertion;
    } finally { await harness.lifecycle.dispose(); }
  });
  it('refuses to send or steer into an active backing thread', async () => {
    const { bb, harness } = host('active');
    await createPlugin(async () => 'answer')(bb);
    try {
      await harness.behavior.callRpc('start', input);
      await harness.behavior.callRpc('delegate', { sessionId, id: 'delegation', text: 'Check evidence', turns: [] });
      await vi.waitFor(async () => {
        const result = await harness.behavior.callRpc('poll', { sessionId });
        expect(result).toMatchObject({ updates: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('already working') })]) });
      });
      expect(harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
    } finally { await harness.lifecycle.dispose(); }
  });
  it('deduplicates requests and cancels polling when the call ends', async () => {
    const { bb, harness } = host();
    await createPlugin(async () => 'answer')(bb);
    try {
      await harness.behavior.callRpc('start', input);
      const request = { sessionId, id: 'delegation', text: 'Check evidence', turns: [{ seq: 1, role: 'user', text: 'check evidence', complete: true }] };
      await harness.behavior.callRpc('delegate', request);
      await harness.behavior.callRpc('delegate', request);
      await vi.waitFor(() => expect(harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
      await harness.behavior.callRpc('stop', { sessionId });
      await expect(harness.behavior.callRpc('poll', { sessionId })).rejects.toThrow('ended');
    } finally { await harness.lifecycle.dispose(); }
  });
});

it('returns the final answer belonging to the accepted voice request', async () => {
  type Row = Awaited<ReturnType<ReturnType<typeof createFakePluginHost>['bb']['sdk']['threads']['events']['list']>>[number];
  let rows: Row[] = [];
  const requests: Parameters<BbPluginApi['sdk']['threads']['send']>[0][] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: 'live-voice',
    sdk: { threads: {
      get: async () => makeThreadResponse({ id: 'th_test', providerId: 'claude', status: 'idle' }),
      events: { list: async args => { const selected = rows.filter(row => row.seq > Number(args.afterSeq ?? 0)); return (args.order === 'desc' ? selected.reverse() : selected).slice(0, Number(args.limit ?? 100)); } },
      interactions: { list: async () => [] },
      send: async args => {
        requests.push(args);
        const requestId = `req${requests.length}`;
        const base = rows.at(-1)?.seq ?? 0;
        const data = [
          { type: 'client/turn/requested', data: { requestId, input: args.input } },
          { type: 'turn/input/accepted', data: { clientRequestId: requestId } },
          { type: 'item/completed', data: { item: { id: 'answer', type: 'agentMessage', text: 'Slate Nine is approved; Juniper Four remains pending.' } } },
          { type: 'turn/completed', data: { status: 'completed' } },
        ];
        rows.push(...data.map((row, index) => ({ ...row, id: `evt_${base + index}`, seq: base + index + 1, threadId: 'th_test', createdAt: 0, scope: { kind: 'turn', turnId: requestId } })) as Row[]);
        return { ok: true, delivery: 'sent' };
      },
    } },
  });
  await createPlugin(async () => 'answer')(bb);
  try {
    await harness.behavior.callRpc('start', input);
    await harness.behavior.callRpc('delegate', { sessionId, id: 'delegation', text: 'Find the approved name', turns: [{ seq: 1, role: 'user', text: 'What name was approved?', complete: true }] });
    await vi.waitFor(async () => expect(await harness.behavior.callRpc('poll', { sessionId })).toMatchObject({ updates: expect.arrayContaining([expect.objectContaining({ id: 'delegation', text: 'Slate Nine is approved; Juniper Four remains pending.' })]), state: 'ready' }));
    await harness.behavior.callRpc('delegate', { sessionId, id: 'followup', text: 'Find conflicting evidence', turns: [{ seq: 1, role: 'user', text: 'What name was approved?', complete: true }, { seq: 2, role: 'user', text: 'Any conflicts?', complete: true }] });
    await vi.waitFor(async () => expect(await harness.behavior.callRpc('poll', { sessionId })).toMatchObject({ updates: expect.arrayContaining([expect.objectContaining({ id: 'followup', text: 'Slate Nine is approved; Juniper Four remains pending.' })]), state: 'ready' }));
    expect(requests[0]?.input[0]).toMatchObject({ text: 'What name was approved?' });
    expect(requests[0]?.input[1]).toMatchObject({ visibility: 'agent-only', text: expect.stringContaining(backendInstructions) });
    expect(requests[1]?.input[0]).toMatchObject({ text: 'Any conflicts?' });
    const second = JSON.stringify(requests[1]?.input);
    expect(second).not.toContain('What name was approved?');
    expect(second).not.toContain('For this live voice session');
    expect(second).toContain('Find conflicting evidence');

  } finally { await harness.lifecycle.dispose(); }
});

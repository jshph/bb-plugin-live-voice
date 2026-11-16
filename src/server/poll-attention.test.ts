import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { attentionFreshnessMs, createPlugin } from './index';

const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
afterEach(() => { vi.restoreAllMocks(); });

// A Claude call with voice work in progress, so poll reports working or attention.
async function working() {
  const now = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
  let pending: unknown[] = [];
  let lookups = 0;
  let resolveLookup: (() => void) | null = null;
  let holdLookups = false;
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: {
    get: async () => makeThreadResponse({ id: 'thread', providerId: 'claude', status: 'idle' }),
    events: { list: async () => [] },
    send: async () => ({ ok: true, delivery: 'sent' }),
    interactions: { list: async () => { lookups++; if (holdLookups) await new Promise<void>(resolve => { resolveLookup = resolve; }); return pending as never; } },
  } } });
  await createPlugin(async () => 'answer')(bb);
  await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'offer' });
  await harness.behavior.callRpc('delegate', { sessionId, id: 'work', text: 'Run the tests', turns: [] });
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  const poll = async () => ((await harness.behavior.callRpc('poll', { sessionId })) as { state: string }).state;
  return { harness, poll, lookups: () => lookups, advance: (ms: number) => { offset += ms; }, setPending: (next: unknown[]) => { pending = next; }, hold: () => { holdLookups = true; }, release: () => { holdLookups = false; resolveLookup?.(); } };
}

it('coalesces concurrent attention checks and reuses a result within the freshness bound', async () => {
  const t = await working();
  try {
    t.hold();
    const concurrent = [t.poll(), t.poll(), t.poll()];
    await vi.waitFor(() => expect(t.lookups()).toBe(1));
    t.release();
    expect(await Promise.all(concurrent)).toEqual(['working', 'working', 'working']);
    t.setPending([{ id: 'approval' }]);
    expect(await t.poll()).toBe('working');
    expect(t.lookups()).toBe(1);
    t.advance(attentionFreshnessMs);
    expect(await t.poll()).toBe('attention');
    expect(t.lookups()).toBe(2);
    t.setPending([]);
    t.advance(attentionFreshnessMs);
    expect(await t.poll()).toBe('working');
  } finally { await t.harness.lifecycle.dispose(); }
});

it('reports a new pending interaction immediately, inside the freshness bound', async () => {
  const t = await working();
  try {
    expect(await t.poll()).toBe('working');
    await t.harness.behavior.emitThreadEvent('interaction.pending', { thread: makeThreadResponse({ id: 'thread', providerId: 'claude' }), interaction: {} as never });
    expect(await t.poll()).toBe('attention');
    expect(t.lookups()).toBe(1);
  } finally { await t.harness.lifecycle.dispose(); }
});

import { expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './index';

const ids = ['a77bc81a-9777-466c-b231-e04784794c01', 'a77bc81a-9777-466c-b231-e04784794c02', 'a77bc81a-9777-466c-b231-e04784794c03', 'a77bc81a-9777-466c-b231-e04784794c04', 'a77bc81a-9777-466c-b231-e04784794c05'];

// Thread lookups stay pending until the test releases them, holding each start before its first await returns.
function host() {
  const pending: (() => void)[] = [];
  let hold = true, failNext = false;
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', sdk: { threads: {
    get: async ({ threadId }) => {
      if (hold) await new Promise<void>(resolve => pending.push(resolve));
      if (failNext) { failNext = false; throw new Error('Thread lookup failed'); }
      return makeThreadResponse({ id: threadId, providerId: 'claude', status: 'idle' });
    },
    events: { list: async () => [] },
    interactions: { list: async () => [] },
  } } });
  const release = () => { hold = false; for (const resolve of pending.splice(0)) resolve(); };
  return { bb, harness, pending, release, failNextLookup: () => { failNext = true; } };
}
const start = (harness: ReturnType<typeof host>['harness'], sessionId: string, threadId = 'thread') => harness.behavior.callRpc('start', { sessionId, threadId, sdp: 'offer' });

it('reserves the thread before the first await, so simultaneous starts open one call', async () => {
  const { bb, harness, pending, release } = host();
  await createPlugin(async () => 'answer')(bb);
  try {
    const first = start(harness, ids[0]!);
    await expect(start(harness, ids[1]!)).rejects.toThrow('already has a Tandem call');
    expect(pending).toHaveLength(1);
    release();
    await expect(first).resolves.toMatchObject({ sdp: 'answer' });
    expect(await harness.behavior.callRpc('traceSessions', {})).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

it('counts pending starts against the four-call limit', async () => {
  const { bb, harness, release } = host();
  await createPlugin(async () => 'answer')(bb);
  try {
    const starts = ids.slice(0, 4).map((id, index) => start(harness, id, `thread-${index}`));
    await expect(start(harness, ids[4]!, 'thread-4')).rejects.toThrow('Four Tandem calls');
    release();
    await Promise.all(starts);
  } finally { await harness.lifecycle.dispose(); }
});

it('releases the reservation when a start fails, so a retry can open the call', async () => {
  const { bb, harness, release, failNextLookup } = host();
  let failTransport = true;
  await createPlugin(async () => { if (failTransport) { failTransport = false; throw new Error('Codex app-server disconnected'); } return 'answer'; })(bb);
  try {
    release();
    failNextLookup();
    await expect(start(harness, ids[0]!)).rejects.toThrow('Thread lookup failed');
    await expect(start(harness, ids[0]!)).rejects.toThrow('disconnected');
    await expect(start(harness, ids[0]!)).resolves.toMatchObject({ sdp: 'answer' });
  } finally { await harness.lifecycle.dispose(); }
});

it('cancels a pending start on stop without blocking a newer call on the same thread', async () => {
  const { bb, harness, release } = host();
  await createPlugin(async () => 'answer')(bb);
  try {
    const cancelled = start(harness, ids[0]!);
    const assertion = expect(cancelled).rejects.toThrow('ended while connecting');
    expect(await harness.behavior.callRpc('stop', { sessionId: ids[0]! })).toEqual({ stopped: true });
    const newer = start(harness, ids[1]!);
    release();
    await assertion;
    await expect(newer).resolves.toMatchObject({ sdp: 'answer' });
    await expect(harness.behavior.callRpc('poll', { sessionId: ids[1]! })).resolves.toMatchObject({ ended: null });
  } finally { await harness.lifecycle.dispose(); }
});

it('does not let an older failed start end a newer call that reused its session ID', async () => {
  const { bb, harness, release } = host();
  release();
  let finishOld!: (sdp: string) => void;
  let calls = 0;
  await createPlugin(() => ++calls === 1 ? new Promise<string>(resolve => { finishOld = resolve; }) : Promise.resolve('answer'))(bb);
  try {
    const old = start(harness, ids[0]!);
    const assertion = expect(old).rejects.toThrow('ended while connecting');
    await expect.poll(() => typeof finishOld).toBe('function');
    await harness.behavior.callRpc('stop', { sessionId: ids[0]! });
    await expect(start(harness, ids[0]!)).resolves.toMatchObject({ sdp: 'answer' });
    finishOld('late answer');
    await assertion;
    await expect(harness.behavior.callRpc('poll', { sessionId: ids[0]! })).resolves.toMatchObject({ ended: null });
  } finally { await harness.lifecycle.dispose(); }
});

it('cancels pending starts when the plugin is disposed', async () => {
  const { bb, harness, pending: lookups, release } = host();
  await createPlugin(async () => 'answer')(bb);
  const pending = start(harness, ids[0]!);
  const assertion = expect(pending).rejects.toThrow('ended while connecting');
  await expect.poll(() => lookups.length).toBe(1);
  await harness.lifecycle.dispose();
  release();
  await assertion;
});

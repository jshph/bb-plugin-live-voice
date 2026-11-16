import { expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './index';
import type { NativeVoiceCommand } from './native';

const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
const replacementId = 'a77bc81a-9777-466c-b231-e04784794cf7';

function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; }

// Models the native bridge: one session per thread, and stop applies only to a matching session ID.
async function setup(options: { holdFirstEventsList?: boolean; holdFirstStart?: boolean; cachedBriefing?: boolean } = {}) {
  const list = gate(), start = gate();
  let lists = 0, starts = 0;
  let bridge: string | null = null;
  const log: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', settings: { cachedBriefing: options.cachedBriefing ?? false }, sdk: { threads: {
    get: async () => makeThreadResponse({ id: 'thread', providerId: 'codex', status: 'idle' }),
    events: { list: async () => { if (++lists === 1 && options.holdFirstEventsList) await list.wait; return []; } },
  } } });
  await createPlugin(async () => 'unused', async (_bb, _thread, command: NativeVoiceCommand) => {
    if (command.action === 'start') {
      if (++starts === 1 && options.holdFirstStart) await start.wait;
      if (bridge) { log.push(`start:rejected:${command.sessionId}`); throw new Error('A voice chat is already open in this thread.'); }
      bridge = command.sessionId; log.push(`start:${command.sessionId}`); return { sdp: 'answer' };
    }
    if (command.action === 'stop') { log.push(bridge === command.sessionId ? `stop:${command.sessionId}` : 'stop:noop'); if (bridge === command.sessionId) bridge = null; }
    return { sdp: null };
  })(bb);
  const call = (id: string) => harness.behavior.callRpc('start', { sessionId: id, threadId: 'thread', sdp: 'offer' });
  return { harness, log, call, bridge: () => bridge, lists: () => lists, starts: () => starts, releaseList: list.open, releaseStart: start.open };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(check()).toBe(true); };

for (const cachedBriefing of [false, true]) it(`does not send a native start after stop during startup lookups (cachedBriefing=${cachedBriefing})`, async () => {
  const t = await setup({ holdFirstEventsList: true, cachedBriefing });
  try {
    const started = t.call(sessionId).catch(error => String(error));
    await until(() => t.lists() === 1);
    expect(await t.harness.behavior.callRpc('stop', { sessionId })).toEqual({ stopped: true });
    t.releaseList();
    expect(await started).toContain('ended while connecting');
    expect(t.starts()).toBe(0);
    expect(t.bridge()).toBeNull();
  } finally { await t.harness.lifecycle.dispose(); }
});

it('stops a native session whose start reached the bridge after the stop', async () => {
  const t = await setup({ holdFirstStart: true });
  try {
    const started = t.call(sessionId).catch(error => String(error));
    await until(() => t.starts() === 1);
    expect(await t.harness.behavior.callRpc('stop', { sessionId })).toEqual({ stopped: true });
    t.releaseStart();
    expect(await started).toContain('ended while connecting');
    expect(t.log).toEqual(['stop:noop', `start:${sessionId}`, `stop:${sessionId}`]);
    expect(t.bridge()).toBeNull();
    await expect(t.call(replacementId)).resolves.toMatchObject({ sdp: 'answer' });
  } finally { await t.harness.lifecycle.dispose(); }
});

it('leaves a newer call that reuses the session ID connected when the old start finishes late', async () => {
  const t = await setup({ holdFirstStart: true });
  try {
    const old = t.call(sessionId).catch(error => String(error));
    await until(() => t.starts() === 1);
    await t.harness.behavior.callRpc('stop', { sessionId });
    await expect(t.call(sessionId)).resolves.toMatchObject({ sdp: 'answer' });
    t.releaseStart();
    expect(await old).toContain('already open');
    expect(t.bridge()).toBe(sessionId);
    expect(t.log).toEqual(['stop:noop', `start:${sessionId}`, `start:rejected:${sessionId}`]);
    await expect(t.harness.behavior.callRpc('poll', { sessionId })).resolves.toMatchObject({ ended: null });
  } finally { await t.harness.lifecycle.dispose(); }
});

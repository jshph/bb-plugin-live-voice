import { expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createPlugin } from '../index';

for (const providerId of ['codex', 'claude']) for (const mode of [false, true]) {
  it(`${providerId} freezes cachedBriefing=${mode} policy for the call and applies it to both context delivery paths`, async () => {
    type Row = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
    let rows: Row[] = [];
    const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
    const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', settings: { cachedBriefing: mode }, sdk: { threads: {
      get: async () => makeThreadResponse({ id: 'thread', title: 'Voice test', providerId, status: 'idle' }),
      events: { list: async args => rows.filter(row => row.seq > Number(args.afterSeq ?? 0)) },
      output: async () => ({ output: 'Verified compact result.' }),
    } } });
    await createPlugin(async () => 'answer', async (_bb, _thread, command) => {
      if (command.action === 'start') rows = [{ id: 'voice', seq: 1, createdAt: Date.now(), threadId: 'thread', scope: { kind: 'thread' }, type: 'thread/extensionState/updated', data: { providerThreadId: 'native-thread', kind: 'provider-codex/voice', payload: { sessionId, status: 'active', message: null, backgroundContext: 'RAW HISTORICAL TOOL CONTEXT' } } } as Row];
      return { sdp: command.action === 'start' ? 'answer' : null };
    })(bb);
    try {
      await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'offer' });
      await harness.behavior.setSettings({ cachedBriefing: !mode });
      if (providerId === 'codex') await new Promise(resolve => setTimeout(resolve, 10));
      const context = await harness.behavior.callRpc('context', { sessionId }) as { text: string | null };
      const poll = await harness.behavior.callRpc('poll', { sessionId }) as { backgroundContext: string | null };
      expect(context.text).toBeNull(); expect(poll.backgroundContext).toBeNull();
      expect(harness.inspection.sdk.callsTo('threads.output')).toHaveLength(0);
      const trace = await harness.behavior.callRpc('traceRead', { sessionId });
      expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ entry: expect.objectContaining({ name: 'context.policy', data: { state: mode ? 'cached' : 'off' } }) })]));
    } finally { await harness.lifecycle.dispose(); }
  });
}

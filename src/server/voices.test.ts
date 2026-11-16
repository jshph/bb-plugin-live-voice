import { expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './index';
import { selectedVoice } from '../shared/voices';

it('keeps default absent and rejects voices from other protocols', () => {
  expect(selectedVoice(undefined)).toBeUndefined();
  expect(selectedVoice('default')).toBeUndefined();
  for (const value of ['marin', 'cedar', 'unknown', '']) expect(() => selectedVoice(value)).toThrow();
});
for (const providerId of ['codex', 'claude']) for (const choice of ['default', 'juniper', 'cove']) {
  it(`${providerId} starts with ${choice} and only applies changes to the next call`, async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', settings: { voice: choice }, sdk: { threads: {
      get: async () => makeThreadResponse({ id: 'thread', providerId, status: 'idle' }),
      events: { list: async () => [] },
    } } });
    const detached = vi.fn(async () => 'answer');
    const native = vi.fn(async () => ({ sdp: 'answer' }));
    await createPlugin(detached, native)(bb);
    const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';
    const start = { sessionId, threadId: 'thread', sdp: 'offer' };
    try {
      await harness.behavior.callRpc('start', start);
      await harness.behavior.setSettings({ voice: 'spruce' });
      if (providerId === 'codex') {
        expect(detached).not.toHaveBeenCalled();
        expect(native.mock.calls[0]).toEqual([bb, 'thread', { action: 'start', sessionId, sdp: 'offer', ...(choice === 'default' ? {} : { experimental_voice: choice }) }]);
        expect(native).toHaveBeenCalledTimes(1);
      } else {
        expect(native).not.toHaveBeenCalled();
        expect(detached.mock.calls).toEqual([['offer', undefined, choice === 'default' ? undefined : choice]]);
      }
      await harness.behavior.callRpc('stop', { sessionId });
      await harness.behavior.callRpc('start', start);
      if (providerId === 'codex') expect(native).toHaveBeenLastCalledWith(bb, 'thread', expect.objectContaining({ action: 'start', experimental_voice: 'spruce' }));
      else expect(detached).toHaveBeenLastCalledWith('offer', undefined, 'spruce');
    } finally { await harness.lifecycle.dispose(); }
  });
}

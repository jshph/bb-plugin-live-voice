import { expect, it, vi } from 'vitest';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { nativeVoice } from './native';
const sessionId = '11111111-1111-4111-8111-111111111111';
for (const briefing of [undefined, null, 'Prepared historical reference']) it(`uses the proposed transport with plugin-owned startup policy (${briefing})`, async () => {
  const transport = vi.fn(async (_args: unknown) => ({ sdp: 'answer' }));
  const legacy = vi.fn();
  const bb = { sdk: { threads: { experimental_voice: transport, voice: legacy } } } as unknown as BbPluginApi;
  await nativeVoice(bb, 'thread', { action: 'start', sessionId, sdp: 'offer', experimental_voice: 'juniper', experimental_startupBriefing: briefing });
  const args = transport.mock.calls[0]![0] as { threadId: string; command: { initialContext: string; instructions: string } };
  expect(args).toMatchObject({ threadId: 'thread', command: { action: 'start', sessionId, sdp: 'offer', voice: 'juniper' } });
  expect(args.command.initialContext).toContain(briefing ?? 'No thread briefing is supplied');
  expect(args.command.initialContext.length).toBeLessThanOrEqual(16000);
  expect(args.command.instructions).toContain('existing BB thread');
  expect(legacy).not.toHaveBeenCalled();
  await nativeVoice(bb, 'thread', { action: 'keepAlive', sessionId });
  expect(transport).toHaveBeenLastCalledWith({ threadId: 'thread', command: { action: 'keepAlive', sessionId } });
});
it('preserves the installed legacy connection without starting another transport', async () => {
  const legacy = vi.fn(async (_args: unknown) => ({ sdp: 'answer' }));
  const bb = { sdk: { threads: { voice: legacy } } } as unknown as BbPluginApi;
  const command = { action: 'start' as const, sessionId, sdp: 'offer', experimental_startupBriefing: null };
  await nativeVoice(bb, 'thread', command);
  expect(legacy).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', command });
});

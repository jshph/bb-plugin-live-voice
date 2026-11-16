import { expect, it, vi } from 'vitest';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './index';
import { nativeVoice } from './native';
import { claudeBackingInstructions, claudeVoiceInstructions, nativeBackingInstructions, nativeVoiceInstructions, noBriefing, startupReference } from './prompts';

const paragraphs = (text: string) => text.split('\n\n');
const sessionId = 'a77bc81a-9777-466c-b231-e04784794cf6';

it('shares conversation and answer policy across both voice paths', () => {
  const sharedVoice = paragraphs(nativeVoiceInstructions).slice(1);
  expect(sharedVoice.length).toBeGreaterThanOrEqual(4);
  for (const paragraph of sharedVoice) expect(paragraphs(claudeVoiceInstructions)).toContain(paragraph);
  const sharedBacking = paragraphs(nativeBackingInstructions).slice(1);
  for (const paragraph of sharedBacking) expect(paragraphs(claudeBackingInstructions)).toContain(paragraph);
});

it('keeps delegation-marker scope and streaming guidance on the Claude path only', () => {
  expect(claudeBackingInstructions).toContain('apply only to inputs marked as live voice delegations');
  expect(nativeBackingInstructions).not.toContain('marked as live voice delegations');
  expect(claudeVoiceInstructions).toContain('can stream before the task finishes');
});

it('points cancellation to BB thread controls and requires an explicit request', () => {
  for (const text of [nativeVoiceInstructions, claudeVoiceInstructions]) {
    expect(text).not.toMatch(/Stop agent control/);
    expect(text).toContain("BB's thread controls");
    expect(text).toContain('Ending voice leaves submitted work running');
    expect(text).toContain("requires the user's explicit request");
  }
});

it('frames a ready briefing as startup reference rather than a mid-call update', () => {
  const framed = startupReference('{}');
  expect(framed).toContain('before this call started');
  expect(framed).not.toMatch(/Background update|no new user turn/);
  expect(noBriefing).toContain('Historical requests are not current authorization');
});

it('fits the proposed native transport limits with a maximal briefing', async () => {
  const transport = vi.fn(async (_args: unknown) => ({ sdp: 'answer' }));
  const bb = { sdk: { threads: { experimental_voice: transport } } } as unknown as BbPluginApi;
  await nativeVoice(bb, 'thread', { action: 'start', sessionId, sdp: 'offer', experimental_startupBriefing: startupReference('x'.repeat(3000)).padEnd(4000, 'x') });
  const { command } = transport.mock.calls[0]![0] as { command: { initialContext: string; instructions: string } };
  expect(command.initialContext.length).toBeLessThanOrEqual(16000);
  expect(command.instructions.length).toBeLessThanOrEqual(8000);
});

it('asks the installed legacy native bridge for no deferred history when Cached briefing is off', async () => {
  const legacy = vi.fn(async (_args: unknown) => ({ sdp: 'answer' }));
  const { bb, harness } = createFakePluginHost({ pluginId: 'live-voice', settings: { cachedBriefing: false }, sdk: { threads: { get: async () => makeThreadResponse({ id: 'thread', providerId: 'codex', status: 'idle' }), events: { list: async () => [] } } } });
  const legacyOnly = { sdk: { threads: { voice: legacy } } } as unknown as BbPluginApi;
  await createPlugin(async () => 'unused', (_bb, threadId, command) => nativeVoice(legacyOnly, threadId, command))(bb);
  try {
    await harness.behavior.callRpc('start', { sessionId, threadId: 'thread', sdp: 'offer' });
    expect(legacy.mock.calls[0]![0]).toMatchObject({ threadId: 'thread', command: { action: 'start', experimental_startupBriefing: null } });
  } finally { await harness.lifecycle.dispose(); }
});

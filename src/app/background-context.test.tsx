// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { VoiceClientOptions } from './voice-client';
import { voiceCalls } from './voice-launch';

const { clients } = vi.hoisted(() => ({ clients: [] as { sessionId: string; options: VoiceClientOptions; sendResult: ReturnType<typeof vi.fn> }[] }));
vi.mock('./voice-client', () => ({ VoiceClient: class {
  sessionId = crypto.randomUUID();
  sendResult = vi.fn();
  mute = vi.fn();
  constructor(public options: VoiceClientOptions) { clients.push(this); }
  async start() {
    this.options.state('connecting', null);
    await this.options.request({ action: 'start', sessionId: this.sessionId, sdp: 'offer' });
    this.options.state('active', null);
  }
  stop() { this.options.state('closed', null); }
} }));

const app = await loadPluginApp(() => import('./index'));
const action = app.composerCustomizations[0]!.actions![0]!;
const overlay = app.appOverlays[0]!;
const thread = makeThreadResponse({ id: 'A', title: 'Thread A', status: 'idle', providerId: 'claude' });

beforeEach(() => {
  clients.length = 0;
  vi.stubGlobal('RTCPeerConnection', class {});
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
});
afterEach(async () => {
  await act(async () => voiceCalls.end());
  cleanup(); vi.unstubAllGlobals();
});

it('never requests or forwards mid-call background context, even if an older server returns it', async () => {
  const rpc = {
    available: () => ({ available: true }),
    start: () => ({ sdp: 'answer', adapter: 'delegated', diagnostics: 'basic' }),
    stop: () => ({ stopped: true }),
    trace: () => ({ saved: true }),
    context: () => ({ text: 'Stale mid-call background' }),
    poll: () => ({ updates: [], state: 'ready', backgroundContext: 'Stale mid-call background', ended: null }),
  };
  const callBar = renderSlot(overlay, {}, { rpc });
  const launcher = renderSlot(action, {}, { rpc, composer: { scope: { kind: 'thread', threadId: 'A' } }, sdk: { threads: { get: async () => thread } } });
  fireEvent.click(await launcher.findByRole('button', { name: 'Start Tandem' }));
  await waitFor(() => expect(callBar.inspection.rpcCalls.some(call => call.method === 'poll')).toBe(true));
  const client = clients[0]!;
  await act(async () => {
    client.options.event?.({ type: 'turn.done', turn: { role: 'assistant' } });
    await client.options.request({ action: 'keepAlive', sessionId: client.sessionId });
  });
  expect(callBar.inspection.rpcCalls.some(call => call.method === 'context')).toBe(false);
  expect(client.sendResult).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { VoiceClientOptions } from './voice-client';
import { voiceCalls } from './voice-launch';
import { callUi } from './call-ui';

const { starts, stops } = vi.hoisted(() => ({ starts: vi.fn(), stops: vi.fn() }));
vi.mock('./voice-client', () => ({ VoiceClient: class {
  sessionId = crypto.randomUUID();
  stopped = false;
  constructor(private options: VoiceClientOptions) {}
  async start() {
    starts(); this.options.state('connecting', null);
    await this.options.request({ action: 'start', sessionId: this.sessionId, sdp: 'test-offer' });
    if (!this.stopped) this.options.state('active', null);
  }
  stop() { if (this.stopped) return; this.stopped = true; stops(); this.options.state('closed', null); void this.options.request({ action: 'stop', sessionId: this.sessionId }); }
  mute = vi.fn();
} }));

const selection = {
  projectId: 'proj_selected', environment: { type: 'reuse' as const, environmentId: 'env_selected' },
  providerId: 'codex', model: 'selected-model', permissionMode: 'auto' as const, reasoningLevel: 'high' as const,
};
const app = await loadPluginApp(() => import('./index'));
const action = app.composerCustomizations[0]!.actions![0]!;
const overlay = app.appOverlays[0]!;
const threadA = makeThreadResponse({ id: 'A', title: 'Thread A', status: 'idle', environmentId: 'env_selected' });
const rpc = {
  available: () => ({ available: true }),
  start: () => ({ sdp: 'answer', adapter: 'native' }),
  stop: () => ({ stopped: true }),
  trace: () => ({ saved: true }),
  poll: () => ({ updates: [], state: 'ready', backgroundContext: null, ended: null }),
};

beforeEach(() => {
  starts.mockClear(); stops.mockClear();
  vi.stubGlobal('RTCPeerConnection', class {});
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
});
afterEach(async () => {
  await act(async () => voiceCalls.end());
  cleanup(); vi.unstubAllGlobals();
});

describe('voice launch surfaces', () => {
  it('creates a thread only on click, leaves the draft intact, and connects after preparation', async () => {
    let created!: (thread: typeof threadA) => void;
    const spawn = vi.fn(() => new Promise<typeof threadA>(resolve => { created = resolve; }));
    const launcher = renderSlot(action, {}, { composer: { scope: { kind: 'new-thread', projectId: selection.projectId }, selection, text: 'Do not submit this draft' }, sdk: { threads: { spawn } } });
    const callBar = renderSlot(overlay, {}, { rpc });
    expect(spawn).not.toHaveBeenCalled();
    fireEvent.click(launcher.getByRole('button', { name: 'Start Tandem in a new thread' }));
    await waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    fireEvent.click(within(launcher.container).getByRole('status', { name: 'Connecting voice…' }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(starts).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0]).toEqual([{ ...selection, input: [], title: 'Voice conversation' }]);
    await act(async () => created(threadA));
    await callBar.findByRole('status', { name: 'Voice connected' });
    expect(launcher.inspection.composer.text).toBe('Do not submit this draft');
    expect(launcher.inspection.navigateCalls).toEqual([expect.objectContaining({ threadId: 'A' })]);
    expect(callBar.inspection.rpcCalls).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'start', input: expect.objectContaining({ threadId: 'A' }) })]));
    launcher.unmount();
    expect(stops).not.toHaveBeenCalled();
    expect(callBar.getByRole('button', { name: 'Thread A' })).toBeTruthy();
    expect(callBar.getByRole('button', { name: 'Mute microphone' })).toBeTruthy();
    expect(stops).not.toHaveBeenCalled();
    fireEvent.click(callBar.getByRole('button', { name: 'End call' }));
    expect(stops).toHaveBeenCalledTimes(1);
  });

  it('keeps A connected while browsing B and switches only on explicit action', async () => {
    const callBar = renderSlot(overlay, {}, { rpc });
    const a = renderSlot(action, {}, { rpc, composer: { scope: { kind: 'thread', threadId: 'A' } }, sdk: { threads: { get: async () => threadA } } });
    fireEvent.click(await a.findByRole('button', { name: 'Start Tandem' }));
    await callBar.findByRole('status', { name: 'Voice connected' });
    a.unmount();
    const b = renderSlot(action, {}, { rpc, composer: { scope: { kind: 'thread', threadId: 'B' } }, sdk: { threads: { get: async () => ({ ...threadA, id: 'B', title: 'Thread B' }) } } });
    expect(stops).not.toHaveBeenCalled();
    fireEvent.click(await b.findByRole('button', { name: 'Switch Tandem to this thread' }));
    expect(starts).toHaveBeenCalledTimes(1);
    fireEvent.click(callBar.getByRole('button', { name: 'Keep this call' }));
    expect(stops).not.toHaveBeenCalled();
    fireEvent.click(b.getByRole('button', { name: 'Switch Tandem to this thread' }));
    fireEvent.click(callBar.getByRole('button', { name: 'Switch call' }));
    await b.findByRole('status', { name: 'Voice connected' });
    expect(document.querySelector('section[aria-label="Live voice call"]')).toBeNull();
    await waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
    expect(stops).toHaveBeenCalledTimes(1);
    const startedThreads = callBar.inspection.rpcCalls.filter(call => call.method === 'start').map(call => call.input);
    expect(startedThreads).toEqual([expect.objectContaining({ threadId: 'A' }), expect.objectContaining({ threadId: 'B' })]);
    expect(callBar.inspection.rpcCalls.some(call => call.method === 'control')).toBe(false);
  });

  it('ends on page exit and cannot launch a late-created thread', async () => {
    let created!: (thread: typeof threadA) => void;
    const launcher = renderSlot(action, {}, { composer: { scope: { kind: 'new-thread', projectId: selection.projectId }, selection }, sdk: { threads: { spawn: () => new Promise<typeof threadA>(resolve => { created = resolve; }) } } });
    renderSlot(overlay, {}, { rpc });
    fireEvent.click(launcher.getByRole('button', { name: 'Start Tandem in a new thread' }));
    await waitFor(() => expect(created).toBeTypeOf('function'));
    fireEvent(window, new Event('pagehide'));
    await act(async () => created(threadA));
    expect(starts).not.toHaveBeenCalled();
    expect(launcher.inspection.navigateCalls).toHaveLength(0);
  });

  it('keeps a failed new thread accessible without connecting or creating a second one', async () => {
    const spawn = vi.fn(async () => ({ ...threadA, status: 'error' as const }));
    const launcher = renderSlot(action, {}, { composer: { scope: { kind: 'new-thread', projectId: selection.projectId }, selection }, sdk: { threads: { spawn } } });
    const callBar = renderSlot(overlay, {}, { rpc });
    fireEvent.click(launcher.getByRole('button', { name: 'Start Tandem in a new thread' }));
    expect((await callBar.findByRole('alert')).textContent).toContain('could not start');
    expect(callBar.getByRole('button', { name: 'Thread A' })).toBeTruthy();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(starts).not.toHaveBeenCalled();
  });

  it('moves controls to the composer on the call thread and ends without cancelling work', async () => {
    const callBar = renderSlot(overlay, {}, { rpc, context: { threadId: 'A' } });
    const launcher = renderSlot(action, {}, { rpc, composer: { scope: { kind: 'thread', threadId: 'A' } }, sdk: { threads: { get: async () => threadA } } });
    fireEvent.click(await launcher.findByRole('button', { name: 'Start Tandem' }));
    await waitFor(() => expect(starts).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(launcher.getByRole('status', { name: 'Voice connected' })).toBeTruthy());
    expect(document.querySelector('section[aria-label="Live voice call"]')).toBeNull();
    expect(launcher.getByRole('button', { name: 'End call' })).toBeTruthy();
    expect(launcher.getByRole('button', { name: 'Mute microphone' })).toBeTruthy();
    // The waveform keeps the launcher's right-anchored position; controls appear to its left.
    const waveformStatus = launcher.getByRole('status', { name: 'Voice connected' });
    expect(waveformStatus.parentElement?.lastElementChild).toBe(waveformStatus);
    fireEvent.click(launcher.getByRole('status', { name: 'Voice connected' }));
    expect(launcher.getByRole('button', { name: 'End call' })).toBeTruthy();
    expect(launcher.queryByRole('button', { name: 'Voice connected' })).toBeNull();
    expect(stops).not.toHaveBeenCalled();
    fireEvent.click(launcher.getByRole('button', { name: 'Mute microphone' }));
    expect(launcher.getByRole('button', { name: 'Unmute microphone' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(launcher.getByRole('button', { name: 'End call' }));
    expect(stops).toHaveBeenCalledTimes(1);
    expect(voiceCalls.getSnapshot().call).toBeNull();
    expect(callBar.inspection.rpcCalls.some(call => call.method === 'control')).toBe(false);
  });

  it('portals floating controls outside clipping parents and keeps end available during connection', async () => {
    const container = document.createElement('div');
    container.style.cssText = 'overflow:hidden;transform:translateX(0);pointer-events:none';
    document.body.appendChild(container);
    let connected!: (value: { sdp: string; adapter: string }) => void;
    const callBar = renderSlot(overlay, {}, { rpc: { ...rpc, start: () => new Promise(resolve => { connected = resolve; }) } });
    container.appendChild(callBar.container);
    await act(async () => voiceCalls.request({ key: 'A', threadId: 'A', title: 'A', prepare: async () => threadA }));
    await waitFor(() => expect(connected).toBeTypeOf('function'));
    const end = callBar.getByRole('button', { name: 'End call' });
    expect(container.contains(end)).toBe(false);
    expect(end.closest('section')?.style.pointerEvents).toBe('auto');
    fireEvent.click(end);
    expect(stops).toHaveBeenCalledTimes(1);
    await act(async () => connected({ sdp: 'answer', adapter: 'native' }));
    expect(voiceCalls.getSnapshot().call).toBeNull();
    container.remove();
  });

  it('does not show agent or briefing status in the call controls', async () => {
    const callBar = renderSlot(overlay, {}, { rpc: { ...rpc, start: () => ({ sdp: 'answer', adapter: 'native', briefing: 'ready' }), poll: () => ({ updates: [], state: 'working', backgroundContext: null, ended: null }) } });
    await act(async () => voiceCalls.request({ key: 'A', threadId: 'A', title: 'A', prepare: async () => threadA }));
    await callBar.findByRole('status', { name: 'Voice connected' });
    expect(callBar.queryByText(/Agent working|briefed|context on request|Stop agent/)).toBeNull();
    fireEvent.click(callBar.getByRole('button', { name: 'End call' }));
    expect(stops).toHaveBeenCalledTimes(1);
  });

  it('shows connected, muted and speaking waveforms in both composer and floating controls', async () => {
    const callBar = renderSlot(overlay, {}, { rpc });
    const launcher = renderSlot(action, {}, { rpc, composer: { scope: { kind: 'thread', threadId: 'A' } }, sdk: { threads: { get: async () => threadA } } });
    fireEvent.click(await launcher.findByRole('button', { name: 'Start Tandem' }));
    const controls = await launcher.findByRole('status', { name: 'Voice connected' });
    expect(controls.querySelector('svg')?.getAttribute('data-voice-state')).toBe('listening');
    expect(controls.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(launcher.getByRole('button', { name: 'Mute microphone' }));
    expect(controls.querySelector('svg')?.getAttribute('data-voice-state')).toBe('muted');
    fireEvent.click(launcher.getByRole('button', { name: 'Unmute microphone' }));
    expect(controls.querySelector('svg')?.getAttribute('data-voice-state')).toBe('listening');
    const ui = callUi.getSnapshot()!;
    act(() => callUi.publish({ ...ui, speaking: true }));
    expect(controls.getAttribute('data-voice-state')).toBe('speaking');
    expect(controls.querySelector('svg')?.getAttribute('data-voice-state')).toBe('speaking');
    launcher.unmount();
    const floating = callBar.getByRole('status', { name: 'Voice connected' });
    expect(floating.hasAttribute('aria-expanded')).toBe(false);
    expect(callBar.getByRole('button', { name: 'Mute microphone' })).toBeTruthy();
    expect(callBar.getByRole('button', { name: 'End call' })).toBeTruthy();
    expect(floating.querySelector('svg')?.getAttribute('data-voice-state')).toBe('speaking');
    act(() => callUi.publish({ ...ui, speaking: false }));
    expect(floating.querySelector('svg')?.getAttribute('data-voice-state')).toBe('listening');
    act(() => callUi.publish({ ...ui, muted: true }));
    expect(floating.querySelector('svg')?.getAttribute('data-voice-state')).toBe('muted');
  });

});

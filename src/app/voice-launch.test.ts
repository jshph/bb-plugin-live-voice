import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import type { ComposerSelection } from '@get-bb/plugin-sdk/app';
import { createVoiceThread, VoiceCalls, voiceThreadRequest, type VoiceTarget } from './voice-launch';

const selection: ComposerSelection = {
  projectId: 'proj_voice', providerId: 'codex', model: 'selected-model', reasoningLevel: 'high',
  permissionMode: 'auto', serviceTier: 'fast', environment: { type: 'reuse', environmentId: 'env_selected' },
};

afterEach(() => vi.useRealTimers());

describe('new voice thread preparation', () => {
  it('preserves the selected execution settings and submits no task', async () => {
    const thread = makeThreadResponse({ id: 'thr_voice', status: 'idle', environmentId: 'env_selected' });
    const threads = { spawn: vi.fn(async () => thread), get: vi.fn() };
    const created = vi.fn();
    expect(await createVoiceThread(threads, selection, new AbortController().signal, created)).toEqual(thread);
    expect(threads.spawn).toHaveBeenCalledExactlyOnceWith({ ...selection, input: [], title: 'Voice conversation' });
    expect(created).toHaveBeenCalledExactlyOnceWith(thread);
    expect(threads.get).not.toHaveBeenCalled();
  });

  it('waits for provider initialization before resolving voice startup', async () => {
    vi.useFakeTimers();
    const starting = makeThreadResponse({ status: 'starting', environmentId: null });
    const idle = makeThreadResponse({ status: 'idle', environmentId: 'env_selected' });
    const threads = { spawn: vi.fn(async () => starting), get: vi.fn(async () => idle) };
    let ready = false;
    const prepared = createVoiceThread(threads, selection, new AbortController().signal, () => {}).then(thread => { ready = true; return thread; });
    await Promise.resolve();
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await prepared).toEqual(idle);
  });

  it('does not navigate or connect after cancellation while creation is in flight', async () => {
    let finish!: (thread: ReturnType<typeof makeThreadResponse>) => void;
    const threads = { spawn: vi.fn(() => new Promise<ReturnType<typeof makeThreadResponse>>(resolve => { finish = resolve; })), get: vi.fn() };
    const controller = new AbortController();
    const created = vi.fn();
    const prepared = createVoiceThread(threads, selection, controller.signal, created);
    const rejected = expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); finish(makeThreadResponse());
    await rejected;
    expect(created).not.toHaveBeenCalled();
    expect(threads.get).not.toHaveBeenCalled();
  });

  it('stops polling when cancelled and reports failed or stalled initialization', async () => {
    vi.useFakeTimers();
    const starting = makeThreadResponse({ status: 'starting' });
    const threads = { spawn: vi.fn(async () => starting), get: vi.fn(async () => starting) };
    const controller = new AbortController();
    const preparation = createVoiceThread(threads, selection, controller.signal, () => {});
    const rejected = expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await rejected;
    expect(threads.get).not.toHaveBeenCalled();
    const stalled = createVoiceThread(threads, selection, new AbortController().signal, () => {});
    const timedOut = expect(stalled).rejects.toThrow('still preparing');
    await vi.advanceTimersByTimeAsync(120000); await timedOut;
    await expect(createVoiceThread({ ...threads, spawn: async () => makeThreadResponse({ status: 'error' }) }, selection, new AbortController().signal, () => {})).rejects.toThrow('could not start');
  });

  it('rejects missing selections and unsupported providers before creating anything', () => {
    expect(() => voiceThreadRequest(null)).toThrow('Choose');
    expect(() => voiceThreadRequest({ ...selection, environment: undefined })).toThrow('Choose');
    expect(() => voiceThreadRequest({ ...selection, providerId: 'other' })).toThrow('supports Codex and Claude');
  });

  it('explains older BB validation failures without retrying or sending a placeholder task', async () => {
    const threads = { spawn: vi.fn(async () => { throw new Error('HTTP 400: input must contain at least one entry'); }), get: vi.fn() };
    const created = vi.fn();
    await expect(createVoiceThread(threads, selection, new AbortController().signal, created)).rejects.toThrow('needs a BB update');
    expect(threads.spawn).toHaveBeenCalledTimes(1);
    expect(threads.get).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });
});

describe('app-window call ownership', () => {
  const target = (key: string): VoiceTarget => ({ key, title: key, threadId: key, prepare: vi.fn(async () => ({ id: key, title: key })) });

  it('starts once for repeated requests and survives subscriber remounts', async () => {
    const calls = new VoiceCalls(); const a = target('A');
    calls.request(a);
    const call = calls.getSnapshot().call!;
    const unsubscribe = calls.subscribe(() => {}); unsubscribe();
    calls.subscribe(() => {}); calls.request(a);
    await call.ready;
    expect(a.prepare).toHaveBeenCalledTimes(1);
    expect(calls.getSnapshot().call).toBe(call);
    expect(call.controller.signal.aborted).toBe(false);
    calls.end();
  });

  it('requires an explicit switch and aborts A before preparing B', async () => {
    const calls = new VoiceCalls(); const a = target('A'); const b = target('B');
    calls.request(a); const previous = calls.getSnapshot().call!; await previous.ready;
    calls.request(b);
    expect(calls.getSnapshot().call).toBe(previous); expect(b.prepare).not.toHaveBeenCalled();
    calls.dismissSwitch(); expect(previous.controller.signal.aborted).toBe(false);
    calls.request(b); calls.switchCall();
    expect(previous.controller.signal.aborted).toBe(true);
    await calls.getSnapshot().call!.ready;
    expect(b.prepare).toHaveBeenCalledTimes(1);
    calls.end();
  });

  it('recognizes a new thread as the current destination and cancels unstarted launches', async () => {
    const calls = new VoiceCalls();
    calls.request({ key: 'new-thread', title: 'New', prepare: async (_signal, created) => {
      const thread = { id: 'A', title: 'New' }; created(thread); return thread;
    } });
    await calls.getSnapshot().call!.ready;
    const a = target('A'); calls.request(a);
    expect(calls.getSnapshot().pending).toBeNull();
    expect(a.prepare).not.toHaveBeenCalled();
    const nextNew = { ...target('new-thread'), threadId: undefined };
    calls.request(nextNew);
    expect(calls.getSnapshot().pending).toBe(nextNew);
    expect(nextNew.prepare).not.toHaveBeenCalled();
    calls.end();
    calls.request(a); const ready = calls.getSnapshot().call!.ready; calls.end();
    await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.prepare).not.toHaveBeenCalled();
  });
});

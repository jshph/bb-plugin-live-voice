// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observePlayback } from './playback';

afterEach(() => vi.unstubAllGlobals());

describe('playback indicator', () => {
  it('follows received audio energy, settles during silence, and disposes its graph', () => {
    let tick!: FrameRequestCallback;
    let amplitude = 0;
    const close = vi.fn(async () => {});
    const disconnect = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { tick = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      close = close;
      resume = async () => {};
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect });
      createAnalyser = () => ({ fftSize: 256, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(amplitude) });
    });
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'paused', { value: false });
    audio.srcObject = {} as MediaStream;
    const changed = vi.fn();
    const dispose = observePlayback(audio, changed);
    audio.dispatchEvent(new Event('playing'));
    tick(100);
    expect(changed).not.toHaveBeenCalled();
    amplitude = 0.1;
    tick(150);
    expect(changed).toHaveBeenLastCalledWith(true);
    amplitude = 0;
    tick(200);
    expect(changed).toHaveBeenCalledTimes(1);
    tick(400);
    expect(changed).toHaveBeenLastCalledWith(false);
    dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    audio.dispatchEvent(new Event('playing'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when audio analysis is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const audio = document.createElement('audio');
    audio.srcObject = {} as MediaStream;
    const changed = vi.fn();
    const dispose = observePlayback(audio, changed);
    expect(() => audio.dispatchEvent(new Event('playing'))).not.toThrow();
    dispose();
    expect(changed).not.toHaveBeenCalled();
  });
});

/** Observe the received stream without storing samples or adding another audio output. */
export function observePlayback(audio: HTMLAudioElement, speaking: (active: boolean) => void): () => void {
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let frame = 0;
  let disposed = false;
  let active = false;
  let audibleUntil = 0;
  const update = (next: boolean) => { if (active !== next) { active = next; speaking(next); } };
  const stop = () => {
    cancelAnimationFrame(frame);
    source?.disconnect(); source = null;
    if (context) void context.close().catch(() => {});
    context = null;
    audibleUntil = 0;
    update(false);
  };
  const start = () => {
    stop();
    if (disposed || !audio.srcObject || typeof AudioContext === 'undefined') return;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(audio.srcObject as MediaStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const current = context;
      void current.resume().catch(() => { if (current === context) stop(); });
      const sample = (now: number) => {
        if (disposed || current !== context) return;
        analyser.getFloatTimeDomainData(samples);
        const power = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
        if (!audio.paused && !audio.muted && audio.volume > 0 && current.state === 'running' && power > 0.000225) audibleUntil = now + 180;
        update(!audio.paused && now < audibleUntil);
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
    } catch { stop(); }
  };
  audio.addEventListener('playing', start);
  audio.addEventListener('pause', stop);
  audio.addEventListener('emptied', stop);
  return () => {
    disposed = true;
    audio.removeEventListener('playing', start);
    audio.removeEventListener('pause', stop);
    audio.removeEventListener('emptied', stop);
    stop();
  };
}

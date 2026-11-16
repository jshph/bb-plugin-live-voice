export class WakeSignal {
  private listeners = new Set<() => void>();
  private pending = false;
  notify(): void { this.pending = true; for (const listener of [...this.listeners]) listener(); }
  wait(signal: AbortSignal, timeoutMs = 15000): Promise<void> {
    if (signal.aborted || this.pending) { this.pending = false; return Promise.resolve(); }
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', finish); this.pending = false; resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(finish);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}

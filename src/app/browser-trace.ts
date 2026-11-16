import { acceptsTrace, failureReason, rateLimitedWarning, selectTrace, type Diagnostics, type TraceData, type TraceEntry } from '../shared/trace';

export type TraceSink = (name: string, data?: TraceData | (() => TraceData)) => void;

export class BrowserTrace {
  private sequence = 0;
  private started = performance.now();
  private queue: TraceEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | null = null;
  private mode: Diagnostics = 'basic';
  private warn = rateLimitedWarning(() => console.warn('Tandem diagnostic batches were not saved; sequence gaps indicate loss.'));
  constructor(private readonly send: (entries: TraceEntry[]) => Promise<unknown>) {}
  configure(mode: Diagnostics) { this.mode = mode; }
  get detailed(): boolean { return this.mode === 'detailed'; }
  record: TraceSink = (name, data = {}) => {
    if (!acceptsTrace(name, this.mode)) return;
    const selected = selectTrace(name, typeof data === 'function' ? data() : data, this.mode);
    if (!selected) return;
    this.queue.push({ seq: ++this.sequence, at: Date.now(), elapsedMs: performance.now() - this.started, name, data: selected });
    if (this.queue.length > 1000) this.queue.shift();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  };
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.sending) { await this.sending; if (this.queue.length) await this.flush(); return; }
    this.sending = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 50);
        try { await this.send(batch); }
        catch { this.warn(); }
      }
    })();
    try { await this.sending; } finally { this.sending = null; }
  }
}

export function describeVoiceEvent(value: unknown, mode: Diagnostics = 'basic'): TraceData | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string' || !/^(turn\.|.*transcript[._]|delegation\.|session\.context\.|input_audio_buffer\.speech_|error$)/.test(event.type)) return null;
  if (event.type === 'session.context.appended' || (mode === 'basic' && !/^(turn\.|delegation\.|error$)/.test(event.type))) return null;
  const item = (event.item && typeof event.item === 'object' ? event.item : {}) as Record<string, unknown>;
  const turn = (event.turn && typeof event.turn === 'object' ? event.turn : {}) as Record<string, unknown>;
  const content = Array.isArray(item.content) ? item.content : [];
  const error = (event.error && typeof event.error === 'object' ? event.error : {}) as Record<string, unknown>;
  const text = mode !== 'detailed' ? '' : typeof error.message === 'string' ? error.message : typeof item.text === 'string' ? item.text : typeof event.transcript === 'string' ? event.transcript : typeof event.delta === 'string' ? event.delta : content.filter(part => part && typeof part === 'object' && typeof part.text === 'string').map(part => part.text).join('\n');
  const id = item.id ?? event.delegation_item_id ?? event.item_id ?? turn.id;
  const role = turn.role ?? item.role;
  return { type: event.type.slice(0, 100), ...(event.type === 'error' ? { reason: failureReason(error.message) } : {}), ...(typeof id === 'string' ? { id: id.slice(0, 200) } : {}), ...(typeof role === 'string' ? { role: role.slice(0, 40) } : {}), ...(text ? { text: text.slice(0, 32000), characters: text.length, truncated: text.length > 32000 } : {}) };
}

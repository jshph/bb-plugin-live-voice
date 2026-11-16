import { z } from 'zod';

export const traceEntrySchema = z.object({
  seq: z.number().int().positive(),
  at: z.number().finite(),
  elapsedMs: z.number().nonnegative(),
  name: z.string().min(1).max(100),
  data: z.object({
    reason: z.string().max(80).optional(),
    fingerprint: z.string().max(64).optional(),
    ageMs: z.number().nonnegative().optional(),
    type: z.string().max(100).optional(),
    id: z.string().max(200).optional(),
    role: z.string().max(40).optional(),
    text: z.string().max(32000).optional(),
    channel: z.string().max(40).optional(),
    characters: z.number().nonnegative().optional(),
    bytes: z.number().nonnegative().optional(),
    eventAt: z.number().finite().optional(),
    updateSeq: z.number().nonnegative().optional(),
    final: z.boolean().optional(),
    truncated: z.boolean().optional(),
    state: z.string().max(100).optional(),
    inputActive: z.boolean().optional(),
    assistantActive: z.boolean().optional(),
    firstExchangeDone: z.boolean().optional(),
    contextPending: z.boolean().optional(),
  }),
});
export type TraceEntry = z.infer<typeof traceEntrySchema>;
export type TraceData = TraceEntry['data'];
export const diagnosticsSchema = z.enum(['basic', 'detailed']);
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type TraceSink = (name: string, data?: TraceData | (() => TraceData)) => void;
const basicEvents = new Set(['session.start', 'session.stop', 'session.voice', 'session.connect', 'session.failed', 'context.policy', 'diagnostics.policy', 'context.startup', 'context.unavailable', 'context.queued', 'context.sent', 'context.acknowledged', 'context.failed', 'client.start', 'client.stop', 'microphone.acquired', 'microphone.mute', 'audio.track.received', 'audio.play.started', 'audio.play.blocked', 'peer.state', 'datachannel.open', 'realtime.received', 'native.state', 'native.backing.turn', 'backing.submit', 'backing.accepted', 'backing.milestone', 'backing.failed', 'delivery.received', 'delegation.unsent']);
export function acceptsTrace(name: string, mode: Diagnostics): boolean { return name !== 'adapter.selected' && (mode === 'detailed' || basicEvents.has(name)); }
export function selectTrace(name: string, data: TraceData, mode: Diagnostics): TraceData | null {
  if (!acceptsTrace(name, mode) || (name === 'realtime.received' && data.type === 'session.context.appended')) return null;
  if (mode === 'detailed') return data;
  if (name === 'realtime.received' && !/^(turn\.|delegation\.|error$)/.test(data.type ?? '')) return null;
  const { text: _text, inputActive: _input, assistantActive: _assistant, firstExchangeDone: _exchange, contextPending: _pending, ...metadata } = data;
  return metadata;
}
export function failureReason(value: unknown): string {
  const text = String(value).toLowerCase();
  if (/time.?out|timed out/.test(text)) return 'timeout';
  if (/microphone|permission|notallowed/.test(text)) return 'microphone';
  if (/auth|sign.in|subscription|api.key/.test(text)) return 'authentication';
  if (/disconnect|connection|network/.test(text)) return 'connection';
  if (/cancel|ended while/.test(text)) return 'cancelled';
  return 'failed';
}
export function rateLimitedWarning(warn: () => void): () => void {
  let last = -Infinity;
  return () => { if (Date.now() - last >= 60000) { last = Date.now(); warn(); } };
}

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

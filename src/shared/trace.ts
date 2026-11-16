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

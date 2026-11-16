import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { spokenTurnSchema } from './conversation';
import { diagnosticsSchema, traceEntrySchema } from './trace';

export const briefingStatusSchema = z.object({ state: z.enum(['missing', 'busy', 'preparing', 'ready', 'stale', 'error']), generatedAt: z.number().nullable(), text: z.string().nullable(), error: z.string().nullable() });
export type BriefingStatus = z.infer<typeof briefingStatusSchema>;

const session = z.object({ sessionId: z.string().uuid() });
export const rpcContract = defineRpcContract({
  briefingStatus: { input: z.object({ threadId: z.string().min(1).max(200) }), output: briefingStatusSchema },
  prepareBriefing: { input: z.object({ threadId: z.string().min(1).max(200) }), output: briefingStatusSchema },
  forgetBriefing: { input: z.object({ threadId: z.string().min(1).max(200) }), output: z.object({ forgotten: z.boolean() }) },
  available: { input: z.object({ threadId: z.string().min(1).max(200) }), output: z.object({ available: z.boolean() }) },
  start: {
    input: session.extend({ threadId: z.string().min(1).max(200), sdp: z.string().min(1).max(131072) }),
    output: z.object({ sdp: z.string(), adapter: z.enum(['native', 'delegated']), diagnostics: diagnosticsSchema, briefing: z.enum(['ready', 'lookup']).optional() }),
  },
  trace: { input: session.extend({ entries: z.array(traceEntrySchema).max(50) }), output: z.object({ saved: z.boolean() }) },
  traceSessions: { input: z.object({ threadId: z.string().max(200).optional() }), output: z.array(z.object({ sessionId: z.string(), threadId: z.string(), adapter: z.string(), startedAt: z.number(), diagnostics: diagnosticsSchema, bytes: z.number(), dropped: z.number() })) },
  traceRead: { input: session.extend({ afterId: z.number().int().nonnegative().default(0) }), output: z.array(z.object({ cursor: z.number(), source: z.string(), receivedAt: z.number(), entry: traceEntrySchema })) },
  stop: { input: session, output: z.object({ stopped: z.boolean() }) },
  context: { input: session, output: z.object({ text: z.string().nullable() }) },
  control: { input: session.extend({ action: z.literal('cancelWork') }), output: z.object({ requested: z.boolean() }) },
  poll: {
    input: session.extend({ afterSeq: z.number().int().nonnegative().optional() }),
    output: z.object({ updates: z.array(z.object({ seq: z.number(), id: z.string(), text: z.string(), channel: z.enum(['speakable', 'developer']), final: z.boolean() })), state: z.enum(['ready', 'working', 'attention']), backgroundContext: z.string().nullable(), ended: z.string().nullable() }),
  },
  delegate: {
    input: session.extend({ id: z.string().min(1).max(200), text: z.string().trim().min(1).max(12000), turns: z.array(spokenTurnSchema).max(100).refine(turns => turns.reduce((size, turn) => size + turn.text.length, 0) <= 16000 && turns.every((turn, index) => index === 0 || turn.seq > turns[index - 1]!.seq), 'Spoken turns must be ordered and total at most 16000 characters') }),
    output: z.object({ accepted: z.boolean() }),
  },
});

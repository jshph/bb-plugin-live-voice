import { createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { startupReference } from '../prompts';

export const briefingSchema = z.object({
  subject: z.string().max(200),
  goals: z.array(z.string().max(250)).max(3),
  decisions: z.array(z.string().max(300)).max(5),
  findings: z.array(z.object({ fact: z.string().max(350), evidence: z.array(z.number().int().nonnegative()).max(4) })).max(6),
  openQuestions: z.array(z.string().max(200)).max(3),
}).strict();
export type Briefing = z.infer<typeof briefingSchema>;
export type Evidence = { revision: string; title: string | null; items: { seq: number; kind: string; text: string; shortened: boolean }[]; bounded: true };
const semanticTypes = ['client/turn/requested', 'item/completed', 'turn/completed', 'thread/context/cleared'] as const;
export async function briefingRevision(bb: BbPluginApi, threadId: string, signal?: AbortSignal) {
  const [thread, rows] = await Promise.all([bb.sdk.threads.get({ threadId, signal }), bb.sdk.threads.events.list({ threadId, types: semanticTypes, order: 'desc', limit: '1', signal })]);
  return { thread, revision: createHash('sha256').update(JSON.stringify([1, thread.id, thread.providerId, thread.title, rows[0]?.seq ?? 0])).digest('hex') };
}
export async function briefingEvidence(bb: BbPluginApi, threadId: string, signal: AbortSignal): Promise<Evidence> {
  const head = await briefingRevision(bb, threadId, signal);
  const [clears, users, completed] = await Promise.all([
    bb.sdk.threads.events.list({ threadId, types: ['thread/context/cleared'], order: 'desc', limit: '1', signal }),
    bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'desc', limit: '12', signal }),
    bb.sdk.threads.events.list({ threadId, types: ['item/completed'], order: 'desc', limit: '100', signal }),
  ]);
  const clear = clears[0]?.seq ?? 0;
  const items: Evidence['items'] = [];
  for (const row of [...users, ...completed].sort((a, b) => b.seq - a.seq)) {
    if (row.seq <= clear || (row.type !== 'client/turn/requested' && row.scope.kind !== 'turn')) continue;
    let text = '', kind = '';
    if (row.type === 'client/turn/requested') { kind = 'user'; text = row.data.input.filter(part => part.type === 'text' && part.visibility !== 'agent-only').map(part => part.type === 'text' ? part.text : '').join('\n'); }
    if (row.type === 'item/completed') {
      const item = row.data.item;
      if ('parentToolCallId' in item && item.parentToolCallId) continue;
      if (item.type === 'reasoning') continue;
      if (item.type === 'agentMessage') { kind = 'assistant'; text = item.text; }
      else if (['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch'].includes(item.type)) { kind = 'tool-result'; text = JSON.stringify(item); }
    }
    if (!text.trim()) continue;
    const clipped = text.length > 6000 ? text.slice(0, 2000) + '\n[Middle omitted]\n' + text.slice(-3980) : text;
    items.push({ seq: row.seq, kind, text: clipped, shortened: text.length > 6000 });
  }
  let size = 0;
  const selected = items.filter(item => { if (size + item.text.length > 60000) return false; size += item.text.length; return true; }).reverse();
  return { revision: head.revision, title: head.thread.title, items: selected, bounded: true };
}
export function validateBriefing(value: unknown, evidence: Evidence): string {
  const result = briefingSchema.parse(value);
  const sequences = new Set(evidence.items.map(item => item.seq));
  if (result.findings.some(finding => finding.evidence.length === 0 || finding.evidence.some(seq => !sequences.has(seq)))) throw new Error('Briefing has missing or unknown evidence pointers');
  const text = JSON.stringify(result);
  if (text.length > 3000 || startupReference(text).length > 4000) throw new Error('Briefing exceeds the startup context budget');
  return text;
}

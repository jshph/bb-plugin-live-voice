import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CodexConnection, requireSubscriptionAccount } from '../codex';
import { briefingInstructions, briefingSchema, validateBriefing, type Evidence } from './briefing';

export async function synthesizeBriefing(evidence: Evidence, command: string, signal: AbortSignal): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-voice-briefing-'));
  let threadId: string | undefined;
  let resolveDone!: (text: string) => void, rejectDone!: (error: Error) => void;
  let text = '';
  const done = new Promise<string>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const connection = new CodexConnection((method, params) => {
    const event = z.object({ threadId: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }).optional(), turn: z.object({ status: z.string(), error: z.unknown().optional() }).optional() }).safeParse(params);
    if (!event.success || event.data.threadId !== threadId) return;
    if (method === 'item/completed' && event.data.item?.type === 'agentMessage' && event.data.item.text) text = event.data.item.text;
    if (method === 'item/started' && event.data.item && !['userMessage', 'agentMessage', 'reasoning'].includes(event.data.item.type)) { rejectDone(new Error(`Briefing compiler attempted tool work: ${event.data.item.type}`)); void connection.close(); }
    if (method === 'turn/completed') { if (event.data.turn?.status === 'completed' && text) resolveDone(text); else rejectDone(new Error('Briefing compiler did not complete an answer')); }
  }, command, error => rejectDone(error));
  const cancel = () => { rejectDone(new Error('Briefing preparation cancelled')); void connection.close(); };
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 90000);
  try {
    if (signal.aborted) throw new Error('Briefing preparation cancelled');
    await connection.request('initialize', { clientInfo: { name: 'bb-voice-briefing', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    requireSubscriptionAccount(await connection.request('account/read', { refreshToken: false }));
    const result = z.object({ thread: z.object({ id: z.string() }) }).parse(await connection.request('thread/start', {
      cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: briefingInstructions,
      config: { 'features.shell_tool': false, 'features.multi_agent': false, 'features.skill_search': false, 'features.enable_mcp_apps': false, web_search: 'disabled' },
    }));
    threadId = result.thread.id;
    await connection.request('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text: JSON.stringify(evidence), text_elements: [] }], outputSchema: z.toJSONSchema(briefingSchema) });
    return validateBriefing(JSON.parse(await done), evidence);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
    if (threadId && !signal.aborted) await connection.request('thread/archive', { threadId }).catch(() => {});
    await connection.close(); await rm(cwd, { recursive: true, force: true });
  }
}

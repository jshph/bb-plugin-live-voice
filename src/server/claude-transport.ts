import { z } from 'zod';
import { voiceSchema, type Voice } from '../shared/voices';
import { clientInfo, CodexConnection, requireSubscriptionAccount } from './codex-app-server';
import { claudeVoiceInstructions, noBriefing } from './prompts';

/**
 * Negotiates subscription-authenticated browser audio for a Claude call through a temporary Codex
 * app-server session, then detaches it. Coding work goes to the Claude BB thread, not this session.
 */
export async function createSubscriptionCall(sdp: string, command = 'codex', startupBriefing?: string | null, voice?: Voice): Promise<string> {
  if (voice !== undefined) voiceSchema.parse(voice);
  let nativeThreadId: string | undefined;
  let resolveSdp!: (value: string) => void;
  let rejectSdp!: (error: Error) => void;
  const answer = new Promise<string>((resolve, reject) => { resolveSdp = resolve; rejectSdp = reject; });
  void answer.catch(() => {});
  const connection = new CodexConnection((method, params) => {
    const event = z.object({ threadId: z.string(), sdp: z.string().optional(), message: z.string().optional() }).safeParse(params);
    if (!event.success || event.data.threadId !== nativeThreadId) return;
    if (method === 'thread/realtime/sdp' && event.data.sdp) resolveSdp(event.data.sdp);
    if (method === 'thread/realtime/error') rejectSdp(new Error(event.data.message ?? 'Codex voice failed'));
  }, command);
  const timer = setTimeout(() => rejectSdp(new Error('Codex voice connection timed out')), 35000);
  try {
    await connection.request('initialize', { clientInfo: clientInfo('bb-live-voice'), capabilities: { experimentalApi: true } });
    requireSubscriptionAccount(await connection.request('account/read', { refreshToken: false }));
    const thread = z.object({ thread: z.object({ id: z.string() }) }).parse(await connection.request('thread/start', { approvalPolicy: 'never', sandbox: 'read-only' }));
    nativeThreadId = thread.thread.id;
    const [, result] = await Promise.all([
      connection.request('thread/realtime/start', {
        threadId: nativeThreadId, ...(voice ? { voice } : {}), transport: { type: 'webrtc', sdp }, version: 'v3', outputModality: 'audio', includeStartupContext: false,
        clientManagedHandoffs: true, initialItems: [{ role: 'developer', text: claudeVoiceInstructions }, ...(startupBriefing === undefined ? [] : [{ role: 'developer', text: startupBriefing ?? noBriefing }])],
      }), answer,
    ]);
    await connection.request('thread/realtime/stop', { threadId: nativeThreadId });
    return result;
  } finally {
    clearTimeout(timer);
    if (nativeThreadId) await connection.request('thread/archive', { threadId: nativeThreadId }).catch(() => {});
    await connection.close();
  }
}

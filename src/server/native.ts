import type { Voice } from '../shared/voices';
import { backingInstructions, nativeNoBriefing, voiceStyleInstructions } from './prompts';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

export type NativeVoiceCommand = { action: 'start'; sessionId: string; sdp: string; experimental_voice?: Voice; experimental_startupBriefing?: string | null } | { action: 'stop' | 'keepAlive'; sessionId: string };
type TransportCommand = { action: 'start'; sessionId: string; sdp: string; voice?: Voice; initialContext: string; instructions: string } | { action: 'stop' | 'keepAlive'; sessionId: string };
type NativeThreads = { experimental_voice?: (args: { threadId: string; command: TransportCommand }) => Promise<{ sdp: string | null }>; voice?: (args: { threadId: string; command: NativeVoiceCommand }) => Promise<{ sdp: string | null }> };

export async function nativeVoice(bb: BbPluginApi, threadId: string, command: NativeVoiceCommand): Promise<{ sdp: string | null }> {
  const threads = bb.sdk.threads as typeof bb.sdk.threads & NativeThreads;
  if (typeof threads.experimental_voice === 'function') {
    const mapped: TransportCommand = command.action === 'start' ? { action: 'start', sessionId: command.sessionId, sdp: command.sdp, ...(command.experimental_voice ? { voice: command.experimental_voice } : {}), instructions: backingInstructions, initialContext: [voiceStyleInstructions, command.experimental_startupBriefing ?? nativeNoBriefing].join('\n\n') } : command;
    return threads.experimental_voice({ threadId, command: mapped });
  }
  if (typeof threads.voice !== 'function') throw new Error('Native Codex voice requires BB’s native voice transport bridge. This BB build does not expose it. No second Codex writer or delegated fallback will be started.');
  return threads.voice({ threadId, command });
}

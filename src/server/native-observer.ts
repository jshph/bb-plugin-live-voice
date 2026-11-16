import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { failureReason } from '../shared/trace';
import type { Session, SessionReporter } from './sessions';

/**
 * Follows a native Codex thread's events for one voice session. It only observes: native Codex owns
 * delegation on its existing provider connection, so nothing here sends to the thread.
 */
export async function observeNative(bb: Pick<BbPluginApi, 'sdk'>, session: Session, report: Pick<SessionReporter, 'trace' | 'changed'>): Promise<void> {
  const { trace, changed } = report;
  while (!session.abort.signal.aborted) {
    const rows = await bb.sdk.threads.events.list({ threadId: session.threadId, afterSeq: String(session.nativeCursor), order: 'asc', limit: '100', ...(session.diagnostics === 'basic' ? { types: ['turn/started', 'turn/completed', 'thread/extensionState/updated'] as const } : {}), signal: session.abort.signal });
    for (const row of rows) {
      session.nativeCursor = Math.max(session.nativeCursor, row.seq);
      if (row.type === 'item/agentMessage/delta' && !row.data.parentToolCallId) trace(session, 'native.backing.delta', () => ({ id: row.data.itemId, text: row.data.delta.slice(0, 32000), characters: row.data.delta.length, truncated: row.data.delta.length > 32000, eventAt: row.createdAt, updateSeq: row.seq }));
      if (row.type === 'item/completed' && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId) { const item = row.data.item; trace(session, 'native.backing.completed', () => ({ id: item.id, text: item.text.slice(0, 32000), characters: item.text.length, truncated: item.text.length > 32000, eventAt: row.createdAt, updateSeq: row.seq })); }
      if (row.type === 'turn/started' || row.type === 'turn/completed') { trace(session, 'native.backing.turn', { type: row.type, eventAt: row.createdAt, updateSeq: row.seq }); session.nativeWorking = row.type === 'turn/started'; changed(session); }
      if (row.type !== 'thread/extensionState/updated' || row.data.kind !== 'provider-codex/voice') continue;
      const state = z.object({ sessionId: z.string(), status: z.string(), message: z.string().nullable(), backgroundContext: z.string().optional() }).safeParse(row.data.payload);
      if (!state.success || state.data.sessionId !== session.id) continue;
      trace(session, 'native.state', { state: state.data.status, ...(state.data.status === 'active' ? {} : { reason: failureReason(state.data.message) }), characters: state.data.backgroundContext?.length });

      if (state.data.status !== 'active') session.ended = state.data.message ?? 'Native voice session ended';
      changed(session);
    }
    if (rows.length < 100) await session.nativeSignal.wait(session.abort.signal);
  }
}

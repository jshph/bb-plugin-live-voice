import { selectedVoice, voiceNames, type Voice } from '../shared/voices';
import { createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { rpcContract } from '../shared/contract';
import { supportsVoice } from '../shared/providers';
import { createSubscriptionCall } from './claude-transport';
import { createClaudeRunner, type ClaudeRunnerOptions } from './claude-runner';
import { nativeVoice } from './native';
import { observeNative } from './native-observer';
import { createSessionRegistry, newSession, type Session } from './sessions';
import { openDatabase } from './storage';
import { createTraceStore } from './trace-store';
import { failureReason, rateLimitedWarning, type Diagnostics } from '../shared/trace';
import { createBriefingCache } from './briefing/briefing-cache';
import { synthesizeBriefing } from './briefing/synthesize';

/** Poll reuses a pending-approval check for this long; interaction.pending events still set attention immediately. */
export const attentionFreshnessMs = 2000;

export function createPlugin(connect?: (sdp: string, startupBriefing?: string | null, voice?: Voice) => Promise<string>, nativeConnect: typeof nativeVoice = nativeVoice, synthesize: typeof synthesizeBriefing = synthesizeBriefing, options: ClaudeRunnerOptions = {}) {
  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({ diagnostics: { type: 'select', label: 'Diagnostics', description: 'Basic saves compact metadata. Detailed records private text, deltas and chunk timing for troubleshooting. Applies to new calls.', options: ['basic', 'detailed'], default: 'basic' }, voice: { type: 'select', label: 'Voice', description: 'Voice for new Codex and Claude calls. Default keeps Codex’s voice choice (normally Cove). End and start a new call after changing this setting.', options: ['default', ...voiceNames], default: 'default' }, cachedBriefing: { type: 'boolean', label: 'Cached briefing', description: 'Experimental: supply a current prepared briefing when a new call starts. If unavailable, use retrieval for that call. Changes apply to new calls.', default: false }, codexCommand: { type: 'string', label: 'Codex executable', description: 'Official Codex CLI on the BB server, signed in with ChatGPT. Used for briefing synthesis and Claude’s voice transport. Native Codex voice uses its provider connection.', default: 'codex' } });
    const openCall = connect ?? (async (sdp: string, startupBriefing?: string | null, voice?: Voice) => createSubscriptionCall(sdp, (await settings.get()).codexCommand, startupBriefing, voice));
    const db = openDatabase(bb);
    const traces = createTraceStore(db);
    const sessions = createSessionRegistry(bb, traces, (threadId, sessionId) => nativeConnect(bb, threadId, { action: 'stop', sessionId }));
    const { trace, changed, end, get } = sessions;
    const claude = createClaudeRunner(bb, sessions, options);
    const briefings = createBriefingCache(bb, db, async (source, signal) => synthesize(source, (await settings.get()).codexCommand, signal));
    settings.onChange(next => { if (!next.cachedBriefing) briefings.cancel(); });
    function refreshAttention(session: Session): Promise<void> | void {
      if (session.attentionRefresh) return session.attentionRefresh;
      if (Date.now() - session.attentionCheckedAt < attentionFreshnessMs) return;
      const refresh = bb.sdk.threads.interactions.list({ threadId: session.threadId })
        .then(pending => { session.attention = pending.length > 0; session.attentionCheckedAt = Date.now(); })
        .finally(() => { if (session.attentionRefresh === refresh) session.attentionRefresh = null; });
      session.attentionRefresh = refresh;
      return refresh;
    }

    bb.rpc.register(rpcContract, {
      trace: ({ sessionId, entries }) => ({ saved: traces.write(sessionId, 'browser', entries) }),
      traceSessions: ({ threadId }) => traces.list(threadId) as { sessionId: string; threadId: string; adapter: string; startedAt: number; diagnostics: Diagnostics; bytes: number; dropped: number }[],
      traceRead: ({ sessionId, afterId }) => traces.read(sessionId, afterId),
      briefingStatus: ({ threadId }) => briefings.inspect(threadId),
      prepareBriefing: ({ threadId }) => briefings.request(threadId),
      forgetBriefing: ({ threadId }) => { briefings.forget(threadId); return { forgotten: true }; },
      available: async ({ threadId }) => { const thread = await bb.sdk.threads.get({ threadId }); return { available: supportsVoice(thread.providerId) }; },
      start: async ({ sessionId, threadId, sdp }) => {
        const reservation = sessions.reserve(sessionId, threadId);
        let session: Session, voice: Voice | undefined, adapter: Session['adapter'];
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          if (reservation.cancelled) throw new Error('Voice call ended while connecting.');
          const callConfig = await settings.get();
          voice = selectedVoice(callConfig.voice);
          adapter = thread.providerId === 'codex' ? 'native' : 'delegated';
          session = newSession({ id: sessionId, threadId, adapter, backgroundMode: callConfig.cachedBriefing ? 'cached' : 'off', diagnostics: callConfig.diagnostics as Diagnostics, warn: rateLimitedWarning(() => bb.log.warn('Voice diagnostic records could not be saved')), nativeWorking: thread.status === 'active' });
          sessions.add(reservation, session);
        } catch (error) { sessions.release(reservation); throw error; }
        try { traces.start(sessionId, threadId, adapter, session.diagnostics); trace(session, 'session.start', { state: adapter }); trace(session, 'session.voice', { state: voice ?? 'default' }); trace(session, 'context.policy', { state: session.backgroundMode }); trace(session, 'diagnostics.policy', { state: session.diagnostics }); } catch { session.warn(); }
        try {
          const startup = session.backgroundMode === 'cached' ? await briefings.startupStatus(threadId) : undefined;
          const startupBriefing = startup?.text;
          if (startup) trace(session, 'context.startup', () => ({ state: startup.state, reason: 'attempt', ...(startup.generatedAt ? { ageMs: Math.max(0, Date.now() - startup.generatedAt) } : {}), characters: startupBriefing?.length ?? 0, ...(startupBriefing ? { fingerprint: createHash('sha256').update(startupBriefing).digest('hex'), ...(session.diagnostics === 'detailed' ? { text: startupBriefing } : {}) } : {}) }));
          let answer: string;
          if (adapter === 'native') {
            const latest = await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '1' }); session.nativeCursor = latest[0]?.seq ?? 0;
            const result = await nativeConnect(bb, threadId, { action: 'start', sessionId, sdp, ...(voice ? { experimental_voice: voice } : {}), experimental_startupBriefing: startupBriefing ?? null });
            if (!result.sdp) throw new Error('Native Codex did not return an SDP answer');
            answer = result.sdp;
            void observeNative(bb, session, sessions).catch(error => { if (!session.abort.signal.aborted) { session.ended = String(error); trace(session, 'session.failed', { reason: failureReason(error) }); changed(session); } });
          } else answer = await openCall(sdp, startupBriefing ?? null, voice);
          if (session.abort.signal.aborted) throw new Error('Voice call ended while connecting.');
          trace(session, 'session.connect', { state: 'negotiated' });
          return { sdp: answer, adapter, diagnostics: session.diagnostics, ...(session.backgroundMode === 'cached' ? { briefing: startupBriefing ? 'ready' as const : 'lookup' as const } : {}) };
        } catch (error) { trace(session, 'session.failed', { reason: failureReason(error) }); await end(sessionId, session); throw error; }
      },
      stop: async ({ sessionId }) => ({ stopped: sessions.cancel(sessionId) || await end(sessionId) }),
      control: async ({ sessionId }) => {
        const session = get(sessionId);
        if (session.adapter === 'delegated' && !session.job) return { requested: false };
        await bb.sdk.threads.stop({ threadId: session.threadId });
        sessions.wake(session); changed(session);
        return { requested: true };
      },
      // Retired mid-call background delivery. Kept for existing callers; cached context is startup-only.
      context: async ({ sessionId }) => {
        get(sessionId);
        return { text: null };
      },
      poll: async ({ sessionId, afterSeq }) => {
        const session = get(sessionId);
        if (session.adapter === 'native') await nativeConnect(bb, session.threadId, { action: 'keepAlive', sessionId });
        if (session.job || session.nativeWorking) await refreshAttention(session);
        if (afterSeq !== undefined && session.updates.length && afterSeq < session.updates[0]!.seq - 1) throw new Error('Voice updates expired before delivery. Restart voice and check the complete backing answer in BB.');
        return { updates: session.updates.filter(update => update.seq > (afterSeq ?? 0) && !session.superseded.has(update.id)), state: session.attention ? 'attention' as const : (session.job || session.nativeWorking) ? 'working' as const : 'ready' as const, backgroundContext: null, ended: session.ended };
      },
      delegate: ({ sessionId, id, text, turns }) => {
        const session = get(sessionId);
        if (session.adapter === 'native') throw new Error('Native Codex owns its delegations; the plugin must not execute them twice.');
        return claude.delegate(session, id, text, turns);
      },
    });

    bb.events.on('experimental_thread.events', ({ thread }) => { for (const session of sessions.forThread(thread.id)) sessions.wake(session); });
    const wake = ({ thread }: { thread: { id: string } }) => { for (const session of sessions.forThread(thread.id)) { sessions.wake(session); changed(session); } };
    bb.events.on('thread.idle', async event => { wake(event); if ((await settings.get()).cachedBriefing && briefings.watched(event.thread.id)) await briefings.request(event.thread.id); });
    bb.events.on('thread.active', event => briefings.invalidate(event.thread.id)); bb.events.on('thread.failed', wake);
    bb.events.on('interaction.pending', event => { for (const session of sessions.forThread(event.thread.id)) { session.attention = true; changed(session); } });
    const warnCleanup = rateLimitedWarning(() => bb.log.warn('Voice trace retention cleanup failed'));
    const timer = setInterval(() => { try { traces.prune(); briefings.prune(); } catch { warnCleanup(); } for (const session of sessions.all()) if (Date.now() - session.touched > 60000) void end(session.id); }, 10000);
    timer.unref?.();
    bb.onDispose(async () => { clearInterval(timer); sessions.close(); await briefings.dispose(); await Promise.all(sessions.ids().map(id => end(id))); });
    const terminal = async ({ thread }: { thread: { id: string } }) => { briefings.forget(thread.id); await Promise.all(sessions.forThread(thread.id).map(session => end(session.id))); };
    bb.events.on('thread.archived', terminal); bb.events.on('thread.deleted', terminal);
  };
}

export default createPlugin();

import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { DelegationContext, DelegationReply } from './delegation';
import { WakeSignal } from './signals';
import type { createTraceStore } from './trace-store';
import { acceptsTrace, selectTrace, type Diagnostics, type TraceData } from '../shared/trace';

export type BackgroundMode = 'off' | 'cached';

export type Update = { seq: number; id: string; text: string; channel: 'speakable' | 'developer'; final: boolean };
export interface Job { id: string; abort: AbortController; signal: WakeSignal; reply: DelegationReply; finished: boolean; emitted: boolean; }
export interface Session {
  id: string; threadId: string; adapter: 'native' | 'delegated'; abort: AbortController; touched: number; startedAt: number; backgroundMode: BackgroundMode; title: string | null; diagnostics: Diagnostics; warn(): void;
  updates: Update[]; sequence: number; superseded: Set<string>; seen: Set<string>; job: Job | null; attention: boolean;
  context: DelegationContext; backgroundContext: string | null; ended: string | null;
  nativeSignal: WakeSignal; nativeCursor: number; nativeWorking: boolean; notifying: boolean;
}

export type SessionInit = Pick<Session, 'id' | 'threadId' | 'adapter' | 'backgroundMode' | 'title' | 'diagnostics' | 'warn' | 'nativeWorking'>;

export function newSession(init: SessionInit): Session {
  return { id: init.id, threadId: init.threadId, adapter: init.adapter, abort: new AbortController(), touched: Date.now(), startedAt: Date.now(), backgroundMode: init.backgroundMode, title: init.title, diagnostics: init.diagnostics, warn: init.warn, updates: [], sequence: 0, superseded: new Set(), seen: new Set(), job: null, attention: false, context: new DelegationContext(), backgroundContext: null, ended: null, nativeSignal: new WakeSignal(), nativeCursor: 0, nativeWorking: init.nativeWorking, notifying: false };
}

/** Session state changes that the Claude runner and native observer report back to the registry. */
export type SessionReporter = Pick<SessionRegistry, 'trace' | 'changed' | 'emit'>;
export type SessionRegistry = ReturnType<typeof createSessionRegistry>;

/**
 * Owns open voice sessions: lookup, server-side diagnostics, update delivery and ending.
 * Ending a session stops voice only; it never cancels the backing thread's work.
 */
export function createSessionRegistry(bb: Pick<BbPluginApi, 'realtime'>, traces: Pick<ReturnType<typeof createTraceStore>, 'write'>, stopNative: (threadId: string, sessionId: string) => Promise<unknown>) {
  const sessions = new Map<string, Session>();
  let traceSequence = 0;
  function trace(session: Session, name: string, data: TraceData | (() => TraceData) = {}): void {
    if (!acceptsTrace(name, session.diagnostics)) return;
    const selected = selectTrace(name, typeof data === 'function' ? data() : data, session.diagnostics);
    if (!selected) return;
    try { traces.write(session.id, 'server', [{ seq: ++traceSequence, at: Date.now(), elapsedMs: Math.max(0, Date.now() - session.startedAt), name, data: selected }]); }
    catch { session.warn(); }
  }
  function changed(session: Session): void {
    if (session.abort.signal.aborted || session.notifying) return;
    session.notifying = true;
    queueMicrotask(() => { session.notifying = false; if (!session.abort.signal.aborted) bb.realtime.publish('voice-changed', { sessionId: session.id }); });
  }
  function emit(session: Session, id: string, text: string, final = false, channel: Update['channel'] = 'speakable'): void {
    if (session.abort.signal.aborted) return;
    const first = session.job?.id === id && !session.job.emitted && !!text;
    if (session.job?.id === id && text) session.job.emitted = true;
    if (session.diagnostics === 'detailed' || first || final) trace(session, session.diagnostics === 'detailed' ? 'backing.update' : 'backing.milestone', () => ({ id, ...(session.diagnostics === 'detailed' ? { text: text.slice(0, 32000), truncated: text.length > 32000 } : {}), characters: text.length, final, channel, updateSeq: session.sequence + 1, state: final ? 'completed' : 'first-result' }));
    session.updates.push({ seq: ++session.sequence, id, text, final, channel });
    while (session.updates.length > 512 || session.updates.reduce((sum, update) => sum + update.text.length, 0) > 128000) session.updates.shift();
    changed(session);
  }
  async function end(id: string): Promise<boolean> {
    const session = sessions.get(id);
    if (!session) return false;
    trace(session, 'session.stop');
    sessions.delete(id); session.abort.abort(); session.job?.abort.abort();
    if (session.adapter === 'native') await stopNative(session.threadId, id).catch(() => {});
    return true;
  }
  function get(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw new Error('Voice session ended. Start voice again.');
    session.touched = Date.now(); return session;
  }
  return {
    trace, changed, emit, end, get,
    assertCanOpen(sessionId: string, threadId: string): void {
      if (sessions.has(sessionId) || [...sessions.values()].some(session => session.threadId === threadId)) throw new Error('This thread already has a Tandem call. End it first.');
      if (sessions.size >= 4) throw new Error('Four Tandem calls are already open. End a call first.');
    },
    add(session: Session): void { sessions.set(session.id, session); },
    all(): IterableIterator<Session> { return sessions.values(); },
    ids(): string[] { return [...sessions.keys()]; },
    forThread(threadId: string): Session[] { return [...sessions.values()].filter(session => session.threadId === threadId); },
  };
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { definePluginApp, experimental_usePluginId, useBbNavigate, useComposer, useRpc, useRealtime, useSdk } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';
import type { rpcContract } from '../shared/contract';
import { createPortal } from 'react-dom';
import { callAnchors, callUi } from './call-ui';
import { observePlayback } from './playback';
import { VoiceClient } from './voice-client';
import { SpokenConversation } from './spoken-conversation';
import { BrowserTrace } from './browser-trace';
import { supportsVoice } from '../shared/providers';
import { createVoiceThread, voiceCalls, voiceThreadRequest, type VoiceCall, type VoiceThread } from './voice-launch';
import './waveform.css';

const eventSchema = z.object({
  type: z.string(),
  item: z.object({ id: z.string().optional(), type: z.string().optional(), target: z.string().optional(), text: z.string().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() }).optional(),
  turn: z.object({ role: z.string().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

function Waveform({ state = 'idle' }: { state?: 'idle' | 'connecting' | 'listening' | 'speaking' | 'muted' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className="live-voice-waveform size-5" data-voice-state={state} aria-hidden="true"><path d="M4 10v4" /><path d="M9 5v14" /><path d="M14 8v8" /><path d="M19 10v4" /></svg>;
}

function Voice({ threadId, signal }: { threadId: string; signal: AbortSignal }) {
  const rpc = useRpc<typeof rpcContract>();
  const audio = useRef<HTMLAudioElement>(null);
  const client = useRef<VoiceClient | null>(null);
  const [status, setStatus] = useState<'closed' | 'connecting' | 'active'>('closed');
  const [message, setMessage] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const delivered = useRef(new Set<string>());
  const conversation = useRef(new SpokenConversation());
  const submissions = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send(): void }>());
  const adapter = useRef<'native' | 'delegated'>('delegated');
  const afterSeq = useRef(0);
  const diagnostics = useRef<BrowserTrace | null>(null);
  const replyText = useRef(new Map<string, string>());
  const synchronize = useRef<() => void>(() => {});
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);

  useEffect(() => {
    const stop = () => { client.current?.stop(); client.current = null; };
    window.addEventListener('pagehide', stop);
    signal.addEventListener('abort', stop);
    if (signal.aborted) stop();
    return () => { window.removeEventListener('pagehide', stop); signal.removeEventListener('abort', stop); stop(); };
  }, [threadId, signal]);

  const apply = (result: Awaited<ReturnType<typeof rpc.call<'poll'>>>, current: VoiceClient) => {
    if (client.current !== current) return;
    if (result.ended) { current.stop(result.ended); return; }
    for (const update of result.updates) {
      if (update.seq <= afterSeq.current) continue;
      if (diagnostics.current?.detailed || !delivered.current.has(update.id) || update.final) diagnostics.current?.record(diagnostics.current.detailed ? 'backing.received' : 'delivery.received', { id: update.id, updateSeq: update.seq, characters: update.text.length, final: update.final, channel: update.channel });
      delivered.current.add(update.id);
      if (update.text) {
        current.sendResult(update.id, update.text, update.channel, update.seq);
        if (update.channel === 'speakable') replyText.current.set(update.id, (replyText.current.get(update.id) ?? '') + update.text);
      }
      if (update.final) conversation.current.rememberBackendAnswer(replyText.current.get(update.id) ?? '');
      afterSeq.current = update.seq;
    }
  };
  synchronize.current = () => {
    const current = client.current;
    if (!current || status !== 'active') return;
    if (refreshing.current) { refreshAgain.current = true; return; }
    refreshing.current = true;
    void rpc.call('poll', { sessionId: current.sessionId, afterSeq: afterSeq.current }).then(result => apply(result, current)).catch(error => current.stop(error instanceof Error ? error.message : 'Voice session ended')).finally(() => { refreshing.current = false; if (refreshAgain.current) { refreshAgain.current = false; synchronize.current(); } });
  };
  useRealtime('voice-changed', payload => {
    if (typeof payload === 'object' && payload && 'sessionId' in payload && payload.sessionId === client.current?.sessionId) synchronize.current();
  });
  useEffect(() => { if (status === 'active') synchronize.current(); }, [status]);

  function start() {
    if (signal.aborted) return;
    if (!audio.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      setMessage('Voice needs microphone access in a supported browser over HTTPS.');
      return;
    }
    delivered.current.clear(); conversation.current = new SpokenConversation(); afterSeq.current = 0; replyText.current.clear();
    setMuted(false); setBlocked(false);
    let traceReady!: () => void;
    const ready = new Promise<void>(resolve => { traceReady = resolve; });
    const diagnostic = new BrowserTrace(async entries => {
      await ready;
      const result = await rpc.call('trace', { sessionId: next.sessionId, entries });
      if (!result.saved) throw new Error('Trace session unavailable');
    });
    diagnostics.current = diagnostic;
    const next = new VoiceClient({
      trace: diagnostic.record,
      diagnostics: () => diagnostic.detailed ? 'detailed' : 'basic',
      audio: audio.current,
      mediaDevices: navigator.mediaDevices,
      createPeer: () => new RTCPeerConnection(),
      state: (state, error) => {
        if (state === 'closed') { for (const pending of submissions.current.values()) clearTimeout(pending.timer); submissions.current.clear(); }
        setStatus(state); setMessage(error);
      },
      audioBlocked: () => setBlocked(true),
      request: async command => {
        if (command.action === 'start') { try { const result = await rpc.call('start', { threadId, sessionId: command.sessionId, sdp: command.sdp }); adapter.current = result.adapter; diagnostic.configure(result.diagnostics); return result; } finally { traceReady(); } }
        if (command.action === 'stop') { void diagnostic.flush(); await rpc.call('stop', { sessionId: command.sessionId }); }
        else apply(await rpc.call('poll', { sessionId: command.sessionId, afterSeq: afterSeq.current }), next);
        return { sdp: null };
      },
      event: value => {
        const parsed = eventSchema.safeParse(value);
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.type === 'error') { next.stop(event.error?.message ?? 'Voice connection failed'); return; }
        if (adapter.current === 'native') return;
        conversation.current.consume(value);
        if (event.type === 'turn.done' && event.turn?.role === 'user') {
          for (const pending of [...submissions.current.values()]) pending.send();
        }
        if (event.type === 'delegation.created' && event.item?.type === 'delegation' && event.item.target === 'client' && event.item.id) {
          const id = event.item.id;
          const text = event.item.content?.filter(part => part.type === 'input_text').map(part => part.text ?? '').join('\n').trim();
          if (!text) { next.sendResult(id, 'The delegation contained no request. Please ask again.'); return; }
          if (submissions.current.has(id)) return;
          const send = () => {
            const pending = submissions.current.get(id);
            if (!pending) return;
            clearTimeout(pending.timer);
            submissions.current.delete(id);
            void rpc.call('delegate', { sessionId: next.sessionId, id, text, turns: conversation.current.snapshot() }).catch(error => {
              next.sendResult(id, 'The backing request failed: ' + (error instanceof Error ? error.message : String(error)));
            });
          };
          submissions.current.set(id, { send, timer: setTimeout(send, 350) });
          if (conversation.current.userComplete) send();
        }
      },
    });
    client.current = next;
    void next.start().finally(traceReady);
  }

  useEffect(() => { start(); }, []);

  useEffect(() => {
    if (!audio.current) return;
    return observePlayback(audio.current, setSpeaking);
  }, []);
  useEffect(() => {
    if (signal.aborted) return;
    callUi.publish({
      status, muted, speaking, blocked, message,
      toggleMute: () => {
        if (signal.aborted) return;
        client.current?.mute(!muted);
        setMuted(!muted);
      },
      enableAudio: () => {
        if (signal.aborted) return;
        void audio.current?.play().then(() => setBlocked(false)).catch(() => setMessage('Allow browser audio playback to hear the call.'));
      },
      retry: start,
    });
  }, [status, muted, speaking, blocked, message, signal]);
  useEffect(() => () => callUi.publish(null), []);
  return <audio ref={audio} autoPlay />;
}

const controlClass = 'flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 hover:bg-muted';

function CallControls({ compact = false }: { compact?: boolean }) {
  const ui = useSyncExternalStore(callUi.subscribe, callUi.getSnapshot);
  const status = ui?.status ?? 'connecting';
  const buttonClass = compact ? controlClass.replace('size-11', 'size-9') : controlClass;
  const waveform = status === 'active' ? ui?.speaking ? 'speaking' : ui?.muted ? 'muted' : 'listening' : status === 'connecting' ? 'connecting' : 'idle';
  const label = status === 'connecting' ? 'Connecting voice…' : status === 'closed' ? 'Voice disconnected' : 'Voice connected';
  return <div className="relative flex shrink-0 items-center gap-1">
    <span role="status" aria-label={label} title={ui?.muted ? `${label} · Microphone muted` : label} className={`live-voice-trigger ${buttonClass.replace(' hover:bg-muted', '')} ${status === 'active' && (!ui?.muted || ui.speaking) ? 'text-primary' : 'text-muted-foreground'}`} data-voice-state={waveform} data-speaking={ui?.speaking || undefined}>
      <Waveform state={waveform} />
    </span>
    <div role="group" aria-label="Voice controls" className="live-voice-controls flex items-center gap-1">
      {status === 'closed' ? <button type="button" className={buttonClass} aria-label="Reconnect voice" title="Reconnect voice" onClick={ui?.retry}><Waveform /></button> : <button type="button" className={buttonClass} aria-label={ui?.muted ? 'Unmute microphone' : 'Mute microphone'} title={ui?.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={ui?.muted ?? false} disabled={!ui || status !== 'active'} onClick={ui?.toggleMute}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />{ui?.muted ? <path d="m3 3 18 18" /> : null}</svg>
      </button>}
      <button type="button" aria-label="End call" title="End call" onClick={voiceCalls.end} className={`live-voice-end ${buttonClass.replace(' hover:bg-muted', '')} bg-destructive text-white hover:opacity-90`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-5" aria-hidden="true"><path d="M4 15v-4c4-4 12-4 16 0v4h-5v-4M9 11v4H4" /></svg>
      </button>
    </div>
    {ui?.blocked ? <button type="button" className="rounded-md px-2 py-2 text-xs hover:bg-muted" onClick={ui.enableAudio}>Enable audio</button> : null}
    {ui?.message ? <span role="alert" className="absolute bottom-full right-0 mb-16 w-64 rounded-xl border bg-background p-3 text-xs shadow-lg">{ui.message}</span> : null}
  </div>;
}

function VoiceAction() {
  const composer = useComposer();
  const { scope } = composer;
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { call } = useSyncExternalStore(voiceCalls.subscribe, voiceCalls.getSnapshot);
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  const [available, setAvailable] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setAvailable(null);
    if (threadId) void rpc.call('available', { threadId }).then(result => { if (!disposed && result.available) setAvailable(threadId); }).catch(() => {});
    return () => { disposed = true; };
  }, [threadId, rpc]);
  const newThread = scope.kind === 'new-thread';
  const ownsCall = call && (threadId
    ? (call.thread?.id ?? call.target.threadId) === threadId
    : !call.thread && call.target.key === composer.key);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ownsCall && anchor.current) return callAnchors.observe(call.id, anchor.current);
  }, [ownsCall, call?.id]);
  const launch = () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      setMessage('Voice needs microphone access in a supported browser over HTTPS.'); return;
    }
    setMessage(null);
    if (threadId) {
      voiceCalls.request({ key: threadId, threadId, title: 'this thread', prepare: async signal => sdk.threads.get({ threadId, signal }) });
      return;
    }
    try {
      // Snapshot only picker settings. Starting voice neither reads nor submits the draft.
      const selection = voiceThreadRequest(composer.selection);
      voiceCalls.request({ key: composer.key, title: 'a new thread', prepare: (signal, created) => createVoiceThread(sdk.threads, selection, signal, thread => {
        created(thread);
        if (!signal.aborted) navigate.toThread(thread.id);
      }) });
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  if (ownsCall) return <div ref={anchor}><CallControls compact /></div>;
  if (!newThread && (!threadId || available !== threadId)) return null;
  if (newThread && !supportsVoice(composer.selection?.providerId)) return null;
  const label = call ? 'Switch Tandem to this thread' : newThread ? 'Start Tandem in a new thread' : 'Start Tandem';
  return <div className="flex items-center gap-1">
    <button type="button" aria-label={label} title={label} onClick={launch} className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"><Waveform /></button>
    {message ? <span role="alert" className="max-w-64 text-xs">{message}</span> : null}
  </div>;
}

function CallSession({ call }: { call: VoiceCall }) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const { pending } = useSyncExternalStore(voiceCalls.subscribe, voiceCalls.getSnapshot);
  const visibleAnchors = useSyncExternalStore(callAnchors.subscribe, callAnchors.getSnapshot);
  const [thread, setThread] = useState<VoiceThread | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void call.ready.then(result => { if (!disposed && !call.controller.signal.aborted) setThread(result); }).catch(error => {
      if (!disposed && !call.controller.signal.aborted) setMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { disposed = true; };
  }, [call]);
  const destination = thread ?? call.thread;
  const title = destination?.title ?? destination?.titleFallback ?? (destination ? 'Voice conversation' : call.target.title);
  const onThread = visibleAnchors.has(call.id);
  return <>
    {thread ? <Voice threadId={thread.id} signal={call.controller.signal} /> : null}
    {createPortal(<div data-bb-plugin-root="" data-bb-plugin={pluginId} style={{ display: 'contents', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {!onThread ? <section aria-label="Live voice call" className="pointer-events-auto fixed bottom-5 right-5 z-[60] flex max-w-[calc(100%-2.5rem)] items-center gap-2 rounded-full border bg-background p-1 shadow-lg" style={{ pointerEvents: 'auto', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {destination ? <button type="button" className="max-w-40 truncate rounded-full px-3 py-2 text-xs font-medium hover:bg-muted" title="Open voice thread" onClick={() => navigate.toThread(destination.id)}>{title}</button> : null}
        <CallControls />
      </section> : null}
      {!thread && message ? <div role="alert" className="pointer-events-auto fixed bottom-20 right-5 z-[60] max-w-80 rounded-xl border bg-background p-3 text-xs shadow-lg">{message}</div> : null}
      {pending ? <div role="group" aria-label="Switch voice thread" className="pointer-events-auto fixed bottom-24 right-5 z-[60] max-w-80 rounded-xl border bg-background p-3 text-xs shadow-lg">
        <p>End this call and start voice in {pending.title}? Agent work will continue.</p>
        <button type="button" className="rounded-md px-2 py-2 hover:bg-muted" onClick={voiceCalls.switchCall}>Switch call</button>
        <button type="button" className="rounded-md px-2 py-2 hover:bg-muted" onClick={voiceCalls.dismissSwitch}>Keep this call</button>
      </div> : null}
    </div>, document.body)}
  </>;
}

function VoiceOverlay() {
  const { call } = useSyncExternalStore(voiceCalls.subscribe, voiceCalls.getSnapshot);
  useEffect(() => {
    window.addEventListener('pagehide', voiceCalls.end);
    return () => { window.removeEventListener('pagehide', voiceCalls.end); voiceCalls.end(); };
  }, []);
  return call ? <CallSession key={call.id} call={call} /> : null;
}

export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: 'live-voice-call', component: VoiceOverlay });
  app.composer.customize({ id: 'live-voice', scopes: ['thread', 'new-thread'], actions: [{ id: 'live-voice', component: VoiceAction }] });
});

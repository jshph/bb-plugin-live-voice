import type { ComposerSelection, PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';

export type VoiceThread = { id: string; title: string | null; titleFallback?: string | null };
type Threads = Pick<PluginBrowserBbSdk['threads'], 'spawn' | 'get'>;

export function voiceThreadRequest(selection: ComposerSelection | null) {
  if (!selection?.projectId || !selection.environment || !selection.providerId || !selection.model || !selection.permissionMode) {
    throw new Error('Choose a project, environment, provider and model before starting voice.');
  }
  if (!supportsVoice(selection.providerId)) throw new Error('Tandem supports Codex and Claude threads.');
  return { ...selection, projectId: selection.projectId, environment: selection.environment, providerId: selection.providerId, input: [], title: 'Voice conversation' };
}

export function supportsVoice(providerId: string | undefined): boolean {
  return providerId !== undefined && ['codex', 'claude-code', 'claude'].includes(providerId);
}

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function createVoiceThread(threads: Threads, selection: ComposerSelection | null, signal: AbortSignal, created: (thread: VoiceThread) => void): Promise<VoiceThread> {
  signal.throwIfAborted();
  let thread;
  try {
    thread = await threads.spawn(voiceThreadRequest(selection));
  } catch (error) {
    if (error instanceof Error && error.message.includes('input must contain at least one entry')) {
      throw new Error('This BB version requires a first message to create a thread. Starting voice from New thread needs a BB update. You can start voice in an existing thread.');
    }
    throw error;
  }
  signal.throwIfAborted();
  created(thread);
  const deadline = Date.now() + 120000;
  // Empty input initializes the selected provider without submitting a task.
  // Wait for that initialization before asking its existing connection for voice.
  while (true) {
    if (thread.status === 'error' || thread.deletedAt || thread.archivedAt) throw new Error('The voice thread could not start. Open it to check its setup, then start voice there.');
    if (thread.status === 'idle' && thread.environmentId) return thread;
    if (Date.now() >= deadline) throw new Error('The thread is still preparing. Check its setup or approvals, then start voice there.');
    await wait(signal);
    thread = await threads.get({ threadId: thread.id, signal });
    signal.throwIfAborted();
  }
}

export type VoiceTarget = {
  key: string;
  title: string;
  threadId?: string;
  prepare(signal: AbortSignal, created: (thread: VoiceThread) => void): Promise<VoiceThread>;
};
export type VoiceCall = {
  id: number;
  target: VoiceTarget;
  controller: AbortController;
  ready: Promise<VoiceThread>;
  thread: VoiceThread | null;
};

/** One call per app window. The launch promise outlives composer remounts. */
export class VoiceCalls {
  private nextId = 0;
  private state: { call: VoiceCall | null; pending: VoiceTarget | null } = { call: null, pending: null };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.state = { ...this.state }; for (const listener of this.listeners) listener(); }

  request(target: VoiceTarget): void {
    const current = this.state.call;
    if (current) {
      const same = target.threadId
        ? (current.thread?.id ?? current.target.threadId) === target.threadId
        : !current.thread && current.target.key === target.key;
      if (!same) {
        this.state.pending = target; this.publish();
      }
      return;
    }
    const controller = new AbortController();
    const call: VoiceCall = {
      id: ++this.nextId, target, controller, thread: null,
      ready: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return target.prepare(controller.signal, thread => {
          if (this.state.call !== call || controller.signal.aborted) return;
          call.thread = thread; this.publish();
        }).then(thread => {
          if (this.state.call === call && !controller.signal.aborted) { call.thread = thread; this.publish(); }
          return thread;
        });
      }),
    };
    // The overlay presents the error. Attaching this now also covers a closed window.
    void call.ready.catch(() => {});
    this.state = { call, pending: null }; this.publish();
  }
  dismissSwitch = () => { this.state.pending = null; this.publish(); };
  switchCall = () => { const target = this.state.pending; if (!target) return; this.end(); this.request(target); };
  end = () => {
    this.state.call?.controller.abort();
    this.state = { call: null, pending: null }; this.publish();
  };
}

export const voiceCalls = new VoiceCalls();

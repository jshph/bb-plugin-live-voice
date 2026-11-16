import { beforeEach, expect, it, vi } from 'vitest';
import manifest from '../../../package.json';
import { synthesizeBriefing } from './synthesize';

const wire = vi.hoisted(() => ({ account: 'chatgpt', item: 'userMessage', disconnect: false, pending: false, calls: [] as string[], initialize: undefined as unknown }));
vi.mock('../codex-app-server', async original => {
  const actual = await original<typeof import('../codex-app-server')>();
  return { ...actual, CodexConnection: class {
    constructor(private notification: (method: string, params: unknown) => void, _command: string, private disconnected: (error: Error) => void) {}
    async request(method: string, params?: unknown) {
      wire.calls.push(method);
      if (method === 'initialize') wire.initialize = params;
      if (method === 'account/read') return { account: { type: wire.account } };
      if (method === 'thread/start') return { thread: { id: 'compiler' } };
      if (method === 'turn/start') queueMicrotask(() => {
        if (wire.disconnect) { this.disconnected(new Error('connection lost')); return; }
        if (wire.pending) return;
        this.notification('item/started', { threadId: 'compiler', item: { type: wire.item } });
        this.notification('item/completed', { threadId: 'compiler', item: { type: 'agentMessage', text: JSON.stringify({ subject: 'Voice', goals: [], decisions: [], findings: [{ fact: 'Build passed', evidence: [1] }], openQuestions: [] }) } });
        this.notification('turn/completed', { threadId: 'compiler', turn: { status: 'completed' } });
      });
      return {};
    }
    async close() { wire.calls.push('close'); }
  } };
});
const source = { revision: 'revision', title: 'Voice', bounded: true as const, items: [{ seq: 1, kind: 'tool-result', text: 'Build passed', shortened: false }] };
beforeEach(() => { Object.assign(wire, { account: 'chatgpt', item: 'userMessage', disconnect: false, pending: false, calls: [] }); });
it('accepts normal input items and archives the isolated compiler session', async () => {
  expect(JSON.parse(await synthesizeBriefing(source, 'codex', new AbortController().signal)).findings[0].fact).toBe('Build passed');
  expect(wire.calls).toContain('thread/archive');
  expect(wire.initialize).toMatchObject({ clientInfo: { name: 'bb-voice-briefing', version: manifest.version } });
});
it('rejects observed tool execution even if a final answer also arrives', async () => {
  wire.item = 'commandExecution';
  await expect(synthesizeBriefing(source, 'codex', new AbortController().signal)).rejects.toThrow('attempted tool work');
});
it('rejects API authentication before starting a compiler thread', async () => {
  wire.account = 'apiKey';
  await expect(synthesizeBriefing(source, 'codex', new AbortController().signal)).rejects.toThrow('API keys are not supported');
  expect(wire.calls).not.toContain('thread/start');
});
it('fails promptly on disconnect instead of waiting for the synthesis deadline', async () => {
  wire.disconnect = true;
  await expect(synthesizeBriefing(source, 'codex', new AbortController().signal)).rejects.toThrow('connection lost');
});
it('cancels an in-progress compiler without leaving a pending turn', async () => {
  wire.pending = true;
  const abort = new AbortController();
  const job = synthesizeBriefing(source, 'codex', abort.signal);
  const assertion = expect(job).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(wire.calls).toContain('turn/start'));
  abort.abort();
  await assertion;
  expect(wire.calls).toContain('close');
});

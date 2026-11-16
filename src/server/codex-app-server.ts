import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { version } from '../../package.json';

/** Identifies Tandem to the Codex app-server, using the plugin manifest's version. */
export function clientInfo(name: 'bb-live-voice' | 'bb-voice-briefing') { return { name, version }; }

const frame = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });

export class CodexConnection {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  constructor(private notification: (method: string, params: unknown) => void, command = 'codex', private disconnected?: (error: Error) => void) {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    this.child = spawn(command, ['app-server'], { env, stdio: 'pipe' });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { return; }
      const parsed = frame.safeParse(value);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.method && message.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Voice transport does not execute coding requests' } }) + '\n');
      } else if (message.method) {
        this.notification(message.method, message.params);
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    const fail = () => {
      if (this.closed) return;
      this.closed = true;
      const error = new Error('Codex app-server disconnected. Check Codex installation and ChatGPT sign-in on the BB server.');
      lines.close();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.disconnected?.(error);
    };
    this.child.on('error', fail);
    this.child.on('exit', fail);
    this.child.stdin.on('error', fail);
  }
  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export function requireSubscriptionAccount(value: unknown): void {
  const result = z.object({ account: z.object({ type: z.string() }).nullable().optional() }).safeParse(value);
  if (!result.success || result.data.account?.type !== 'chatgpt') throw new Error('Tandem requires Codex signed in with ChatGPT on the BB server. Run codex login there; API keys are not supported.');
}

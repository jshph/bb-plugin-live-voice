import { z } from 'zod';
import { normalized, type SpokenTurn } from '../shared/conversation';

const transcriptEvent = z.object({
  type: z.string(),
  item: z.object({ text: z.string().optional() }).optional(),
  turn: z.object({ role: z.enum(['user', 'assistant']).optional(), transcript: z.string().optional() }).optional(),
});

export class SpokenConversation {
  private next = 0;
  private turns: SpokenTurn[] = [];
  private active = new Map<SpokenTurn['role'], SpokenTurn>();
  private backendAnswers = new Set<string>();

  rememberBackendAnswer(text: string): void {
    this.backendAnswers.add(normalized(text));
  }

  consume(value: unknown): void {
    const parsed = transcriptEvent.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    const role = event.type === 'input_transcript.added' ? 'user' : event.type === 'output_transcript.added' ? 'assistant' : event.turn?.role;
    if (!role) return;
    if (event.type !== 'input_transcript.added' && event.type !== 'output_transcript.added' && event.type !== 'turn.done') return;
    let turn = this.active.get(role);
    if (!turn) {
      turn = { seq: ++this.next, role, text: '', complete: false };
      this.turns.push(turn);
      this.active.set(role, turn);
    }
    if (event.type === 'turn.done') {
      if (event.turn?.transcript !== undefined) turn.text = event.turn.transcript;
      turn.complete = true;
      this.active.delete(role);
    } else turn.text += event.item?.text ?? '';
    if (turn.text.length > 16000) { turn.text = turn.text.slice(-16000); turn.truncated = true; }
    while (this.turns.length > 100) {
      const index = this.turns.findIndex(candidate => ![...this.active.values()].includes(candidate));
      if (index < 0) break;
      this.turns.splice(index, 1);
    }
  }

  get userComplete(): boolean { return !this.active.has('user'); }

  snapshot(): SpokenTurn[] {
    const result: SpokenTurn[] = [];
    let remaining = 16000;
    for (const turn of [...this.turns].reverse()) {
      if (!turn.text.trim()) continue;
      if (turn.role === 'assistant' && turn.complete && this.backendAnswers.has(normalized(turn.text))) continue;
      if (remaining <= 0) break;
      const text = turn.text.slice(-remaining);
      result.unshift({ ...turn, text, truncated: turn.truncated || text.length < turn.text.length });
      remaining -= text.length;
    }
    return result;
  }
}

import { describe, expect, it } from 'vitest';
import { SpokenConversation } from './conversation';

const delta = (role: 'user' | 'assistant', text: string) => ({ type: role === 'user' ? 'input_transcript.added' : 'output_transcript.added', item: { text } });
const done = (role: 'user' | 'assistant', transcript?: string) => ({ type: 'turn.done', turn: { role, ...(transcript === undefined ? {} : { transcript }) } });

describe('spoken conversation', () => {
  it('assembles overlapping speaker fragments into separate turns', () => {
    const conversation = new SpokenConversation();
    conversation.consume(delta('user', 'What is going on'));
    conversation.consume(delta('assistant', 'I can'));
    conversation.consume(delta('user', ' here?'));
    conversation.consume(delta('assistant', ' look.'));
    conversation.consume(done('user'));
    conversation.consume(done('assistant'));
    expect(conversation.snapshot()).toMatchObject([
      { seq: 1, role: 'user', text: 'What is going on here?', complete: true },
      { seq: 2, role: 'assistant', text: 'I can look.', complete: true },
    ]);
    expect(conversation.userComplete).toBe(true);
  });
  it('uses the completed transcript as the authoritative wording', () => {
    const conversation = new SpokenConversation();
    conversation.consume(delta('user', 'Delete this'));
    expect(conversation.userComplete).toBe(false);
    conversation.consume(done('user', 'Read this.'));
    expect(conversation.snapshot()[0]).toMatchObject({ text: 'Read this.', complete: true });
  });
  it('omits exact echoes of backend answers while keeping paraphrases for context', () => {
    const conversation = new SpokenConversation();
    conversation.rememberBackendAnswer('Slate Nine is approved.');
    conversation.consume(delta('assistant', 'Slate nine is approved!'));
    conversation.consume(done('assistant'));
    expect(conversation.snapshot()).toEqual([]);
    conversation.consume(delta('assistant', 'The approved project is Slate Nine.'));
    conversation.consume(done('assistant'));
    expect(conversation.snapshot()).toHaveLength(1);
  });
  it('bounds snapshots and marks omitted words', () => {
    const conversation = new SpokenConversation();
    conversation.consume(delta('user', 'x'.repeat(20000)));
    const snapshot = conversation.snapshot();
    expect(snapshot[0]?.text.length).toBe(16000);
    expect(snapshot[0]?.truncated).toBe(true);
  });
});

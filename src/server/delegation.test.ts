import { describe, expect, it } from 'vitest';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { DelegationReply, DelegationContext } from './delegation';
import { backendInstructions } from './prompts';

type Row = Awaited<ReturnType<BbPluginApi['sdk']['threads']['events']['list']>>[number];
function row(type: string, turnId: string, data: unknown): Row {
  return { id: 'event', threadId: 'thread', scope: { kind: 'turn', turnId }, seq: 1, createdAt: 0, type, data } as Row;
}
const user = (turn: string, text: string) => row('item/completed', turn, { item: { id: 'user', type: 'userMessage', content: [{ type: 'text', text }] } });
const agent = (turn: string, text: string, parentToolCallId?: string) => row('item/completed', turn, { item: { id: 'agent', type: 'agentMessage', text, parentToolCallId } });

describe('delegated replies', () => {
  it('ignores old answers and unrelated concurrent turns', () => {
    const reply = new DelegationReply('marker');
    reply.consume(agent('old', 'stale'));
    reply.consume(user('wanted', 'request marker'));
    reply.consume(agent('other', 'unrelated'));
    reply.consume(agent('wanted', 'correct'));
    reply.consume(agent('wanted', 'nested tool result', 'tool'));
    reply.consume(row('turn/completed', 'other', { status: 'completed' }));
    expect(reply.done).toBe(false);
    reply.consume(row('turn/completed', 'wanted', { status: 'completed' }));
    expect(reply.text).toBe('correct');
    expect(reply.done).toBe(true);
  });
  it('matches BB request and acceptance events when no userMessage is emitted', () => {
    const reply = new DelegationReply('marker');
    reply.consume(row('client/turn/requested', 'none', { requestId: 'req', input: [{ type: 'text', text: 'marker' }] }));
    reply.consume(row('turn/input/accepted', 'wrong', { clientRequestId: 'other' }));
    reply.consume(agent('wrong', 'stale'));
    expect(reply.turnId).toBeNull();
    reply.consume(row('turn/input/accepted', 'wanted', { clientRequestId: 'req' }));
    reply.consume(agent('wanted', 'verified result'));
    reply.consume(row('turn/completed', 'wanted', { status: 'completed' }));
    expect(reply.done).toBe(true);
    expect(reply.text).toBe('verified result');
  });
  it('does not present an interrupted turn as successful', () => {
    const reply = new DelegationReply('marker');
    reply.consume(user('wanted', 'marker'));
    reply.consume(agent('wanted', 'planning an action'));
    reply.consume(row('turn/completed', 'wanted', { status: 'interrupted' }));
    expect(reply.error).toContain('No successful result was confirmed');
  });
});


describe('voice context delivery', () => {
  const turn = (seq: number, role: 'user' | 'assistant', text: string, complete = true) => ({ seq, role, text, complete });
  const texts = (input: ReturnType<DelegationContext['prepare']>['input']) => input.filter(part => part.type === 'text').map(part => part.text).join('\n');

  it('shows spoken words and hides instructions, context and a distinct delegation task', () => {
    const context = new DelegationContext();
    const prepared = context.prepare('marker', 'Read the inbox note', [turn(1, 'assistant', 'Which note?'), turn(2, 'user', 'The newest one, please.')]);
    expect(prepared.input[0]).toMatchObject({ type: 'text', text: 'The newest one, please.' });
    expect(prepared.input[0]).not.toHaveProperty('visibility');
    expect(prepared.input[1]).toMatchObject({ visibility: 'agent-only' });
    expect(texts(prepared.input)).toContain('Delegated task from the voice model');
    expect(texts(prepared.input).match(/The newest one, please\./g)).toHaveLength(1);
  });
  it('sends instructions once and only new turns after provider acceptance', () => {
    const context = new DelegationContext();
    const first = context.prepare('first', 'Open the note', [turn(1, 'user', 'Open the note')]);
    expect(texts(first.input)).toContain(backendInstructions);
    first.accept();
    const second = context.prepare('second', 'Delete the note', [turn(1, 'user', 'Open the note'), turn(2, 'assistant', 'I found the note.'), turn(3, 'user', 'Delete it please')]);
    expect(texts(second.input)).not.toContain(backendInstructions);
    expect(texts(second.input)).not.toContain('Open the note');
    expect(texts(second.input)).toContain('I found the note.');
    expect(texts(second.input)).toContain('not independent evidence');
  });
  it('retains instructions and context when a submission was not accepted', () => {
    const context = new DelegationContext();
    const turns = [turn(1, 'user', 'Check this')];
    context.prepare('failed', 'Check this', turns);
    const retry = context.prepare('retry', 'Check this', turns);
    expect(texts(retry.input)).toContain(backendInstructions);
    expect(retry.input[0]).toMatchObject({ text: 'Check this' });
  });
  it('does not repeat the current request as a delegated task when wording matches', () => {
    const prepared = new DelegationContext().prepare('marker', 'check the note', [turn(1, 'user', 'Check the note.')]);
    expect(texts(prepared.input)).not.toContain('Delegated task from the voice model');
  });
  it('preserves additions and corrections to an accepted partial transcript', () => {
    const context = new DelegationContext();
    context.prepare('first', 'Read this', [turn(1, 'user', 'Read', false)]).accept();
    const next = context.prepare('second', 'Read the note', [turn(1, 'user', 'Read the note')]);
    expect(next.input[0]).toMatchObject({ text: 'Spoken continuation:\n the note' });
    next.accept();
    const correction = context.prepare('third', 'Read the quote', [turn(1, 'user', 'Read the quote')]);
    expect(correction.input[0]).toMatchObject({ text: 'Spoken correction:\nRead the quote' });
  });
});

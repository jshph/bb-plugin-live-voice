import { describe, expect, it, vi } from 'vitest';
import type { TraceEntry } from '../shared/trace';
import { BrowserTrace, describeVoiceEvent } from './browser-trace';

describe('browser diagnostic tracing', () => {
  it('selects transcript/turn data without recording audio, SDP, credentials or unrelated payloads', () => {
    expect(describeVoiceEvent({ type: 'output_audio.delta', delta: 'audio bytes' })).toBeNull();
    expect(describeVoiceEvent({ type: 'session.created', sdp: 'secret' })).toBeNull();
    expect(describeVoiceEvent({ type: 'turn.done', turn: { role: 'user', id: 'turn' }, token: 'secret', sdp: 'secret' })).toEqual({ type: 'turn.done', role: 'user', id: 'turn' });
    expect(describeVoiceEvent({ type: 'output_transcript.added', item: { text: 'hello', id: 'speech' }, audio: 'bytes' }, 'detailed')).toEqual({ type: 'output_transcript.added', id: 'speech', text: 'hello', characters: 5, truncated: false });
    expect(describeVoiceEvent({ type: 'input_transcript.added', item: { text: 'x'.repeat(33000) } }, 'detailed')).toMatchObject({ characters: 33000, truncated: true, text: 'x'.repeat(32000) });
  });
  it('flushes ordered batches and marks failed batches with sequence gaps instead of blocking later delivery', async () => {
    const batches: TraceEntry[][] = [];
    const send = vi.fn(async (entries: TraceEntry[]) => { batches.push(entries); if (batches.length === 1) throw new Error('offline'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const trace = new BrowserTrace(send); trace.configure('detailed');
      for (let i = 0; i < 55; i++) trace.record('turn', { id: String(i) });
      await trace.flush();
      expect(batches.map(batch => batch.length)).toEqual([50, 5]);
      expect(batches[1]![0]!.seq).toBe(51);
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });
  it('basic browser diagnostics omit text and skip detailed payload construction before sending', async () => {
    const batches: TraceEntry[][] = [];
    const trace = new BrowserTrace(async entries => { batches.push(entries); });
    const expensive = vi.fn(() => ({ text: 'private result' }));
    for (let i = 0; i < 300; i++) trace.record('native.backing.delta', expensive);
    trace.record('context.sent', { text: 'private background', bytes: 18 });
    trace.record('adapter.selected', { state: 'native' });
    trace.record('realtime.received', { type: 'session.context.appended' });
    trace.record('realtime.received', { type: 'output_transcript.delta', text: 'private transcript' });
    trace.record('realtime.received', { type: 'turn.done', role: 'user', text: 'private words' });
    await trace.flush();
    expect(expensive).not.toHaveBeenCalled();
    expect(batches.flat().map(row => row.name)).toEqual(['context.sent', 'realtime.received']);
    expect(JSON.stringify(batches)).not.toContain('private');
    expect(describeVoiceEvent({ type: 'output_transcript.added', item: { text: 'private words' } })).toBeNull();
    expect(describeVoiceEvent({ type: 'session.context.appended' }, 'detailed')).toBeNull();
  });
  it('detailed browser diagnostics retain exact chunks when explicitly enabled', async () => {
    const batches: TraceEntry[][] = [];
    const trace = new BrowserTrace(async entries => { batches.push(entries); });
    trace.configure('detailed');
    trace.record('delegation.sent', () => ({ text: 'Exact α chunk', bytes: 14, updateSeq: 8 }));
    await trace.flush();
    expect(batches.flat()[0]?.data).toEqual({ text: 'Exact α chunk', bytes: 14, updateSeq: 8 });
  });
  it('rate-limits storage warnings while continuing later batches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trace = new BrowserTrace(async () => { throw new Error('storage offline'); });
    try {
      for (let i = 0; i < 4; i++) { trace.record('client.start'); await trace.flush(); }
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });
});

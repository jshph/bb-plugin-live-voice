import { describe, expect, it, vi } from 'vitest';
import { utf8Chunks, VoiceClient } from './voice-client';
import type { TraceData } from '../shared/trace';

function fixture() {
  const sent: Record<string, unknown>[] = [];
  const traces: { name: string; data?: TraceData }[] = [];
  const channel = { readyState: 'open', onmessage: null as null | ((event: { data: string }) => void), send: (text: string) => sent.push(JSON.parse(text)), close: vi.fn() };
  const track = { enabled: true, onended: null, stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const peer = { addTrack: vi.fn(), createDataChannel: () => channel, createOffer: async () => ({ type: 'offer', sdp: 'offer' }), setLocalDescription: async () => {}, localDescription: { sdp: 'offer' }, setRemoteDescription: async () => {}, close: vi.fn() };
  const request = vi.fn(async () => ({ sdp: 'answer' }));
  const audio = { play: async () => {}, pause: vi.fn(), srcObject: null };
  const client = new VoiceClient({ diagnostics: () => 'detailed', trace: (name, data) => traces.push({ name, data: typeof data === 'function' ? data() : data }), audio: audio as unknown as HTMLAudioElement, mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream }, createPeer: () => peer as unknown as RTCPeerConnection, request, state: vi.fn(), audioBlocked: vi.fn() });
  const event = (value: unknown) => channel.onmessage?.({ data: JSON.stringify(value) });
  return { client, channel, sent, track, request, event, traces };
}

describe('browser voice lifecycle', () => {
  it('never appends background context mid-call while still observing turn boundaries', async () => {
    const { client, sent, event, traces } = fixture();
    try {
      await client.start();
      expect('addBackgroundContext' in client).toBe(false);
      event({ type: 'turn.done', turn: { role: 'assistant' } });
      event({ type: 'session.context.appended' });
      event({ type: 'input_transcript.added', item: { text: 'question' } });
      event({ type: 'turn.done', turn: { role: 'user' } });
      event({ type: 'turn.done', turn: { role: 'assistant' } });
      expect(sent.some(message => message.type === 'session.context.append')).toBe(false);
      expect(traces.some(trace => /^context\./.test(trace.name))).toBe(false);
      expect(traces.some(trace => trace.name === 'realtime.received' && trace.data?.role === 'user')).toBe(true);
    } finally { client.stop(); }
  });
  it('releases microphone and transport once and drops late delegation answers', async () => {
    const { client, channel, track, request, sent } = fixture();
    await client.start();
    client.stop(); client.stop();
    client.sendResult('id', 'late response');
    expect(sent).toHaveLength(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(request.mock.calls).toHaveLength(2);
  });
});

it('chunks Unicode handoffs without splitting code points', () => {
  const text = 'a🙂é界'.repeat(250);
  const chunks = utf8Chunks(text);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 500)).toBe(true);
});

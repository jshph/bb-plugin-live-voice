import { failureReason, type Diagnostics } from '../shared/trace';
import { describeVoiceEvent, type TraceSink } from './browser-trace';

export type VoiceRequest =
  | { action: "start"; sessionId: string; sdp: string }
  | { action: "keepAlive"; sessionId: string }
  | { action: "stop"; sessionId: string };

export interface VoiceClientOptions {
  request(command: VoiceRequest): Promise<{ sdp: string | null }>;
  audio: HTMLAudioElement;
  mediaDevices: Pick<MediaDevices, "getUserMedia">;
  createPeer(): RTCPeerConnection;
  state(
    status: "connecting" | "active" | "closed",
    message: string | null,
  ): void;
  audioBlocked(): void;
  trace?: TraceSink;
  diagnostics?(): Diagnostics;
  event?(value: unknown): void;
}

export class VoiceClient {
  readonly sessionId = crypto.randomUUID();
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private stopped = false;
  private channel: RTCDataChannel | null = null;
  private requested = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private heartbeatPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: VoiceClientOptions) {}

  async start(): Promise<void> {
    this.options.trace?.("client.start");
    this.options.state("connecting", null);
    this.timer = setTimeout(
      () => this.stop("Voice connection timed out. Try again."),
      45000,
    );
    try {
      const stream = await this.options.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.options.trace?.("microphone.acquired");
      this.stream = stream;
      const peer = this.options.createPeer();
      this.peer = peer;
      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
        track.onended = () =>
          this.stop("Microphone disconnected. Start voice again to reconnect.");
      });
      peer.ontrack = (event) => {
        if (this.stopped) return;
        this.options.trace?.("audio.track.received");
        this.options.audio.srcObject = new MediaStream([event.track]);
        void this.options.audio.play().then(() => this.options.trace?.("audio.play.started")).catch(() => { this.options.trace?.("audio.play.blocked"); this.options.audioBlocked(); });
      };
      peer.onconnectionstatechange = () => {
        if (this.stopped) return;
        this.options.trace?.("peer.state", { state: peer.connectionState });
        if (peer.connectionState === "connected") {
          clearTimeout(this.timer);
          clearTimeout(this.disconnectTimer);
          this.options.state("active", null);
        }
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "closed"
        )
          this.stop("Voice connection ended. Start voice again to reconnect.");
        if (peer.connectionState === "disconnected") {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = setTimeout(
            () => this.stop("Voice connection was lost."),
            10000,
          );
        }
      };
      this.channel = peer.createDataChannel("oai-events");
      this.channel.onopen = () => this.options.trace?.("datachannel.open");
      this.channel.onmessage = (event) => {
        if (this.stopped) return;
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          return;
        }
        const diagnostic = this.options.trace ? describeVoiceEvent(value, this.options.diagnostics?.() ?? 'basic') : null;
        if (diagnostic) this.options.trace?.("realtime.received", diagnostic);
        this.options.event?.(value);
      };
      const offer = await peer.createOffer();
      if (this.stopped) return;
      await peer.setLocalDescription(offer);
      if (this.stopped) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Could not create a voice connection");
      this.requested = true;
      const answer = await this.options.request({
        action: "start",
        sessionId: this.sessionId,
        sdp,
      });
      if (this.stopped) return;
      if (!answer.sdp)
        throw new Error("Codex did not return a voice connection");
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      if (this.stopped) return;
      this.heartbeat = setInterval(() => {
        if (this.heartbeatPending) return;
        this.heartbeatPending = true;
        void this.options
          .request({ action: "keepAlive", sessionId: this.sessionId })
          .catch(() =>
            this.stop(
              "Voice session was lost. Start voice again to reconnect.",
            ),
          )
          .finally(() => {
            this.heartbeatPending = false;
          });
      }, 15000);
    } catch (error) {
      if (!this.stopped)
        this.stop(
          error instanceof Error ? error.message : "Could not start voice chat",
        );
    }
  }

  sendResult(id: string, text: string, channel: 'speakable' | 'developer' = 'speakable', updateSeq?: number): void {
    if (this.stopped || this.channel?.readyState !== 'open') { this.options.trace?.("delegation.unsent", { id, characters: text.length, state: this.channel?.readyState ?? "absent" }); return; }
    for (const chunk of utf8Chunks(text)) {
      this.channel.send(JSON.stringify({ type: 'delegation.context.append', delegation_item_id: id, channel, content: [{ type: 'input_text', text: chunk }] }));
      this.options.trace?.('delegation.sent', () => ({ id, channel, updateSeq, text: chunk, bytes: new TextEncoder().encode(chunk).length }));
    }
  }

  mute(muted: boolean): void {
    this.options.trace?.("microphone.mute", { state: muted ? "muted" : "unmuted" });
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  stop(message: string | null = null): void {
    if (this.stopped) return;
    this.options.trace?.("client.stop", () => ({ reason: message ? failureReason(message) : "ended", ...(this.options.diagnostics?.() === "detailed" && message ? { text: message.slice(0, 32000) } : {}) }));
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.disconnectTimer);
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = null;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
      this.peer = null;
    }
    this.options.audio.pause();
    this.options.audio.srcObject = null;
    this.options.state("closed", message);
    if (this.requested)
      void this.options
        .request({ action: "stop", sessionId: this.sessionId })
        .catch(() => {});
  }
}

export function utf8Chunks(text: string, limit = 500): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '', bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

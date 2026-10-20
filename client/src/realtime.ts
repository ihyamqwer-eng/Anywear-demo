import type { ProviderMessage, SessionResponse } from './types';
import { logDiagnostic } from './diagnostics';

const MAX_PENDING_SIGNAL_MESSAGES = 256;

interface RealtimeOptions {
  session: SessionResponse;
  localStream: MediaStream;
  maxVideoBitrateBps: number;
  onRemoteStream: (stream: MediaStream) => void;
  onMessage: (message: ProviderMessage) => void;
  onState: (state: RTCPeerConnectionState) => void;
  onSignalState: (state: 'connecting' | 'open' | 'closed') => void;
  onError: (error: Error) => void;
}

export interface RealtimeMediaStats {
  outboundWidth: number | null;
  outboundHeight: number | null;
  outboundFramesPerSecond: number | null;
  outboundBitrateBps: number | null;
  qualityLimitationReason: string | null;
  inboundWidth: number | null;
  inboundHeight: number | null;
  inboundFramesPerSecond: number | null;
  inboundBitrateBps: number | null;
  packetsLost: number | null;
}

interface PendingSignal {
  serialized: string;
  onSent?: () => void;
}

function websocketUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export class RealtimeConnection {
  private readonly ws: WebSocket;
  private readonly pc: RTCPeerConnection;
  private readonly options: RealtimeOptions;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private pendingSignals: PendingSignal[] = [];
  private heartbeatTimer?: number;
  private closed = false;
  private offerSent = false;
  private queueFailureReported = false;
  private previousByteCounts = new Map<string, { bytes: number; timestamp: number }>();

  constructor(options: RealtimeOptions) {
    this.options = options;
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.ws = new WebSocket(websocketUrl(options.session.websocketPath));
    logDiagnostic('info', 'realtime.created', { websocketOrigin: window.location.origin });
    this.bindPeerConnection();
    this.bindWebSocket();
  }

  private bindPeerConnection(): void {
    this.options.localStream.getTracks().forEach((track) => this.pc.addTrack(track, this.options.localStream));
    this.pc.oniceconnectionstatechange = () => logDiagnostic('info', 'webrtc.ice-state', { state: this.pc.iceConnectionState });
    this.pc.onicegatheringstatechange = () => logDiagnostic('info', 'webrtc.ice-gathering', { state: this.pc.iceGatheringState });
    this.pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      logDiagnostic('info', 'webrtc.track-received', { kind: event.track.kind, readyState: event.track.readyState });
      this.options.onRemoteStream(stream);
    };
    this.pc.onicecandidate = (event) => {
      this.send({ type: 'ice-candidate', candidate: event.candidate?.toJSON() ?? null });
    };
    this.pc.onconnectionstatechange = () => this.options.onState(this.pc.connectionState);
  }

  private async configureVideoSender(): Promise<void> {
    const sender = this.pc.getSenders().find((candidate) => candidate.track?.kind === 'video');
    if (!sender) return;
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return;
    parameters.encodings[0].maxBitrate = this.options.maxVideoBitrateBps;
    await sender.setParameters(parameters);
  }

  private bitrate(id: string, bytes: number | undefined, timestamp: number): number | null {
    if (bytes === undefined) return null;
    const previous = this.previousByteCounts.get(id);
    this.previousByteCounts.set(id, { bytes, timestamp });
    if (!previous || timestamp <= previous.timestamp || bytes < previous.bytes) return null;
    return Math.round(((bytes - previous.bytes) * 8 * 1000) / (timestamp - previous.timestamp));
  }

  async getMediaStats(): Promise<RealtimeMediaStats> {
    const reports = await this.pc.getStats();
    const result: RealtimeMediaStats = {
      outboundWidth: null,
      outboundHeight: null,
      outboundFramesPerSecond: null,
      outboundBitrateBps: null,
      qualityLimitationReason: null,
      inboundWidth: null,
      inboundHeight: null,
      inboundFramesPerSecond: null,
      inboundBitrateBps: null,
      packetsLost: null,
    };

    reports.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        const outbound = report as RTCOutboundRtpStreamStats;
        result.outboundWidth = outbound.frameWidth ?? null;
        result.outboundHeight = outbound.frameHeight ?? null;
        result.outboundFramesPerSecond = outbound.framesPerSecond ?? null;
        result.outboundBitrateBps = this.bitrate(outbound.id, outbound.bytesSent, outbound.timestamp);
        result.qualityLimitationReason = outbound.qualityLimitationReason ?? null;
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        const inbound = report as RTCInboundRtpStreamStats;
        result.inboundWidth = inbound.frameWidth ?? null;
        result.inboundHeight = inbound.frameHeight ?? null;
        result.inboundFramesPerSecond = inbound.framesPerSecond ?? null;
        result.inboundBitrateBps = this.bitrate(inbound.id, inbound.bytesReceived, inbound.timestamp);
        result.packetsLost = inbound.packetsLost ?? null;
      }
    });

    return result;
  }

  private bindWebSocket(): void {
    this.options.onSignalState('connecting');
    this.ws.onopen = async () => {
      logDiagnostic('info', 'signaling.open');
      this.options.onSignalState('open');
      this.heartbeatTimer = window.setInterval(() => this.send({ type: 'heartbeat' }), 10_000);
      try {
        await this.configureVideoSender();
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
        this.offerSent = true;
        for (const signal of this.pendingSignals.splice(0)) this.sendSerialized(signal);
      } catch (error) {
        this.options.onError(error instanceof Error ? error : new Error('Unable to create WebRTC offer'));
      }
    };
    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ProviderMessage;
        if (['answer', 'ice-restart', 'error', 'proxy_ready'].includes(message.type)) {
          logDiagnostic(message.type === 'error' ? 'error' : 'info', 'signaling.message', { type: message.type });
        }
        void this.handleMessage(message).catch((error: unknown) => {
          logDiagnostic('error', 'signaling.apply-failed', { message: error instanceof Error ? error.message : String(error) });
          this.options.onError(error instanceof Error ? error : new Error('Unable to apply signaling message'));
        });
      } catch (error) {
        logDiagnostic('error', 'signaling.invalid-message', { message: error instanceof Error ? error.message : String(error) });
        this.options.onError(error instanceof Error ? error : new Error('Invalid signaling message'));
      }
    };
    this.ws.onerror = () => {
      logDiagnostic('error', 'signaling.error');
      this.options.onError(new Error('Signaling connection failed'));
    };
    this.ws.onclose = (event) => {
      logDiagnostic('warn', 'signaling.closed', { code: event.code });
      this.options.onSignalState('closed');
      if (!this.closed) this.options.onError(new Error('Signaling connection closed'));
    };
  }

  private async handleMessage(message: ProviderMessage): Promise<void> {
    this.options.onMessage(message);
    switch (message.type) {
      case 'answer':
        if (message.sdp) await this.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        for (const candidate of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(candidate);
        break;
      case 'ice-candidate':
        if (message.candidate) {
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate);
          else this.pendingCandidates.push(message.candidate);
        }
        break;
      case 'ice-restart':
        if (!message.turn_config) break;
        this.pc.setConfiguration({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
              urls: message.turn_config.server_url,
              username: message.turn_config.username,
              credential: message.turn_config.credential,
            },
          ],
        });
        {
          const offer = await this.pc.createOffer({ iceRestart: true });
          await this.pc.setLocalDescription(offer);
          this.send({ type: 'offer', sdp: offer.sdp });
        }
        break;
      default:
        break;
    }
  }

  send(message: Record<string, unknown>, onSent?: () => void): boolean {
    if (message.type !== 'heartbeat') logDiagnostic('info', 'signaling.send', { type: message.type });
    const serialized = JSON.stringify(message);
    if (this.ws.readyState === WebSocket.OPEN && (this.offerSent || message.type === 'offer')) {
      this.sendSerialized({ serialized, onSent });
      return true;
    }
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
      if (this.pendingSignals.length >= MAX_PENDING_SIGNAL_MESSAGES) {
        if (!this.queueFailureReported) {
          this.queueFailureReported = true;
          this.options.onError(new Error('信令尚未就绪，待发消息队列已满'));
        }
        return false;
      }
      this.pendingSignals.push({ serialized, onSent });
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.pc.getSenders().forEach((sender) => sender.track?.stop());
    this.pc.close();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }

  private sendSerialized(signal: PendingSignal): void {
    this.ws.send(signal.serialized);
    signal.onSent?.();
  }
}

export type SessionState =
  | 'idle'
  | 'camera_ready'
  | 'signaling'
  | 'connected'
  | 'generating'
  | 'switching'
  | 'stopping'
  | 'error';

export interface Garment {
  id: string;
  name: string;
  image: string;
  prompt: string;
  enabled: boolean;
}

export interface ProviderMessage {
  type: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  turn_config?: {
    username: string;
    credential: string;
    server_url: string;
  };
  seconds?: number;
  reason?: string;
  error?: string | null;
  success?: boolean;
}

export interface SessionResponse {
  sessionId: string;
  state: SessionState;
  expiresAt: string;
  websocketPath: string;
}

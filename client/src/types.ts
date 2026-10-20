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

export interface GarmentGroup {
  id: string;
  name: string;
  garments: Garment[];
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
  providerKeyId: string;
  expiresAt: string;
  websocketPath: string;
}

export interface ProviderKeyCard {
  id: string;
  number: number;
  activeSessions: number;
  cooldownSecondsRemaining: number;
}

export interface ProviderKeyPoolStatus {
  poolId: string;
  cards: ProviderKeyCard[];
}

export interface AdminProviderKeyCard extends ProviderKeyCard {
  label: string;
  keyHint: string;
  enabled: boolean;
}

export interface AdminProviderKeyPoolStatus {
  poolId: string;
  cards: AdminProviderKeyCard[];
}

export interface ProviderKeySelection {
  providerKeyId: string;
  poolId: string;
}

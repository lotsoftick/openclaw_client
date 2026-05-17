export interface DeviceCredentials {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface AuthCredentials {
  tokens?: {
    operator?: {
      scopes?: string[];
      token?: string;
    };
  };
}

export interface SharedGatewayAuth {
  /** `gateway.auth.token` from `~/.openclaw/openclaw.json` (mode = "token"). */
  token?: string;
  /** `gateway.auth.password` from `~/.openclaw/openclaw.json` (mode = "password"). */
  password?: string;
}

export interface GatewayCredentials {
  /** Device identity — required for the legacy device-auth path; optional
   *  when `sharedAuth` is configured (loopback backend clients can connect
   *  with a shared secret and no device pairing). */
  device: DeviceCredentials | null;
  auth: AuthCredentials;
  gatewayPort: number;
  /** Shared-secret credentials read from the OpenClaw config file. When
   *  present, the connect handshake uses these instead of device-pairing,
   *  so no `openclaw devices approve` step is ever required. */
  sharedAuth: SharedGatewayAuth | null;
}

// ── Wire protocol ──

export interface GwResponsePayloadAccepted {
  status: 'accepted';
  runId?: string;
}

export interface GwResponseMessage<P = unknown> {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: (P & Partial<GwResponsePayloadAccepted>) | GwResponsePayloadAccepted;
  error?: { message?: string; code?: string };
}

export interface GwConnectChallengePayload {
  nonce: string;
}

export interface GwAgentEventPayload {
  runId: string;
  stream?: 'assistant' | 'reasoning';
  data?: {
    delta?: boolean;
    text?: string;
  };
}

export interface GwEventMessage<P = unknown> {
  type: 'event';
  event: string;
  payload: P;
}

export type GwInboundMessage =
  | GwResponseMessage
  | GwEventMessage<GwConnectChallengePayload>
  | GwEventMessage<GwAgentEventPayload>
  | GwEventMessage<unknown>;

export type EventListener = (msg: GwInboundMessage) => void;

export interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  expectFinal: boolean;
  runId?: string;
}

export interface GatewayRequestOpts {
  timeoutMs?: number;
  expectFinal?: boolean;
}

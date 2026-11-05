import { logDebug } from './diagnostics';
import { getAeroDropE2EHooks, type AeroDropPeerRuntimeModuleLike } from './e2eHooks';

type Listener = (...args: any[]) => void;

type PeerRuntimeErrorType =
  | 'unavailable-id'
  | 'invalid-id'
  | 'unauthorized'
  | 'peer-unavailable'
  | 'rate-limited'
  | 'disconnected'
  | 'network'
  | 'server-error'
  | 'socket-error'
  | 'webrtc-error';

type ChannelKind = 'data' | 'media';

type PeerOptions = {
  debug?: number;
  pingInterval?: number;
  signalingCode?: string;
  signalingToken?: string;
  config?: RTCConfiguration;
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
};

type DataConnectionOptions = {
  serialization?: 'binary' | 'json';
};

type PeerRuntimeModule = {
  default: typeof WorkerSignaledPeer;
};

type PeerEvents = {
  open: (peerId: string) => void;
  connection: (connection: DataConnection) => void;
  call: (call: MediaConnection) => void;
  error: (error: PeerRuntimeError) => void;
  disconnected: () => void;
};

type DataConnectionEvents = {
  open: () => void;
  data: (data: any) => void;
  close: () => void;
  error: (error: PeerRuntimeError) => void;
};

type MediaConnectionEvents = {
  stream: (stream: MediaStream) => void;
  close: () => void;
  error: (error: PeerRuntimeError) => void;
};

type RegisteredEnvelope = { type: 'registered'; peerId: string };
type ErrorEnvelope = {
  type: 'error';
  code: PeerRuntimeErrorType | string;
  message?: string;
  connectionId?: string;
  targetPeerId?: string;
  kind?: ChannelKind;
};
type OfferEnvelope = {
  type: 'offer';
  connectionId: string;
  kind: ChannelKind;
  sourcePeerId: string;
  targetPeerId: string;
  description: RTCSessionDescriptionInit;
};
type AnswerEnvelope = {
  type: 'answer';
  connectionId: string;
  kind: ChannelKind;
  sourcePeerId: string;
  targetPeerId: string;
  description: RTCSessionDescriptionInit;
};
type IceCandidateEnvelope = {
  type: 'ice-candidate';
  connectionId: string;
  kind: ChannelKind;
  sourcePeerId: string;
  targetPeerId: string;
  candidate: RTCIceCandidateInit;
};
type PingEnvelope = {
  type: 'ping';
  ts: number;
  sourcePeerId?: string;
};
type PongEnvelope = {
  type: 'pong';
  ts: number;
  sourcePeerId?: string;
};

type SignalingEnvelope =
  | RegisteredEnvelope
  | ErrorEnvelope
  | OfferEnvelope
  | AnswerEnvelope
  | IceCandidateEnvelope
  | PingEnvelope
  | PongEnvelope;

const JSON_ENVELOPE = '__aerodrop_json__';
const TEXT_ENVELOPE = '__aerodrop_text__';
const SIGNALING_LOG_KEY = '__AERODROP_SIGNALING_METRICS__';

const DEFAULT_SIGNALING_PING_INTERVAL_MS = 20_000;
const DEFAULT_SIGNALING_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNALING_RECONNECT_BASE_MS = 1_000;
const MAX_SIGNALING_RECONNECT_DELAY_MS = 10_000;
const runtimeEnv =
  ((import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env) ?? {};
const SIGNALING_BASE =
  (runtimeEnv.VITE_SIGNALING_WS_URL as string | undefined)?.trim() ||
  (runtimeEnv.VITE_SIGNALING_BASE_URL as string | undefined)?.trim() ||
  // Always go through the page origin: in `npm run dev` the Vite proxy forwards
  // /ws-signaling to wrangler, and the Worker's same-origin gate rejects a
  // cross-origin handshake (browser always sends Origin on WebSocket upgrades).
  window.location.origin;
const SIGNALING_PATH =
  ((runtimeEnv.VITE_SIGNALING_PATH as string | undefined)?.trim() || '/ws-signaling').replace(/\/?$/, '');
const QUIET_SIGNAL_EVENTS = new Set([
  'signaling_ping_received',
  'signaling_pong_received',
  'signaling_ping_sent',
  'signaling_pong_sent',
  'ice_candidate_local',
  'signaling_ice_candidate_sent',
  'signaling_ice_candidate_received',
  'pc_ice_gathering_state',
  'pc_signaling_state',
  'pc_ice_connection_state',
  'pc_connection_state',
]);
const IMPORTANT_SIGNAL_INFO_EVENTS = new Set([
  'signaling_ws_connect_start',
  'signaling_ws_open',
  'signaling_registered',
  'offer_created',
  'signaling_offer_received',
  'signaling_answer_received',
  'data_channel_open',
  'data_channel_close',
]);

const TERMINAL_SIGNALING_ERROR_CODES = new Set(['unavailable-id', 'invalid-id', 'unauthorized']);

const createRuntimeError = (
  type: PeerRuntimeErrorType,
  message: string,
  cause?: unknown
): PeerRuntimeError => {
  const error = new Error(message) as PeerRuntimeError;
  error.type = type;
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
};

const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toWebSocketUrl = (base: string): string => {
  if (base.startsWith('ws://') || base.startsWith('wss://')) {
    return base;
  }
  if (base.startsWith('https://')) {
    return `wss://${base.slice('https://'.length)}`;
  }
  if (base.startsWith('http://')) {
    return `ws://${base.slice('http://'.length)}`;
  }
  return `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${base}`;
};

// 信令 URL 里的 token 等价于发送方凭证：只允许真正用于建连，日志/指标一律脱敏。
const redactSignalingUrl = (url: string): string =>
  url.replace(/([?&]token=)[^&]*/i, '$1<redacted>');

const createSignalingUrl = (peerId: string, options: PeerOptions = {}): string => {
  const baseUrl = new URL(toWebSocketUrl(SIGNALING_BASE));
  const wsUrl = new URL(SIGNALING_PATH, baseUrl);
  wsUrl.searchParams.set('peerId', peerId);
  if (options.signalingCode) wsUrl.searchParams.set('code', options.signalingCode);
  if (options.signalingToken) wsUrl.searchParams.set('token', options.signalingToken);
  return wsUrl.toString();
};

const parseCandidateDetails = (candidate: RTCIceCandidateInit) => {
  const candidateLine = candidate.candidate || '';
  const parts = candidateLine.split(' ');
  const protocol = parts[2] || undefined;
  const candidateTypeIndex = parts.findIndex((part) => part === 'typ');
  const candidateType =
    candidateTypeIndex >= 0 && candidateTypeIndex + 1 < parts.length
      ? parts[candidateTypeIndex + 1]
      : undefined;
  return {
    protocol,
    candidateType,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
};

const summarizeDescription = (description?: RTCSessionDescriptionInit) => ({
  type: description?.type,
  sdpLength: description?.sdp?.length ?? 0,
});

const pushSignalLog = (payload: unknown) => {
  try {
    const win = window as Window & { [SIGNALING_LOG_KEY]?: unknown[] };
    if (!Array.isArray(win[SIGNALING_LOG_KEY])) {
      win[SIGNALING_LOG_KEY] = [];
    }
    win[SIGNALING_LOG_KEY]!.push(payload);
    if (win[SIGNALING_LOG_KEY]!.length > 300) {
      win[SIGNALING_LOG_KEY] = win[SIGNALING_LOG_KEY]!.slice(-300);
    }
  } catch {
    // Ignore debug storage failures.
  }
};

class TinyEmitter<EventMap extends Record<string, Listener>> {
  private listeners = new Map<keyof EventMap, Set<Listener>>();

  on<K extends keyof EventMap>(event: K, listener: EventMap[K]): this {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener as Listener);
    this.listeners.set(event, bucket);
    return this;
  }

  off<K extends keyof EventMap>(event: K, listener: EventMap[K]): this {
    this.listeners.get(event)?.delete(listener as Listener);
    return this;
  }

  emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    bucket.forEach((listener) => {
      try {
        (listener as EventMap[K])(...args);
      } catch (error) {
        console.error('peer runtime listener failed', error);
      }
    });
  }
}

class BaseConnection<EventMap extends Record<string, Listener>> extends TinyEmitter<EventMap> {
  public readonly peer: string;
  public readonly provider: WorkerSignaledPeer;
  public readonly peerConnection: RTCPeerConnection;
  public readonly connectionId: string;
  public open = false;
  protected remoteDescriptionReady = false;
  protected closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    provider: WorkerSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection
  ) {
    super();
    this.provider = provider;
    this.peer = peerId;
    this.connectionId = connectionId;
    this.peerConnection = peerConnection;
    this.peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.provider.logConnectionEvent(this, 'ice_candidate_local', parseCandidateDetails(event.candidate.toJSON()));
      this.provider.forwardIceCandidate(this, event.candidate.toJSON());
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      this.provider.logConnectionEvent(this, 'pc_connection_state', { state });
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.handleTransportClosed();
      }
    };
    this.peerConnection.oniceconnectionstatechange = () => {
      this.provider.logConnectionEvent(this, 'pc_ice_connection_state', {
        state: this.peerConnection.iceConnectionState,
      });
    };
    this.peerConnection.onicegatheringstatechange = () => {
      this.provider.logConnectionEvent(this, 'pc_ice_gathering_state', {
        state: this.peerConnection.iceGatheringState,
      });
    };
    this.peerConnection.onsignalingstatechange = () => {
      this.provider.logConnectionEvent(this, 'pc_signaling_state', {
        state: this.peerConnection.signalingState,
      });
    };
  }

  async applyRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.peerConnection.setRemoteDescription(description);
    this.remoteDescriptionReady = true;
    await this.flushPendingCandidates();
  }

  queueOrAddIceCandidate(candidate: RTCIceCandidateInit): void {
    if (this.closed) return;
    if (!this.remoteDescriptionReady) {
      this.pendingCandidates.push(candidate);
      return;
    }
    void this.peerConnection.addIceCandidate(candidate).catch((error) => {
      this.handleError(createRuntimeError('webrtc-error', 'Failed to add ICE candidate', error));
    });
  }

  protected async flushPendingCandidates(): Promise<void> {
    if (!this.remoteDescriptionReady || this.pendingCandidates.length === 0) {
      return;
    }
    const pending = [...this.pendingCandidates];
    this.pendingCandidates.length = 0;
    for (const candidate of pending) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        this.handleError(createRuntimeError('webrtc-error', 'Failed to flush ICE candidate', error));
      }
    }
  }

  protected handleError(error: PeerRuntimeError): void {
    if (this.closed) return;
    (this.emit as any)('error', error);
  }

  protected markOpen(): void {
    if (this.closed || this.open) return;
    this.open = true;
  }

  protected handleTransportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.provider.removeConnection(this);
    try {
      this.peerConnection.close();
    } catch {
      // Ignore close errors.
    }
  }

  close(): void {
    if (this.closed) return;
    this.handleTransportClosed();
  }
}

export class DataConnection extends BaseConnection<DataConnectionEvents> {
  public dataChannel: RTCDataChannel | null = null;

  bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.provider.logConnectionEvent(this, 'data_channel_bound', {
      label: channel.label,
      ordered: channel.ordered,
    });
    this.dataChannel.onopen = () => {
      this.markOpen();
      this.provider.logConnectionEvent(this, 'data_channel_open', {
        readyState: this.dataChannel?.readyState,
      });
      this.emit('open');
    };
    this.dataChannel.onclose = () => {
      this.handleTransportClosed();
      this.provider.logConnectionEvent(this, 'data_channel_close', {
        readyState: this.dataChannel?.readyState,
      });
      this.emit('close');
    };
    this.dataChannel.onerror = () => {
      this.provider.logConnectionEvent(this, 'data_channel_error', {
        readyState: this.dataChannel?.readyState,
      });
      this.handleError(createRuntimeError('webrtc-error', 'Data channel error'));
      this.close();
    };
    this.dataChannel.onmessage = async (event) => {
      const payload = event.data;
      if (typeof payload === 'string') {
        try {
          const decoded = JSON.parse(payload) as { __type?: string; payload?: unknown };
          if (decoded?.__type === JSON_ENVELOPE || decoded?.__type === TEXT_ENVELOPE) {
            this.emit('data', decoded.payload);
            return;
          }
        } catch {
          // Treat as plain text below.
        }
        this.emit('data', payload);
        return;
      }

      if (payload instanceof Blob) {
        const buffer = await payload.arrayBuffer();
        this.emit('data', buffer);
        return;
      }

      this.emit('data', payload);
    };
  }

  send(data: unknown): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw createRuntimeError('network', 'Data channel is not open');
    }

    if (data instanceof ArrayBuffer) {
      this.dataChannel.send(data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.dataChannel.send(data as ArrayBufferView);
      return;
    }
    if (data instanceof Blob) {
      this.dataChannel.send(data);
      return;
    }
    if (typeof data === 'string') {
      this.dataChannel.send(JSON.stringify({ __type: TEXT_ENVELOPE, payload: data }));
      return;
    }

    this.dataChannel.send(JSON.stringify({ __type: JSON_ENVELOPE, payload: data }));
  }

  override close(): void {
    if (this.dataChannel && this.dataChannel.readyState !== 'closed') {
      try {
        this.dataChannel.close();
      } catch {
        // Ignore close errors.
      }
    }
    const wasClosed = this.closed;
    super.close();
    if (!wasClosed) {
      this.emit('close');
    }
  }
}

export class MediaConnection extends BaseConnection<MediaConnectionEvents> {
  private remoteStream = new MediaStream();
  private answered = false;

  constructor(
    provider: WorkerSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection
  ) {
    super(provider, peerId, connectionId, peerConnection);
    this.peerConnection.ontrack = (event) => {
      event.streams.forEach((stream) => {
        stream.getTracks().forEach((track) => {
          if (!this.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            this.remoteStream.addTrack(track);
          }
        });
      });
      if (event.track && !this.remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      this.markOpen();
      this.provider.logConnectionEvent(this, 'media_track', {
        trackId: event.track?.id,
        kind: event.track?.kind,
        streamCount: event.streams.length,
      });
      this.emit('stream', this.remoteStream);
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      this.provider.logConnectionEvent(this, 'media_pc_connection_state', { state });
      if (state === 'connected' && !this.open) {
        this.markOpen();
      }
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.handleTransportClosed();
        this.emit('close');
      }
    };
  }

  async answer(stream: MediaStream): Promise<void> {
    if (this.answered || this.closed) return;
    this.answered = true;
    stream.getTracks().forEach((track) => {
      this.peerConnection.addTrack(track, stream);
    });
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    this.provider.forwardAnswer(this, answer);
  }

  override close(): void {
    const wasClosed = this.closed;
    super.close();
    if (!wasClosed) {
      this.emit('close');
    }
  }
}

export type PeerRuntimeError = Error & {
  type: PeerRuntimeErrorType;
};

export default class WorkerSignaledPeer extends TinyEmitter<PeerEvents> {
  public id: string;
  public destroyed = false;
  public disconnected = false;
  public readonly connections: Record<string, Array<DataConnection | MediaConnection>> = {};

  private readonly config: RTCConfiguration;
  private readonly options: PeerOptions;
  private readonly createdAt = performance.now();
  private connectionIndex = new Map<string, DataConnection | MediaConnection>();
  private websocket: WebSocket | null = null;
  private openedOnce = false;
  private readyPromiseResolve: (() => void) | null = null;
  private readyPromiseReject: ((reason?: unknown) => void) | null = null;
  private readyPromise: Promise<void>;
  private isManualClose = false;
  private heartbeatTimer: number | null = null;
  private pongTimeoutTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private awaitingPong = false;
  private registrationRejected = false;

  constructor(id?: string, options?: PeerOptions);
  constructor(options?: PeerOptions);
  constructor(idOrOptions?: string | PeerOptions, maybeOptions?: PeerOptions) {
    super();
    this.id = typeof idOrOptions === 'string' ? idOrOptions : createId('peer');
    this.options = (typeof idOrOptions === 'string' ? maybeOptions : idOrOptions) ?? {};
    this.config = this.options.config ?? {};
    this.readyPromise = this.createReadyPromise();
    this.connectSignaling();
  }

  private log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
    const payload = {
      tag: 'signal-metrics',
      peerId: this.id,
      status: this.destroyed ? 'destroyed' : this.disconnected ? 'disconnected' : this.openedOnce ? 'registered' : 'connecting',
      event,
      elapsedMs: Math.max(0, Math.round(performance.now() - this.createdAt)),
      data,
    };
    if (level === 'warn') {
      logDebug('warn', '[signal-metrics]', payload);
    } else if (level === 'error') {
      logDebug('error', '[signal-metrics]', payload);
    } else if (!QUIET_SIGNAL_EVENTS.has(event) && IMPORTANT_SIGNAL_INFO_EVENTS.has(event)) {
      logDebug('info', '[signal-metrics]', payload);
    }
    pushSignalLog(payload);
  }

  logConnectionEvent(connection: BaseConnection<any>, event: string, data?: Record<string, unknown>): void {
    this.log('info', event, {
      connectionId: connection.connectionId,
      kind: connection instanceof DataConnection ? 'data' : 'media',
      targetPeerId: connection.peer,
      ...data,
    });
  }

  private createReadyPromise(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.readyPromiseResolve = resolve;
      this.readyPromiseReject = reject;
    });

    // Registration failures can happen before any outgoing offer awaits readiness.
    // Mark the promise as handled up front so pre-registration disconnects do not
    // surface as global unhandled rejections for listener-only peers.
    promise.catch(() => {});
    return promise;
  }

  private resetReadyPromise(): void {
    this.readyPromise = this.createReadyPromise();
  }

  private rejectReadyPromise(reason: unknown): void {
    const reject = this.readyPromiseReject;
    if (!reject) {
      return;
    }

    this.readyPromiseResolve = null;
    this.readyPromiseReject = null;
    reject(reason);
  }

  private connectSignaling(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const url = createSignalingUrl(this.id, this.options);
    this.log('info', 'signaling_ws_connect_start', {
      url: redactSignalingUrl(url),
      signalingBase: SIGNALING_BASE,
      signalingPath: SIGNALING_PATH,
    });
    this.websocket = new WebSocket(url);
    this.websocket.onopen = () => {
      this.disconnected = false;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.log('info', 'signaling_ws_open', { url: redactSignalingUrl(url) });
    };
    this.websocket.onmessage = (event) => {
      this.handleSignalingMessage(event.data);
    };
    this.websocket.onerror = () => {
      if (this.destroyed) return;
      const error = createRuntimeError('socket-error', 'Signaling WebSocket connection failed');
      if (!this.openedOnce) {
        this.rejectReadyPromise(error);
      }
      this.log('error', 'signaling_ws_error');
      this.emit('error', error);
    };
    this.websocket.onclose = (event) => {
      const wasOpened = this.openedOnce;
      this.websocket = null;
      this.stopHeartbeat();
      if (this.destroyed || this.isManualClose) {
        return;
      }
      this.disconnected = true;
      if (this.registrationRejected) {
        this.log('warn', 'signaling_registration_rejected_close');
        return;
      }
      this.log(wasOpened ? 'warn' : 'error', 'signaling_ws_close', {
        code: event.code,
        reason: event.reason || undefined,
        wasOpened,
      });
      if (!wasOpened) {
        const error = createRuntimeError('disconnected', 'Signaling WebSocket closed before registration');
        this.rejectReadyPromise(error);
        this.emit('error', error);
      }
      if (wasOpened) {
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = Math.max(5_000, this.options.pingInterval ?? DEFAULT_SIGNALING_PING_INTERVAL_MS);
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (this.awaitingPong) {
        this.log('warn', 'signaling_ping_timeout');
        try {
          this.websocket.close(4000, 'Signaling ping timeout');
        } catch {
          // Ignore close errors.
        }
        return;
      }
      this.awaitingPong = true;
      const nowTs = Date.now();
      try {
        this.sendSignaling({ type: 'ping', ts: nowTs });
      } catch (error) {
        this.awaitingPong = false;
        this.log('warn', 'signaling_ping_send_failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.pongTimeoutTimer = window.setTimeout(() => {
        if (!this.awaitingPong) return;
        this.log('warn', 'signaling_pong_timeout', { pingTs: nowTs });
        try {
          this.websocket?.close(4001, 'Signaling pong timeout');
        } catch {
          // Ignore close errors.
        }
      }, DEFAULT_SIGNALING_PONG_TIMEOUT_MS);
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    this.awaitingPong = false;
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimeoutTimer !== null) {
      window.clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.isManualClose || this.registrationRejected || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(
      DEFAULT_SIGNALING_RECONNECT_BASE_MS * Math.pow(2, Math.max(0, this.reconnectAttempts - 1)),
      MAX_SIGNALING_RECONNECT_DELAY_MS
    );
    this.log('warn', 'signaling_reconnect_scheduled', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  private handleSignalingMessage(raw: unknown): void {
    let message: SignalingEnvelope;
    try {
      message = JSON.parse(String(raw)) as SignalingEnvelope;
    } catch (error) {
      this.emit('error', createRuntimeError('server-error', 'Received invalid signaling payload', error));
      return;
    }

    if (message.type === 'registered') {
      this.disconnected = false;
      this.id = message.peerId;
      this.log('info', 'signaling_registered', { registeredPeerId: message.peerId });
      if (!this.openedOnce) {
        this.openedOnce = true;
        this.readyPromiseResolve?.();
        this.readyPromiseResolve = null;
        this.readyPromiseReject = null;
        this.emit('open', this.id);
      }
      return;
    }

    if (message.type === 'ping') {
      this.log('info', 'signaling_ping_received', { ts: message.ts });
      this.sendSignaling({ type: 'pong', ts: message.ts });
      return;
    }

    if (message.type === 'pong') {
      this.awaitingPong = false;
      if (this.pongTimeoutTimer !== null) {
        window.clearTimeout(this.pongTimeoutTimer);
        this.pongTimeoutTimer = null;
      }
      this.log('info', 'signaling_pong_received', { ts: message.ts });
      return;
    }

    if (message.type === 'error') {
      this.log('warn', 'signaling_error_envelope', {
        code: message.code,
        message: message.message,
        connectionId: message.connectionId,
        targetPeerId: message.targetPeerId,
        kind: message.kind,
      });
      const error = createRuntimeError(
        (message.code as PeerRuntimeErrorType) ?? 'server-error',
        message.message || String(message.code || 'Signaling error')
      );
      if (TERMINAL_SIGNALING_ERROR_CODES.has(message.code)) {
        this.registrationRejected = true;
        this.log('warn', 'signaling_registration_rejected', { code: message.code });
        if (!this.openedOnce) {
          this.rejectReadyPromise(error);
        }
      }
      if (message.connectionId) {
        const connection = this.connectionIndex.get(message.connectionId);
        if (connection) {
          this.emitConnectionError(connection, error);
          if (message.code === 'peer-unavailable' || message.code === 'invalid-id' || message.code === 'rate-limited') {
            connection.close();
          }
        }
      }
      this.emit('error', error);
      return;
    }

    if (message.type === 'offer') {
      this.log('info', 'signaling_offer_received', {
        connectionId: message.connectionId,
        kind: message.kind,
        sourcePeerId: message.sourcePeerId,
        description: summarizeDescription(message.description),
      });
      void this.handleIncomingOffer(message);
      return;
    }

    if (message.type === 'answer') {
      this.log('info', 'signaling_answer_received', {
        connectionId: message.connectionId,
        kind: message.kind,
        sourcePeerId: message.sourcePeerId,
        description: summarizeDescription(message.description),
      });
      void this.handleIncomingAnswer(message);
      return;
    }

    if (message.type === 'ice-candidate') {
      this.log('info', 'signaling_ice_candidate_received', {
        connectionId: message.connectionId,
        kind: message.kind,
        sourcePeerId: message.sourcePeerId,
        candidate: parseCandidateDetails(message.candidate),
      });
      this.handleIncomingIceCandidate(message);
    }
  }

  private async handleIncomingOffer(payload: OfferEnvelope): Promise<void> {
    if (this.destroyed) return;
    if (payload.kind === 'data') {
      const peerConnection = new RTCPeerConnection(this.config);
      const connection = new DataConnection(this, payload.sourcePeerId, payload.connectionId, peerConnection);
      peerConnection.ondatachannel = (event) => {
        connection.bindDataChannel(event.channel);
      };
      this.addConnection(connection);
      this.emit('connection', connection);
      try {
        await connection.applyRemoteDescription(payload.description);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        this.forwardAnswer(connection, answer);
      } catch (error) {
        this.emitConnectionError(connection, createRuntimeError('webrtc-error', 'Failed to handle incoming data offer', error));
        connection.close();
      }
      return;
    }

    const peerConnection = new RTCPeerConnection(this.config);
    const call = new MediaConnection(this, payload.sourcePeerId, payload.connectionId, peerConnection);
    this.addConnection(call);
    try {
      await call.applyRemoteDescription(payload.description);
      this.emit('call', call);
    } catch (error) {
      this.emitConnectionError(call, createRuntimeError('webrtc-error', 'Failed to handle incoming media offer', error));
      call.close();
    }
  }

  private async handleIncomingAnswer(payload: AnswerEnvelope): Promise<void> {
    const connection = this.connectionIndex.get(payload.connectionId);
    if (!connection) return;
    try {
      await connection.applyRemoteDescription(payload.description);
    } catch (error) {
      this.emitConnectionError(connection, createRuntimeError('webrtc-error', 'Failed to apply remote answer', error));
      connection.close();
    }
  }

  private handleIncomingIceCandidate(payload: IceCandidateEnvelope): void {
    const connection = this.connectionIndex.get(payload.connectionId);
    if (!connection) return;
    connection.queueOrAddIceCandidate(payload.candidate);
  }

  private emitConnectionError(connection: DataConnection | MediaConnection, error: PeerRuntimeError): void {
    if (connection instanceof DataConnection) {
      connection.emit('error', error);
      return;
    }
    connection.emit('error', error);
  }

  private addConnection(connection: DataConnection | MediaConnection): void {
    this.connectionIndex.set(connection.connectionId, connection);
    const bucket = this.connections[connection.peer] ?? [];
    bucket.push(connection);
    this.connections[connection.peer] = bucket;
  }

  removeConnection(connection: BaseConnection<any>): void {
    this.connectionIndex.delete(connection.connectionId);
    const bucket = this.connections[connection.peer];
    if (!bucket) return;
    this.connections[connection.peer] = bucket.filter((item) => item !== connection);
    if (this.connections[connection.peer].length === 0) {
      delete this.connections[connection.peer];
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.openedOnce && !this.disconnected) {
      return;
    }
    await this.readyPromise;
  }

  private sendSignaling(message: SignalingEnvelope): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw createRuntimeError('socket-error', 'Signaling WebSocket is not open');
    }
    const baseData: Record<string, unknown> = {
      connectionId: 'connectionId' in message ? message.connectionId : undefined,
      kind: 'kind' in message ? message.kind : undefined,
      targetPeerId: 'targetPeerId' in message ? message.targetPeerId : undefined,
    };
    if (message.type === 'offer' || message.type === 'answer') {
      baseData.description = summarizeDescription(message.description);
    }
    if (message.type === 'ice-candidate') {
      baseData.candidate = parseCandidateDetails(message.candidate);
    }
    if (message.type === 'ping' || message.type === 'pong') {
      baseData.ts = message.ts;
    }
    this.log('info', `signaling_${message.type}_sent`, baseData);
    this.websocket.send(JSON.stringify(message));
  }

  forwardAnswer(connection: BaseConnection<any>, description: RTCSessionDescriptionInit): void {
    this.sendSignaling({
      type: 'answer',
      connectionId: connection.connectionId,
      kind: connection instanceof DataConnection ? 'data' : 'media',
      sourcePeerId: this.id,
      targetPeerId: connection.peer,
      description,
    });
  }

  forwardIceCandidate(connection: BaseConnection<any>, candidate: RTCIceCandidateInit): void {
    this.sendSignaling({
      type: 'ice-candidate',
      connectionId: connection.connectionId,
      kind: connection instanceof DataConnection ? 'data' : 'media',
      sourcePeerId: this.id,
      targetPeerId: connection.peer,
      candidate,
    });
  }

  connect(targetPeerId: string, _options?: DataConnectionOptions): DataConnection {
    const peerConnection = new RTCPeerConnection(this.config);
    const connection = new DataConnection(this, targetPeerId, createId('data'), peerConnection);
    const channel = peerConnection.createDataChannel('data', { ordered: true });
    connection.bindDataChannel(channel);
    this.addConnection(connection);
    void this.startOutgoingOffer(connection, 'data');
    return connection;
  }

  call(targetPeerId: string, stream?: MediaStream): MediaConnection {
    const peerConnection = new RTCPeerConnection(this.config);
    const call = new MediaConnection(this, targetPeerId, createId('media'), peerConnection);
    if (stream) {
      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });
    } else {
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
      peerConnection.addTransceiver('audio', { direction: 'recvonly' });
    }
    this.addConnection(call);
    void this.startOutgoingOffer(call, 'media');
    return call;
  }

  private async startOutgoingOffer(connection: DataConnection | MediaConnection, kind: ChannelKind): Promise<void> {
    try {
      await this.ensureReady();
      const offer = await connection.peerConnection.createOffer();
      await connection.peerConnection.setLocalDescription(offer);
      this.logConnectionEvent(connection, 'offer_created', {
        kind,
        description: summarizeDescription(offer),
      });
      this.sendSignaling({
        type: 'offer',
        connectionId: connection.connectionId,
        kind,
        sourcePeerId: this.id,
        targetPeerId: connection.peer,
        description: offer,
      });
    } catch (error) {
      const runtimeError =
        error instanceof Error && 'type' in error
          ? (error as PeerRuntimeError)
          : createRuntimeError('webrtc-error', 'Failed to start WebRTC offer', error);
      this.emit('error', runtimeError);
      this.emitConnectionError(connection, runtimeError);
      connection.close();
    }
  }

  reconnect(): void {
    if (this.destroyed) return;
    if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.disconnected = false;
    if (!this.openedOnce) {
      this.resetReadyPromise();
    }
    this.log('warn', 'signaling_reconnect');
    this.connectSignaling();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.isManualClose = true;
    this.log('info', 'peer_destroy');
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    Object.values(this.connections).flat().forEach((connection) => connection.close());
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.close(1000, 'Peer destroyed');
    } else if (this.websocket) {
      try {
        this.websocket.close();
      } catch {
        // Ignore close errors.
      }
    }
    this.websocket = null;
  }
}

export type Peer = WorkerSignaledPeer;

let peerRuntimePromise: Promise<PeerRuntimeModule> | null = null;

export const loadPeerRuntime = (): Promise<PeerRuntimeModule> => {
  const e2eModule = getAeroDropE2EHooks()?.createPeerRuntimeModule?.();
  if (e2eModule) {
    return Promise.resolve(e2eModule as Promise<AeroDropPeerRuntimeModuleLike>).then(
      (module) => module as PeerRuntimeModule
    );
  }

  if (!peerRuntimePromise) {
    peerRuntimePromise = Promise.resolve({
      default: WorkerSignaledPeer,
    });
  }
  return peerRuntimePromise;
};

export type { PeerOptions, DataConnectionOptions };

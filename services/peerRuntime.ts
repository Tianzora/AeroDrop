import { logDebug } from './diagnostics';
import { getAeroDropE2EHooks, type AeroDropPeerRuntimeModuleLike } from './e2eHooks';
import { CONNECTION_TIMINGS } from '../constants/transfer';
import { shouldResetReconnectBudget } from './connectionPolicy';

type Listener = (...args: any[]) => void;

type PeerRuntimeErrorType =
  | 'unavailable-id'
  | 'invalid-id'
  | 'unauthorized'
  | 'session-conflict'
  | 'peer-unavailable'
  | 'rate-limited'
  | 'disconnected'
  | 'network'
  | 'server-error'
  | 'socket-error'
  | 'message-too-large'
  | 'webrtc-error';

type ChannelKind = 'data' | 'media';

type PeerOptions = {
  debug?: number;
  pingInterval?: number;
  signalingCode?: string;
  signalingToken?: string;
  /**
   * 分享会话绑定的密钥摘要（32 字节随机 secret 的 SHA-256，小写 hex）。带上它之后，
   * 同 peerId 的会话接管必须出示同一摘要；不传则保持历史行为（文件传输走这条）。
   */
  sessionSecretHash?: string;
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
  'signaling:restored': (peerId: string) => void;
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

// session-conflict：同 peerId 的已有分享会话没有匹配的密钥摘要，被服务端拒绝接管。
// 继续重连只会反复被拒（还可能与真正的分享者互踢），所以按终态处理，由上层提示用户。
const TERMINAL_SIGNALING_ERROR_CODES = new Set([
  'unavailable-id',
  'invalid-id',
  'unauthorized',
  'session-conflict',
]);

/**
 * 这些 close code 表示「继续重连也没有意义」：服务端已经因为这层连接本身拒绝了我们
 * （每 IP 会话数超限、消息体超限）。若继续按退避重连，用户会看到永不停息的重连而
 * 没有可操作的提示，所以直接终止并把原因交给上层展示。
 * 1008（消息过多）刻意不在此列：它是瞬时拥塞，退避后重连通常能恢复。
 */
const TERMINAL_SIGNALING_CLOSE_CODES = new Map<number, { type: PeerRuntimeErrorType; message: string }>([
  // 1009 是我们自己发出的单条消息超限（分片/大小校验回归），重试修不好，也不能记成
  // 「请求过多」——那会把真正的原因藏起来。
  [1009, { type: 'message-too-large', message: 'Signaling message exceeded server limit' }],
  [4029, { type: 'rate-limited', message: 'Too many signaling sessions from this network' }],
]);

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

// 信令 URL 里的 token / sessionSecretHash 等价于凭证：只允许真正用于建连，日志/指标一律脱敏。
const redactSignalingUrl = (url: string): string =>
  url.replace(/([?&](?:token|sessionSecretHash)=)[^&]*/gi, '$1<redacted>');

const createSignalingUrl = (peerId: string, options: PeerOptions = {}): string => {
  const baseUrl = new URL(toWebSocketUrl(SIGNALING_BASE));
  const wsUrl = new URL(SIGNALING_PATH, baseUrl);
  wsUrl.searchParams.set('peerId', peerId);
  if (options.signalingCode) wsUrl.searchParams.set('code', options.signalingCode);
  if (options.signalingToken) wsUrl.searchParams.set('token', options.signalingToken);
  if (options.sessionSecretHash) {
    wsUrl.searchParams.set('sessionSecretHash', options.sessionSecretHash);
  }
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

/** 从 SDP 取 ice-ufrag：重协商的 offer 一定带新 ufrag，重复投递的旧 offer 则相同。 */
const extractIceUfrag = (description?: RTCSessionDescriptionInit): string | null => {
  const match = /a=ice-ufrag:(\S+)/.exec(description?.sdp ?? '');
  return match?.[1] ?? null;
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
  private readonly isInitiator: boolean;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private transportGraceTimer: number | null = null;
  private iceRestartTimer: number | null = null;
  private iceRestartAttempted = false;
  private closeEmitted = false;

  constructor(
    provider: WorkerSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection,
    isInitiator = false
  ) {
    super();
    this.provider = provider;
    this.peer = peerId;
    this.connectionId = connectionId;
    this.peerConnection = peerConnection;
    this.isInitiator = isInitiator;
    this.peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.provider.logConnectionEvent(this, 'ice_candidate_local', parseCandidateDetails(event.candidate.toJSON()));
      this.provider.forwardIceCandidate(this, event.candidate.toJSON());
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      this.provider.logConnectionEvent(this, 'pc_connection_state', { state });
      this.handleConnectionStateChange(state);
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
    // 重协商（ICE restart）时新 generation 的候选可能先于 SDP 到达：先把就绪标记放下，
    // 让这些候选重新进队列，等新的 remote description 应用完再一起 flush。
    this.remoteDescriptionReady = false;
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
      // ICE restart 后旧 generation 的候选会被拒绝，属于预期内的竞态；把它升级成
      // 连接级 error 会让上层误判整条连接失败并停止自愈。
      this.provider.logConnectionEvent(this, 'ice_candidate_dropped', {
        message: error instanceof Error ? error.message : String(error),
      });
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
        this.provider.logConnectionEvent(this, 'ice_candidate_dropped', {
          message: error instanceof Error ? error.message : String(error),
        });
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

  /**
   * 'disconnected' 是可自愈的瞬态：跨网络、中继抖动、Wi-Fi/蜂窝切换时都很常见，ICE 往往
   * 几秒内自行恢复。若在当帧就关连接，一次抖动会被上层看成断链并触发一轮重连。这里给它
   * 一个宽限期，恢复 connected 就继续复用；'failed'/'closed' 仍然立即关闭。
   */
  protected handleConnectionStateChange(state: RTCPeerConnectionState): void {
    if (state === 'connected') {
      this.clearTransportTimers();
      this.iceRestartAttempted = false;
      return;
    }
    if (state === 'failed' || state === 'closed') {
      this.handleTransportClosed();
      return;
    }
    if (state !== 'disconnected' || this.closed) return;

    if (this.transportGraceTimer === null) {
      this.transportGraceTimer = window.setTimeout(() => {
        this.transportGraceTimer = null;
        if (this.closed) return;
        this.provider.logConnectionEvent(this, 'pc_disconnected_grace_expired', {
          state: this.peerConnection.connectionState,
        });
        this.handleTransportClosed();
      }, CONNECTION_TIMINGS.TRANSPORT_DISCONNECTED_GRACE_MS);
    }

    // 只有发起 offer 的一侧能 restart（answerer 主动换候选需要重协商，代价更高）；
    // 先给 ICE 自愈窗口，再由 initiator 主动换路径。
    if (this.isInitiator && !this.iceRestartAttempted && this.iceRestartTimer === null) {
      this.iceRestartTimer = window.setTimeout(() => {
        this.iceRestartTimer = null;
        void this.attemptIceRestart();
      }, CONNECTION_TIMINGS.TRANSPORT_ICE_RESTART_DELAY_MS);
    }
  }

  private async attemptIceRestart(): Promise<void> {
    if (this.closed || this.peerConnection.connectionState !== 'disconnected') return;
    this.iceRestartAttempted = true;
    this.provider.logConnectionEvent(this, 'pc_ice_restart_started', {
      state: this.peerConnection.connectionState,
    });
    try {
      this.peerConnection.restartIce();
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      this.provider.forwardOffer(this, offer);
    } catch (error) {
      this.provider.logConnectionEvent(this, 'pc_ice_restart_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      this.handleTransportClosed();
      return;
    }
    if (this.closed || this.isTransportConnected()) return;
    // restart 后新路径还要重新 gather/连通，顺延关闭期限，避免刚发出就被宽限计时器掐掉。
    this.clearTransportGraceTimer();
    this.transportGraceTimer = window.setTimeout(() => {
      this.transportGraceTimer = null;
      if (this.closed) return;
      this.handleTransportClosed();
    }, CONNECTION_TIMINGS.TRANSPORT_ICE_RESTART_GRACE_MS);
  }

  /** answerer 收到同一 connectionId 的重协商 offer（ICE restart）时，原地应答而不新建连接。 */
  async answerRenegotiation(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) return;
    await this.applyRemoteDescription(description);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    this.provider.forwardAnswer(this, answer);
    if (this.closed || this.isTransportConnected()) return;
    // answerer 不能主动 restart，但仍需给新候选留出连通窗口；否则纯中继下只剩
    // initiator 侧 6s 的重启延迟，答案刚发出就被宽限计时器关掉。
    this.clearTransportGraceTimer();
    this.transportGraceTimer = window.setTimeout(() => {
      this.transportGraceTimer = null;
      if (this.closed) return;
      this.handleTransportClosed();
    }, CONNECTION_TIMINGS.TRANSPORT_ICE_RESTART_GRACE_MS);
  }

  private isTransportConnected(): boolean {
    return this.peerConnection.connectionState === 'connected';
  }

  private clearTransportGraceTimer(): void {
    if (this.transportGraceTimer !== null) {
      window.clearTimeout(this.transportGraceTimer);
      this.transportGraceTimer = null;
    }
  }

  private clearTransportTimers(): void {
    this.clearTransportGraceTimer();
    if (this.iceRestartTimer !== null) {
      window.clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
  }

  protected handleTransportClosed(): void {
    if (this.closed) return;
    this.clearTransportTimers();
    this.closed = true;
    this.open = false;
    this.provider.removeConnection(this);
    try {
      this.peerConnection.close();
    } catch {
      // Ignore close errors.
    }
    // 关闭可能由 datachannel、peerConnection 状态或宽限计时器触发，而且这些触发会互相
    // 嵌套（pc.close() 会让 datachannel 再关一次）。上层只应收到一次 close。
    if (!this.closeEmitted) {
      this.closeEmitted = true;
      this.emitClose();
    }
  }

  /** 子类在这里把 close 发给上层；由 BaseConnection 保证只发一次。 */
  protected emitClose(): void {}

  close(): void {
    if (this.closed) return;
    this.handleTransportClosed();
  }
}

export class DataConnection extends BaseConnection<DataConnectionEvents> {
  public dataChannel: RTCDataChannel | null = null;

  constructor(
    provider: WorkerSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection,
    isInitiator = false
  ) {
    super(provider, peerId, connectionId, peerConnection, isInitiator);
  }

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

  protected override emitClose(): void {
    this.emit('close');
  }

  override close(): void {
    if (this.dataChannel && this.dataChannel.readyState !== 'closed') {
      try {
        this.dataChannel.close();
      } catch {
        // Ignore close errors.
      }
    }
    super.close();
  }
}

export class MediaConnection extends BaseConnection<MediaConnectionEvents> {
  private remoteStream = new MediaStream();
  private answered = false;

  constructor(
    provider: WorkerSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection,
    isInitiator = false
  ) {
    super(provider, peerId, connectionId, peerConnection, isInitiator);
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
      // 媒体连接没有 data channel 兜底，必须走同一套状态处理（含 'disconnected' 宽限），
      // 否则屏幕共享仍然会把可自愈的抖动当断链。
      this.handleConnectionStateChange(state);
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

  protected override emitClose(): void {
    this.emit('close');
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

  private config: RTCConfiguration;
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
  private signalingOpenedAt: number | null = null;
  private awaitingPong = false;
  private registrationRejected = false;
  /**
   * 信令 WS 短暂断开时，answer 与 trickle ICE 候选会无处可发。直接丢弃会让纯中继
   * 路径彻底失败（relay 候选恰好是在断开窗口里 gather 出来的），这里先排队，
   * 同一条信令会话重连成功后再补发；超过上限则丢最旧的，避免内存无限增长。
   */
  private pendingSignaling: SignalingEnvelope[] = [];
  private static readonly MAX_PENDING_SIGNALING = 256;

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

  /**
   * TURN 短期凭证默认 1 小时过期。PeerRuntime 在构造时把 iceServers 冻结进
   * RTCConfiguration，长会话中新接入的连接会拿着过期凭证去 gather relay 候选。
   * 已建立的 RTCPeerConnection 也要同步：传输层在断链后会 restartIce，若仍握着
   * 1 小时前的 TURN 凭证，relay-only 网络下重启会直接失败。
   */
  updateIceServers(iceServers: RTCIceServer[]): void {
    if (this.destroyed || !Array.isArray(iceServers) || iceServers.length === 0) return;
    this.config = { ...this.config, iceServers };
    for (const bucket of Object.values(this.connections)) {
      for (const connection of bucket) {
        try {
          connection.peerConnection.setConfiguration({ ...this.config, iceServers });
        } catch (error) {
          this.logConnectionEvent(connection, 'ice_servers_update_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
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
    // 终态拒绝只针对「被拒的那一次注册」。自动重连不会走到这里（终态路径直接 return），
    // 所以在这里复位不会重新制造重连循环；反之不复位会让一个实例被拒一次后永久失联。
    this.registrationRejected = false;
    const url = createSignalingUrl(this.id, this.options);
    this.log('info', 'signaling_ws_connect_start', {
      url: redactSignalingUrl(url),
      signalingBase: SIGNALING_BASE,
      signalingPath: SIGNALING_PATH,
    });
    const websocket = new WebSocket(url);
    this.websocket = websocket;
    // 只处理「当前」socket 的事件：旧 socket 迟到的 close/error/message 不应该再改写
    // 重连状态（例如把刚建立的新连接的退避计数清零，或给新连接打上终态标记）。
    websocket.onopen = () => {
      if (this.websocket !== websocket) return;
      this.disconnected = false;
      this.signalingOpenedAt = Date.now();
      this.startHeartbeat();
      this.log('info', 'signaling_ws_open', { url: redactSignalingUrl(url) });
    };
    websocket.onmessage = (event) => {
      if (this.websocket !== websocket) return;
      this.handleSignalingMessage(event.data);
    };
    websocket.onerror = () => {
      if (this.websocket !== websocket) return;
      if (this.destroyed) return;
      const error = createRuntimeError('socket-error', 'Signaling WebSocket connection failed');
      if (!this.openedOnce) {
        this.rejectReadyPromise(error);
      }
      this.log('error', 'signaling_ws_error');
      this.emit('error', error);
    };
    websocket.onclose = (event) => {
      if (this.websocket !== websocket) return;
      const wasOpened = this.openedOnce;
      this.websocket = null;
      this.stopHeartbeat();
      // 退避计数只在「这次连接确实稳定存活过」后才清零；否则「握手成功→立刻被服务端关」
      // 会让 onopen 每次都把退避重置成 1s，形成无休止的快速重连。
      const signalingOpenedAt = this.signalingOpenedAt;
      this.signalingOpenedAt = null;
      if (
        shouldResetReconnectBudget({
          connectedSinceMs: signalingOpenedAt,
          nowMs: Date.now(),
          stableWindowMs: CONNECTION_TIMINGS.SIGNALING_RECONNECT_STABLE_MS,
        })
      ) {
        this.reconnectAttempts = 0;
      }
      if (this.destroyed || this.isManualClose) {
        return;
      }
      this.disconnected = true;
      if (this.registrationRejected) {
        this.log('warn', 'signaling_registration_rejected_close');
        return;
      }
      const terminalClose = TERMINAL_SIGNALING_CLOSE_CODES.get(event.code);
      if (terminalClose) {
        // 这一层连接已被服务端明确拒绝，重连只会制造「一直重连」的假象。
        this.registrationRejected = true;
        const error = createRuntimeError(terminalClose.type, terminalClose.message);
        this.log('warn', 'signaling_terminal_close', {
          code: event.code,
          reason: event.reason || undefined,
          wasOpened,
        });
        if (!this.openedOnce) {
          this.rejectReadyPromise(error);
        }
        this.emit('error', error);
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
    if (this.reconnectAttempts >= CONNECTION_TIMINGS.MAX_SIGNALING_RECONNECT_ATTEMPTS) {
      // 退避已封顶还要继续重连，只会让界面永远停在「正在连接」；停下来把原因交给上层。
      const error = createRuntimeError('disconnected', 'Signaling reconnect attempts exhausted');
      this.log('error', 'signaling_reconnect_exhausted', { attempts: this.reconnectAttempts });
      if (!this.openedOnce) {
        this.rejectReadyPromise(error);
      }
      this.emit('error', error);
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
      this.reconnectInternal();
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
      } else {
        // 自动重连成功：'open' 只会在首次注册时发一次，上层需要单独的事件把
        // 「正在连接服务器 / 已掉线」恢复成就绪，否则 UI 会永远停在连接中。
        this.flushPendingSignaling();
        this.emit('signaling:restored', this.id);
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
        // 服务端随后也会关掉这条 socket；这里主动关一次，避免「已被顶替/已被拒绝」的连接
        // 继续占着服务端会话名额（close 帧是否送达取决于运行时，不能依赖它）。
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
          try {
            this.websocket.close(1000, 'Terminal signaling error');
          } catch {
            // Ignore close errors.
          }
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
    const existing = this.connectionIndex.get(payload.connectionId);
    if (existing) {
      // 同一 connectionId 的 offer 只可能是重协商（ICE restart）；重复投递的初始 offer
      // 用 ufrag 区分，直接忽略，避免把健康连接重建或关掉。
      const currentUfrag = extractIceUfrag(existing.peerConnection.remoteDescription ?? undefined);
      const nextUfrag = extractIceUfrag(payload.description);
      if (currentUfrag !== null && currentUfrag === nextUfrag) return;
      if (existing.peerConnection.signalingState !== 'stable') return;
      void existing.answerRenegotiation(payload.description).catch((error) => {
        this.emitConnectionError(
          existing,
          createRuntimeError('webrtc-error', 'Failed to answer renegotiation offer', error)
        );
        existing.close();
      });
      return;
    }
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
    // 连接已关，排队的 restart offer/answer 再发出去只会在对端建一条没人认领的僵尸 PC。
    this.pendingSignaling = this.pendingSignaling.filter(
      (pending) => !('connectionId' in pending) || pending.connectionId !== connection.connectionId
    );
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
      // offer/answer/候选都可以等 WS 重连后补发（对端通常还在同一个连接尝试里等）；
      // ping 这类依赖即时往返的报文必须立即成功，否则按原逻辑报错。
      if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
        if (this.pendingSignaling.length >= WorkerSignaledPeer.MAX_PENDING_SIGNALING) {
          // 先丢候选：offer/answer 丢了整次协商就白费，候选后续还能重新收集。
          const candidateIndex = this.pendingSignaling.findIndex(
            (pending) => pending.type === 'ice-candidate',
          );
          this.pendingSignaling.splice(candidateIndex >= 0 ? candidateIndex : 0, 1);
        }
        this.pendingSignaling.push(message);
        return;
      }
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

  private flushPendingSignaling(): void {
    if (this.pendingSignaling.length === 0) return;
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
    const pending = this.pendingSignaling.splice(0);
    for (const message of pending) {
      if (
        'connectionId' in message &&
        message.connectionId &&
        !this.connectionIndex.has(message.connectionId)
      ) {
        continue;
      }
      this.sendSignaling(message);
    }
  }

  forwardOffer(connection: BaseConnection<any>, description: RTCSessionDescriptionInit): void {
    this.sendSignaling({
      type: 'offer',
      connectionId: connection.connectionId,
      kind: connection instanceof DataConnection ? 'data' : 'media',
      sourcePeerId: this.id,
      targetPeerId: connection.peer,
      description,
    });
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
    const connection = new DataConnection(this, targetPeerId, createId('data'), peerConnection, true);
    const channel = peerConnection.createDataChannel('data', { ordered: true });
    connection.bindDataChannel(channel);
    this.addConnection(connection);
    void this.startOutgoingOffer(connection, 'data');
    return connection;
  }

  call(targetPeerId: string, stream?: MediaStream): MediaConnection {
    const peerConnection = new RTCPeerConnection(this.config);
    const call = new MediaConnection(this, targetPeerId, createId('media'), peerConnection, true);
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

  /** 显式重连（用户重试、屏幕共享兜底）：重新给一轮退避预算。 */
  reconnect(): void {
    if (this.destroyed) return;
    if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.reconnectAttempts = 0;
    this.reconnectInternal();
  }

  /** 自动退避重连：保留计数，避免「能握手但立刻被关」时无限重试。 */
  private reconnectInternal(): void {
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

  /**
   * 自动恢复用的重连：不重置退避预算，预算耗尽后拒绝再建 socket 并返回 false。
   * 与 reconnect() 的区别只在「谁应决定预算」——用户显式重试可以重开一轮，后台自动
   * 恢复必须受同一个上限约束，否则屏端恢复逻辑会把无限重连带回来。
   */
  retrySignaling(): boolean {
    if (this.destroyed || this.isManualClose) return false;
    // 服务端已经明确拒绝过（4029/1009/被顶替）：自动路径不要反复撞墙，交给调用方换一条
    // 信令会话（例如屏端重建 peer）。显式 reconnect() 仍然允许用户重开一轮。
    if (this.registrationRejected) return false;
    if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
      return false;
    }
    if (this.reconnectAttempts >= CONNECTION_TIMINGS.MAX_SIGNALING_RECONNECT_ATTEMPTS) {
      return false;
    }
    this.reconnectAttempts += 1;
    this.reconnectInternal();
    return true;
  }

  /**
   * retrySignaling() 返回 false 可能是因为「本来就好/正在重连」，也可能是「救不回来」。
   * 调用方不能把前者当成失败并重建 peer——那会在 WS 正常的 CONNECTING 窗口里换掉
   * peerId 并关掉所有媒体连接。这里把状态显式分开。
   */
  signalingRecoveryState():
    | 'connected'
    | 'connecting'
    | 'idle'
    | 'rejected'
    | 'exhausted'
    | 'destroyed' {
    if (this.destroyed) return 'destroyed';
    if (this.registrationRejected) return 'rejected';
    if (this.websocket?.readyState === WebSocket.OPEN) return 'connected';
    if (this.websocket?.readyState === WebSocket.CONNECTING || this.reconnectTimer !== null) {
      return 'connecting';
    }
    if (this.reconnectAttempts >= CONNECTION_TIMINGS.MAX_SIGNALING_RECONNECT_ATTEMPTS) {
      return 'exhausted';
    }
    return 'idle';
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.isManualClose = true;
    this.pendingSignaling = [];
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

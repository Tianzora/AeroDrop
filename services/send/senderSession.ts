import { CONNECTION_TIMINGS, EXPIRY_DURATIONS, type ExpiryOption } from '../../constants/transfer';
import { P2P_PROTOCOL_VERSION, type FileMetadata } from '../../types';
import {
  NO_TURN_WARNING_MESSAGE,
  SHARE_EXPIRED_REMAINING_TEXT,
  SHARE_SIGNALING_LOST_MESSAGE,
  getPeerRuntimeErrorMessage,
  isShareSessionLostError,
} from '../connectionGuidance';
import { loadPeerRuntime, type Peer } from '../peerRuntime';
import { createSessionActivityTracker } from '../sessionActivityTracker';
import { clampShareCodeTtlSeconds } from '../shareCodeRegistry';
import {
  isValidShareCode,
  requestShareCode,
  resumeShareSession,
  revokeShareSession,
} from '../shareCodeSession';
import { getIceConfig, type IceConfigResult } from '../stunService';

/**
 * 发送端「分享会话」的编排：口令登记/续期/延迟注销/resume、TTL 计时、
 * TURN 凭证刷新、信令建连超时重试、PeerRuntime 的创建与销毁。
 *
 * 组件只负责渲染与传输（DataConnection）逻辑；这里不 import React，也不碰
 * DataConnection，通过 {@link SenderSessionHost} 把 UI 状态和 peer 监听交回组件。
 */

export type SenderSharePhase = 'preparing' | 'waiting' | 'configuring' | 'error';
export type SenderPreparingStage = 'fetching_ice' | 'connecting_signaling';

export type SenderShareRegistration = {
  code: string;
  peerId: string;
  secret: string;
  secretHash: string;
};

/** 与宿主（组件）的边界：所有 setState、通知、telemetry 都从这里进。 */
export interface SenderSessionHost {
  /** 交给组件挂 'connection' 等传输监听，同时记进 peerRef。 */
  attachPeer: (peer: Peer, metadata: FileMetadata) => void;
  getPeer: () => Peer | null;
  /** 组件侧延迟销毁 peer（保留 stop 后 100ms 再 destroy 的既有语义）。 */
  destroyPeer: (peer: Peer) => void;
  setPhase: (phase: SenderSharePhase, errorMessage?: string) => void;
  setPreparingStage: (stage: SenderPreparingStage) => void;
  setShareCode: (code: string) => void;
  setRemainingTime: (text: string) => void;
  /**
   * 状态行的可见文案（空串 = 恢复正常）。用于「分享已失效但传输还在跑」这类
   * 不该打到错误页、又不能让界面显示一切正常的中间态。
   */
  setConnectionStatus: (status: string) => void;
  /**
   * 持久降级位：「这个口令已经作废」，不是一条会过期的提示。授权被撤或口令被注销后，
   * 界面必须一直显示已失效——30 秒后自动消失的提示会让状态行回到「等待连接」，
   * 而用户手里那个口令其实已经连不上了。
   */
  setShareRevoked: (message: string | null) => void;
  setMetadata: (metadata: FileMetadata) => void;
  notify: (message: string, type: 'success' | 'info' | 'error') => void;
  getActiveTransfers: () => number;
  getActiveConnectionCount: () => number;
  /** 组件已卸载或正在停止分享：任何异步回写都必须放弃。 */
  isUnavailable: () => boolean;
  /** ICE 配置到手：组件据此做路由选型与 telemetry。 */
  onIceConfig: (iceConfig: IceConfigResult) => void;
  markSignalingOpen: () => void;
  markConnectionSuccess: (code: string) => void;
  markConnectionFailure: (reason: string) => void;
  markSessionEvent: (event: string, data?: Record<string, unknown>) => void;
  /** 抑制噪声后的 peer 错误日志。 */
  logPeerError: (error: unknown) => void;
  /** TTL 正常到期且没有在途传输：组件要走完整的「停止分享」清理，而不只是停信令。 */
  onShareEnded: () => void;
  /** pagehide 的延迟注销没能在窗口内 resume：组件应走完整的停止流程。 */
  onSessionLost: () => void;
}

export interface SenderSessionClock {
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

export interface SenderSessionDeps {
  getIceConfig: typeof getIceConfig;
  loadPeerRuntime: typeof loadPeerRuntime;
  requestShareCode: typeof requestShareCode;
  revokeShareSession: typeof revokeShareSession;
  resumeShareSession: typeof resumeShareSession;
  createPeerId: () => string;
  sendPauseBeacon: (url: string, body: string) => boolean;
  clock: SenderSessionClock;
  revokeGraceMs: number;
  renewalIntervalMs: number;
  signalingOpenTimeoutMs: number;
  maxSignalingOpenRetry: number;
}

export interface SenderSessionStartInput {
  metadata: FileMetadata;
  expiryOption: ExpiryOption;
  customCode?: string;
  peerDebugLevel?: number;
}

const defaultClock: SenderSessionClock = {
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (handle) => window.clearInterval(handle),
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
  now: () => Date.now(),
};

const pauseBeacon = (url: string, body: string): boolean => {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
  const beacon = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon(url, beacon)) return true;
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    cache: 'no-store',
  }).catch(() => {});
  return true;
};

const defaultDeps: SenderSessionDeps = {
  getIceConfig,
  loadPeerRuntime,
  requestShareCode,
  revokeShareSession,
  resumeShareSession,
  createPeerId: () => `peer-${crypto.randomUUID()}`,
  sendPauseBeacon: pauseBeacon,
  clock: defaultClock,
  revokeGraceMs: CONNECTION_TIMINGS.SHARE_CODE_REVOKE_GRACE_MS,
  renewalIntervalMs: CONNECTION_TIMINGS.SHARE_CODE_RENEWAL_INTERVAL_MS,
  signalingOpenTimeoutMs: CONNECTION_TIMINGS.SENDER_SIGNALING_OPEN_TIMEOUT_MS,
  maxSignalingOpenRetry: CONNECTION_TIMINGS.SENDER_MAX_SIGNALING_OPEN_RETRY,
};

const formatRemaining = (diffMs: number): string => {
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export class SenderSession {
  private readonly host: SenderSessionHost;
  private readonly deps: SenderSessionDeps;
  private readonly activity = createSessionActivityTracker();

  private registration: SenderShareRegistration | null = null;
  private paused = false;
  private expiresAt: number | undefined;
  private expiryHandled = false;
  private renewalTimer: number | null = null;
  private iceRefreshTimer: number | null = null;
  private countdownTimer: number | null = null;
  private signalingOpenTimer: number | null = null;
  private pendingRelease: Promise<void> | null = null;
  private lifecycleAttached = false;

  constructor(host: SenderSessionHost, deps: Partial<SenderSessionDeps> = {}) {
    this.host = host;
    this.deps = { ...defaultDeps, ...deps };
  }

  /** 当前分享活动的令牌：信令回调用它判断自己是否已过期。 */
  getActivityToken(): number {
    return this.activity.current();
  }

  isActivityCurrent(token: number): boolean {
    return this.activity.isCurrent(token);
  }

  /** pagehide/pageshow/visibilitychange 的监听由会话自己挂，组件不再重复。 */
  attachLifecycleListeners(): void {
    if (this.lifecycleAttached) return;
    this.lifecycleAttached = true;
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  dispose(): void {
    if (this.lifecycleAttached) {
      window.removeEventListener('pagehide', this.handlePageHide);
      window.removeEventListener('pageshow', this.handlePageShow);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.lifecycleAttached = false;
    }
    this.clearCountdown();
    this.clearSignalingTimeout();
    this.clearIntervalTimer('renewal');
    this.clearIntervalTimer('iceRefresh');
  }

  async start(input: SenderSessionStartInput): Promise<void> {
    // 上一次停止分享的 DELETE 可能还在路上：先等它落地，否则用同一个自定义码重新开始
    // 时新 POST 会先到服务端并拿到 409（「该口令已被占用」）。
    const pendingRelease = this.pendingRelease;
    if (pendingRelease) await pendingRelease;

    const token = this.activity.begin();
    this.expiryHandled = false;
    this.expiresAt = undefined;
    // 新一轮分享从干净状态开始：上一次的「分享已失效」提示不能残留到新口令上。
    this.host.setConnectionStatus('');
    this.host.setShareRevoked(null);
    this.host.setPhase('preparing');
    this.host.setPreparingStage('fetching_ice');

    const expiryDuration = EXPIRY_DURATIONS[input.expiryOption];
    this.expiresAt = expiryDuration === undefined ? undefined : this.deps.clock.now() + expiryDuration;
    const metadataWithConstraints: FileMetadata = {
      ...input.metadata,
      protocolVersion: P2P_PROTOCOL_VERSION,
      constraints: { expiresAt: this.expiresAt },
    };
    this.host.setMetadata(metadataWithConstraints);

    const iceConfig = await this.deps.getIceConfig();
    if (!this.isActivityCurrent(token) || this.host.isUnavailable()) return;

    this.host.onIceConfig(iceConfig);
    this.host.setPreparingStage('connecting_signaling');
    if (iceConfig.hasTurn && (iceConfig.iceTransportPolicy === 'relay' || iceConfig.relayRecommended)) {
      this.host.notify('当前网络可能需要中继，将同时尝试直连与中继，最终路径以实际连通结果为准', 'info');
    } else if (!iceConfig.hasTurn) {
      this.host.notify(NO_TURN_WARNING_MESSAGE, 'info');
    }

    await this.createSharePeer(0, token, input, metadataWithConstraints, iceConfig);
  }

  /** 注销口令并停止续期，但不触碰已建立的 Peer/DataConnection。 */
  async release(): Promise<void> {
    this.clearIntervalTimer('renewal');
    this.clearIntervalTimer('iceRefresh');
    const registration = this.registration;
    this.registration = null;
    this.paused = false;
    if (!registration) return;

    // 注销失败不影响本地停止分享（码会在 TTL 后自然过期）。
    // 返回 Promise 是为了让「注销后立刻重登记同一个自定义码」的路径能等 DELETE 生效。
    const pending = this.deps.revokeShareSession(registration).then(
      () => {},
      () => {},
    );
    this.pendingRelease = pending;
    try {
      await pending;
    } finally {
      if (this.pendingRelease === pending) this.pendingRelease = null;
    }
  }

  stop(): void {
    void this.release();
    // 令牌 +1 让所有在途回调作废（包括还没回来的口令登记与信令重试）。
    this.activity.begin();
    this.clearSignalingTimeout();
    this.clearCountdown();
    const peer = this.host.getPeer();
    if (peer) this.host.destroyPeer(peer);
  }

  private async createSharePeer(
    attempt: number,
    token: number,
    input: SenderSessionStartInput,
    metadataWithConstraints: FileMetadata,
    iceConfig: IceConfigResult,
  ): Promise<void> {
    // 口令一律 6 位、由服务端登记并与随机 peerId 绑定；用户手填的 6 位码同样走登记流程
    // （已被占用会返回 taken，不会悄悄降级成别的码）。
    const requestedCode = input.customCode && isValidShareCode(input.customCode) ? input.customCode : undefined;
    // 信令建连超时后会重试：此时口令已经登记过，再调一次登记接口只会拿到 409
    // （或者把码改绑）。直接复用上一次的 peerId + secret。
    const previousRegistration = this.registration;
    const reuseRegistration = Boolean(
      previousRegistration && (!requestedCode || previousRegistration.code === requestedCode),
    );

    // 口令有效期跟随用户选择（服务端上限 24h）；「永久」按上限登记并在分享期间自动续期。
    const shareTtlSeconds = clampShareCodeTtlSeconds(
      Math.round((EXPIRY_DURATIONS[input.expiryOption] ?? 86_400_000) / 1000),
    );

    let senderPeerId: string;
    let displayCode: string;
    let signalingToken: string;
    if (reuseRegistration && previousRegistration) {
      senderPeerId = previousRegistration.peerId;
      displayCode = previousRegistration.code;
      signalingToken = previousRegistration.secret;
    } else {
      senderPeerId = this.deps.createPeerId();
      const registration = await this.deps.requestShareCode({
        peerId: senderPeerId,
        requestedCode,
        ttlSeconds: shareTtlSeconds,
      });

      if (registration.status !== 'ok') {
        if (!this.isActivityCurrent(token)) return;
        const message = registration.status === 'taken'
          ? getPeerRuntimeErrorMessage('unavailable-id')
          : registration.status === 'rate-limited'
            ? '创建口令过于频繁，请稍后再试'
            : '创建分享口令失败，请重试';
        this.host.setPhase('error', message);
        return;
      }

      // 登记是网络往返：返回时组件可能已卸载/分享已停止。此时不能把码写回状态，
      // 否则没人会再注销它，码会一直占着到 TTL。
      if (!this.isActivityCurrent(token) || this.host.isUnavailable()) {
        void this.deps.revokeShareSession({
          code: registration.code,
          peerId: senderPeerId,
          secret: registration.secret,
        }).catch(() => {});
        return;
      }

      displayCode = registration.code;
      signalingToken = registration.secret;
      this.registration = {
        code: registration.code,
        peerId: senderPeerId,
        secret: registration.secret,
        secretHash: registration.secretHash,
      };
      this.startIceRefresh(token);
      if (input.expiryOption === 'never') this.startRenewal(token);
    }

    const signalingCode = displayCode;
    let customPeer: Peer;
    try {
      const { default: PeerRuntime } = await this.deps.loadPeerRuntime();
      customPeer = new PeerRuntime(senderPeerId, {
        debug: input.peerDebugLevel ?? 0,
        pingInterval: 5000,
        signalingCode,
        signalingToken,
        config: {
          iceServers: iceConfig.iceServers,
          iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
          iceTransportPolicy: iceConfig.iceTransportPolicy,
        },
      });
    } catch {
      if (!this.isActivityCurrent(token)) return;
      await this.release();
      this.host.setPhase('error', '加载连接模块失败，请重试');
      return;
    }

    if (!this.isActivityCurrent(token) || this.host.isUnavailable()) {
      try { customPeer.destroy(); } catch {}
      return;
    }

    this.clearSignalingTimeout();
    this.signalingOpenTimer = this.deps.clock.setTimeout(() => {
      if (!this.isActivityCurrent(token) || this.host.isUnavailable()) return;
      if (this.host.getPeer() !== customPeer) return;
      this.host.markSessionEvent('signaling_open_timeout', { attempt });
      try { customPeer.destroy(); } catch {}
      // 重试复用已登记的口令（同一 peerId/secret），不需要先 DELETE 再 POST：
      // 那会多烧一次分享码预算（POST 10 次/10s），弱网抖动时可能把自己限流。
      if (attempt < this.deps.maxSignalingOpenRetry) {
        this.host.setPreparingStage('connecting_signaling');
        void this.createSharePeer(attempt + 1, token, input, metadataWithConstraints, iceConfig);
        return;
      }
      // 最终失败：注销口令，否则它会占码到 TTL（接收端表现为「连接超时」）。
      void this.release().then(() => {
        if (!this.isActivityCurrent(token) || this.host.isUnavailable()) return;
        this.host.setPhase('error', '准备传输节点超时，请重试');
      });
    }, this.deps.signalingOpenTimeoutMs);

    const clearSignalingOpenTimeout = () => this.clearSignalingTimeout();
    customPeer.on('open', () => {
      clearSignalingOpenTimeout();
      if (!this.isActivityCurrent(token) || this.host.getPeer() !== customPeer) return;
      this.host.markSignalingOpen();
      this.host.markConnectionSuccess(signalingCode);
      this.host.setShareCode(signalingCode);
      this.host.setPreparingStage('fetching_ice');
      this.host.setPhase('waiting');
      this.host.setConnectionStatus('');
      this.host.setShareRevoked(null);
      this.startCountdown();
    });
    customPeer.on('error', (err) => {
      clearSignalingOpenTimeout();
      this.handlePeerError(err, token, customPeer);
    });

    this.host.attachPeer(customPeer, metadataWithConstraints);
  }

  private handlePeerError(err: { type?: string; message?: string }, token: number, peer: Peer): void {
    if (!this.isActivityCurrent(token) || this.host.getPeer() !== peer) return;
    // 状态一旦离开等待态，TTL 倒计时就要停（旧实现的倒计时 effect 依赖 state，离开
    // 等待态即 cleanup）。否则用户在重试表单里等到 TTL 到点，会被「分享已结束」清空
    // 表单并覆盖掉原来的错误文案。network/server/socket 三类不改变状态，倒计时继续。
    if (err.type === 'unavailable-id') {
      this.clearCountdown();
      this.host.markConnectionFailure('code_unavailable');
      this.host.setPhase('configuring', getPeerRuntimeErrorMessage('unavailable-id'));
    } else if (err.type === 'rate-limited' || err.type === 'message-too-large') {
      // 信令层已被服务端明确拒绝（每 IP 会话数超限 / 消息超限），重连不会自愈，
      // 给用户一个可操作的提示，不要在后台继续重连。
      this.clearCountdown();
      this.host.markConnectionFailure(err.type === 'rate-limited' ? 'rate_limited' : 'message_too_large');
      void this.release();
      if (this.host.getActiveConnectionCount() > 0) {
        // 有在途传输：setPhase('error') 会把传输列表从界面上撤掉，用户会以为文件也断了。
        // 改成状态位的降级提示——链接不能再发给新设备，已有连接照常传完。
        this.host.setConnectionStatus(SHARE_SIGNALING_LOST_MESSAGE);
        // 口令已被注销：降级位要留下，不能只是 30 秒的提示。
        this.host.setShareRevoked(SHARE_SIGNALING_LOST_MESSAGE);
        this.host.notify(SHARE_SIGNALING_LOST_MESSAGE, 'info');
        return;
      }
      this.host.setPhase('error', getPeerRuntimeErrorMessage(err.type));
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      return;
    } else {
      this.host.logPeerError(err);
      this.host.markConnectionFailure(`peer_error:${err.type}`);
      if (this.host.getActiveConnectionCount() === 0) {
        this.clearCountdown();
        void this.release();
        this.host.setPhase('error', getPeerRuntimeErrorMessage(err.type ?? ''));
      } else {
        // 有在途传输时信令可能再也回不来，但已有连接还能把文件传完。
        // 不提示的话用户会以为网络恢复后还能续传（旧实现在这里只弹一条 toast）。
        if (isShareSessionLostError(err.type)) {
          this.host.setConnectionStatus(SHARE_SIGNALING_LOST_MESSAGE);
          this.host.setShareRevoked(SHARE_SIGNALING_LOST_MESSAGE);
        }
        if (err.type === 'unauthorized' && !this.registration) {
          // 分享到期后口令已注销：信令重连会失败，但已有连接上的传输不受影响。
          this.host.notify('分享已过期，网络中断后将无法自动续传；当前传输不受影响', 'info');
        }
      }
    }
  }

  private startIceRefresh(token: number): void {
    this.clearIntervalTimer('iceRefresh');
    this.iceRefreshTimer = this.deps.clock.setInterval(() => {
      if (!this.isActivityCurrent(token)) return;
      void this.deps.getIceConfig()
        .then((fresh) => {
          // /api/ice-config 失败时会返回 STUN-only 回退配置；把它写回去等于
          // 主动丢掉中继能力，必须只在确实拿到 TURN 时才更新。
          if (!fresh.hasTurn) {
            this.host.markSessionEvent('ice_refresh_no_turn');
            return;
          }
          this.host.getPeer()?.updateIceServers(fresh.iceServers);
        })
        .catch(() => {
          this.host.markSessionEvent('ice_refresh_failed');
        });
    }, this.deps.renewalIntervalMs);
  }

  private startRenewal(token: number): void {
    this.clearIntervalTimer('renewal');
    // 同 peerId + 同 secret 的重新登记只是延长过期时间，不会换码。
    this.renewalTimer = this.deps.clock.setInterval(() => {
      if (!this.isActivityCurrent(token)) return;
      const current = this.registration;
      if (!current) return;
      void this.deps.requestShareCode({
        peerId: current.peerId,
        requestedCode: current.code,
        ttlSeconds: 86_400,
        secret: current.secret,
      })
        .then((result) => {
          // 409/429 都是正常返回而不是 reject；只看 catch 会把最常见的失败全部吞掉。
          if (result.status !== 'ok') {
            this.host.markSessionEvent('share_code_renewal_failed', {
              code: current.code,
              status: result.status,
            });
          }
        })
        .catch(() => {
          this.host.markSessionEvent('share_code_renewal_failed', {
            code: current.code,
            status: 'network',
          });
        });
    }, this.deps.renewalIntervalMs);
  }

  private startCountdown(): void {
    this.clearCountdown();
    if (this.expiresAt === undefined) {
      this.host.setRemainingTime('永久有效');
      return;
    }
    const expiresAt = this.expiresAt;
    const tick = () => {
      const diff = expiresAt - this.deps.clock.now();
      if (diff <= 0) {
        this.clearCountdown();
        this.handleExpiry();
        return;
      }
      this.host.setRemainingTime(formatRemaining(diff));
    };
    // 先装 interval 再 tick：若此刻已经过期，tick 里的 handleExpiry 会把它清掉，
    // 反过来则会在清理之后又新建一个空转的 interval。
    this.countdownTimer = this.deps.clock.setInterval(tick, 1000);
    tick();
  }

  private handleExpiry(): void {
    if (this.expiryHandled) return;
    this.expiryHandled = true;
    this.host.setRemainingTime('已过期');
    const activeTransfers = this.host.getActiveTransfers();
    // TTL 的语义是「不再接受新接收者」，不是掐断已经在传的数据。新连接在
    // peer.on('connection') 里已按 expiresAt 拒绝；这里只注销口令、停止续期。
    if (activeTransfers > 0) {
      this.host.markSessionEvent('share_expired_transfer_continues', { activeTransfers });
      this.host.notify('分享已过期，当前传输将继续完成', 'info');
      void this.release();
      return;
    }
    // 只做服务级 stop 会留下组件侧的等待页（口令已 revoke、连接仍开着），
    // 所以这里交给组件走一次完整的 stopSharing，再覆盖成「已结束」的错误态。
    this.stop();
    this.host.onShareEnded();
    this.host.setPhase('error', '分享时间已结束');
  }

  private handlePageHide = (event: PageTransitionEvent): void => {
    // pagehide 可能只是切后台/被系统挂起，立刻永久注销会把分享误杀。
    // 这里只登记一个延迟注销窗口；页面回到前台用同一凭证 resume。
    if (event.persisted) return;
    this.pause();
  };

  private handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    void this.resume();
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void this.resume();
  };

  pause(): void {
    const registration = this.registration;
    if (!registration) return;
    this.paused = true;
    const url = `/api/share-code/${encodeURIComponent(registration.code)}/revoke`;
    const body = JSON.stringify({
      peerId: registration.peerId,
      secretHash: registration.secretHash,
      graceMs: this.deps.revokeGraceMs,
    });
    this.deps.sendPauseBeacon(url, body);
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    const registration = this.registration;
    if (!registration) return;

    const resumed = await this.deps.resumeShareSession(registration);
    if (resumed) {
      this.host.setConnectionStatus('');
      this.host.setShareRevoked(null);
      return;
    }
    // 窗口已过或码已被回收：不要再让 UI 展示一个连不上的分享。
    if (this.registration !== registration) return;
    // 有在途传输时绝不能走 onSessionLost：那条路径会 stopSharing 并广播
    // TRANSFER_CANCELLED，把本来能自己跑完的传输直接掐断。
    if (this.host.getActiveTransfers() > 0) {
      // 口令已经被服务端注销，继续展示它会让用户把死码发给别人。
      this.host.setRemainingTime(SHARE_EXPIRED_REMAINING_TEXT);
      this.host.setConnectionStatus(SHARE_SIGNALING_LOST_MESSAGE);
      this.host.setShareRevoked(SHARE_SIGNALING_LOST_MESSAGE);
      this.host.notify('分享已失效，当前传输不受影响；需要继续分享请重新创建', 'info');
      return;
    }
    this.host.notify('分享已失效，请重新创建', 'error');
    this.host.onSessionLost();
  }

  private clearIntervalTimer(kind: 'renewal' | 'iceRefresh'): void {
    const handle = kind === 'renewal' ? this.renewalTimer : this.iceRefreshTimer;
    if (handle === null) return;
    this.deps.clock.clearInterval(handle);
    if (kind === 'renewal') this.renewalTimer = null;
    else this.iceRefreshTimer = null;
  }

  private clearCountdown(): void {
    if (this.countdownTimer === null) return;
    this.deps.clock.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  private clearSignalingTimeout(): void {
    if (this.signalingOpenTimer === null) return;
    this.deps.clock.clearTimeout(this.signalingOpenTimer);
    this.signalingOpenTimer = null;
  }
}

export const createSenderSession = (
  host: SenderSessionHost,
  deps: Partial<SenderSessionDeps> = {},
): SenderSession => new SenderSession(host, deps);

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { loadPeerRuntime, type Peer, type MediaConnection, type DataConnection } from '../services/peerRuntime';
import { getIceConfig } from '../services/stunService';
import {
  getPreferredScreenShareCodecOrder,
  getScreenShareBrowserProfile,
} from '../services/screenShareCompatibility';
import {
  clearScreenShareViewSession,
  writeScreenShareViewSession,
} from '../services/screenShareViewerSession';
import { ScreenShareUI, ScreenShareViewerConnectingStage } from './screen-share/ScreenShareUI';
import { logDebug } from '../services/diagnostics';
import {
  RATE_LIMITED_CONNECTION_MESSAGE,
  SHARER_RECONNECT_EXHAUSTED_MESSAGE,
  SIGNALING_SESSION_REJECTED_MESSAGE,
  SIGNALING_UNREACHABLE_MESSAGE,
  VIEWER_RECONNECT_EXHAUSTED_MESSAGE,
  VIEWER_SESSION_LIMIT_MESSAGE,
  VIEWER_SHARE_UNAVAILABLE_MESSAGE,
  VIEWER_SHARE_UNAVAILABLE_RETRY_MESSAGE,
  describeViewerReconnectWait,
  getMediaConnectionErrorMessage,
  getPeerRuntimeErrorMessage,
  getShareFullMessage,
  getSharerPeerRuntimeErrorMessage,
  getSuspectedShareFullMessage,
} from '../services/connectionGuidance';
import {
  deliverShareFull,
  planViewerAdmission,
  type ShareFullConnection,
} from '../services/screenShare/viewerAdmission';
import { VIEWER_DISCONNECT_GRACE_MS, decideViewerConnection } from '../services/screenShare/viewerConnectionPolicy';
import { planViewerReconnect } from '../services/screenShare/viewerReconnectPolicy';
import {
  CONNECTION_TIMINGS,
  SCREEN_SHARE_LIMITS,
  SCREEN_SHARE_VIEWER_CONNECT_TIMEOUT_MS,
} from '../constants/transfer';
import { SIGNALING_OFFER_RATE_LIMIT } from '../constants/signaling';
import {
  SCREEN_SHARE_CAPTURE_PRESETS,
  resolveAggregateQuality,
  resolveBitrateCap,
  resolvePerViewerBitrateCap,
  shouldDowngradeQuality,
  shouldUpgradeQuality,
  type ScreenShareQualityLevel,
} from '../services/screenShare/bitratePolicy';
import { decideViewerHeartbeat } from '../services/screenShare/viewerHeartbeatPolicy';
import { createSingleFlightSlot, type SingleFlightSlot } from '../services/screenShare/peerInitGuard';
import { describeViewerCapacity } from '../services/screenShare/viewerCapacity';
import {
  createScreenSharePeerId,
  isScreenShareRoomExpired,
  isTerminalScreenShareRoomFailure,
  registerScreenShareRoom,
  renewScreenShareRoom,
  revokeScreenShareRoom,
  revokeScreenShareRoomBeacon,
  type ScreenShareRoom,
  type ScreenShareRoomFailure,
} from '../services/screenShare/shareRoomRegistration';
import {
  forgetScreenShareSessionProof,
  rememberScreenShareSessionProof,
  resolveScreenSharePeerCredentials,
} from '../services/screenShare/screenShareSessionProof';
import {
  describeScreenCaptureFailure,
  type ScreenCaptureFailure,
} from '../services/screenShare/screenCaptureGuidance';
import { planViewerCallEndOutcome } from '../services/screenShare/viewerShareFullFallback';
import { planViewerPeerError } from '../services/screenShare/viewerPeerErrorPolicy';
import { planViewerErrorSurface } from '../services/screenShare/viewerErrorSurface';
import { releaseCapturedStream } from '../services/screenShare/shareStreamLifecycle';
import { createShareFullTelemetry } from '../services/screenShare/shareFullTelemetry';
import {
  planSharerFirstConnectWatchdog,
  planSharerRecovery,
  type SharerRecoveryDecision,
  type SharerSignalingState,
} from '../services/screenShare/sharerRecoveryPolicy';
import { planShareRoomExpiryCheck } from '../services/screenShare/shareRoomExpiry';
import { describeRetryCooldown } from '../services/screenShare/retryCooldown';
import { createShareStartNotice } from '../services/screenShare/shareStartNotice';

interface ScreenShareProps {
  onNotification: (message: string, type: 'success' | 'info' | 'error') => void;
  initialViewId?: string;
  /** 共享/观看/建连进行中时为 true：页面滑动据此禁用，避免误触切换页面中断画面 */
  onBusyChange?: (busy: boolean) => void;
}

type QualityLevel = ScreenShareQualityLevel;

const isEmbeddedFrame = () =>
  typeof window !== 'undefined' && window.self !== window.top;

const hasUserActivation = (): boolean => {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation ? activation.isActive : true;
};

/**
 * 观众的媒体连接是否还在跑。信令错误要不要落红条看这一条（见 viewerErrorSurface）。
 */
const viewerMediaIsHealthy = (connection: MediaConnection | null): boolean =>
  connection?.peerConnection?.connectionState === 'connected';

/**
 * 信令层把 Retry-After 挂在 error 上（`retryAfterMs`）。
 * 拿不到就返回 null，由调用方退回出口配额的静默期兜底——倒计时宁可偏长，
 * 也不能显示「立刻可重试」。
 */
const readRetryAfterMs = (error: unknown): number | null => {
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * 拒绝来自哪一层额度。
 *
 * 旧实现把所有 `rate-limited` 当成「请求太频繁」，于是每出口会话数被占满（12 个/IP，
 * 由别的标签页拿着）也会显示「60 秒后可重试」——而 60 秒后名额仍被占着，用户只会在
 * 同一个错误上反复点。服务端已经标了 `limit`，这里只做读取与兜底。
 */
const readRateLimitLayer = (error: unknown): 'session' | 'offer' | null => {
  const limit = (error as { limit?: unknown } | null)?.limit;
  if (limit === 'session' || limit === 'offer') return limit;
  return null;
};

const describeCaptureError = (error: unknown): ScreenCaptureFailure =>
  describeScreenCaptureFailure(error, {
    embedded: isEmbeddedFrame(),
    userActivation: hasUserActivation(),
  });

/**
 * 找到已经协商出来的音频 sender。不能看 sender.track：replaceTrack(null) 之后它会变成 null，
 * 但 transceiver 的 receiver 仍保留 audio 方向，之后换回带音频的源还能继续复用。
 */
const findLiveAudioSender = (pc: RTCPeerConnection | undefined): RTCRtpSender | null => {
  const transceiver = pc
    ?.getTransceivers()
    .find((item) => item.receiver.track?.kind === 'audio' && item.direction !== 'stopped');
  return transceiver?.sender ?? null;
};

export const ScreenShare: React.FC<ScreenShareProps> = ({ onNotification, initialViewId, onBusyChange }) => {
  const [isSharing, setIsSharing] = useState(false);
  const [isViewing, setIsViewing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // 共享/观看/建连中切走页面会直接结束画面：这几种状态都禁用侧滑切换。
  const isBusyForNavigation = isSharing || isViewing || isConnecting;
  useEffect(() => {
    onBusyChange?.(isBusyForNavigation);
  }, [isBusyForNavigation, onBusyChange]);
  const [viewerConnectingStage, setViewerConnectingStage] = useState<ScreenShareViewerConnectingStage>('');
  const [error, setError] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [isPeerReady, setIsPeerReady] = useState(false);
  // 信令层自己退避耗尽后不会再触发 isPeerReady 变化，用它把恢复 effect 再唤醒一次。
  const [sharerRecoveryTick, setSharerRecoveryTick] = useState(0);
  // 终态：信令/房号登记彻底失败，分享无法继续。它与「暂时连不上」不同——链接已失效、
  // 预览已停，UI 必须显示红色终态而不是绿色 LIVE。
  const [sharerFailure, setSharerFailure] = useState<{
    reason: 'signaling_failed';
    message: string;
    /**
     * 终止时是否已经有过可分享的链接。房号登记 429/连续超时的终态从来没生成过链接，
     * 再写「此前分享的链接已失效」就是自相矛盾的三句话（用户会以为刚刚发出去的链接死了）。
     */
    hadShareLink: boolean;
  } | null>(null);
  // 已登记到服务端的房号（peerId + 口令 + secret）。同一分享内的所有重建复用它。
  const [shareRoom, setShareRoom] = useState<ScreenShareRoom | null>(null);
  // 房号续期连续失败：链接还剩不到一个续期窗口就会过期。共享画面照常，但必须提示。
  const [shareRoomRenewalWarning, setShareRoomRenewalWarning] = useState(false);
  // 房号已经过期且没能续上：链接作废，界面不能再拿它配绿色「正在共享」。
  const [shareRoomExpired, setShareRoomExpired] = useState(false);
  // 限流冷却截止时间：服务端给过 Retry-After 就必须等它过去，否则点「重新开始共享」
  // 只是再吃一次 429，看起来像按钮坏了。
  const [shareRoomRetryAt, setShareRoomRetryAt] = useState<number | null>(null);
  // 观众侧被信令层限流后的冷却截止时间：这期间点「重试连接」只会再吃一次拒绝，
  // 必须像房号冷却一样显示倒计时并禁用按钮。
  const [viewerRetryAt, setViewerRetryAt] = useState<number | null>(null);
  // 冷却倒计时 tick：只为让剩余秒数重新计算，值本身不参与渲染。
  const [retryCooldownTick, setRetryCooldownTick] = useState(0);
  // 是否曾经连上过：用来区分「首连中」与「连上过又断了」，别把首次握手说成信令中断。
  const [hasBeenReady, setHasBeenReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [targetSharerId, setTargetSharerId] = useState<string | null>(null);


  const [needsPlayClick, setNeedsPlayClick] = useState(false);


  const hasInitialConnectedRef = useRef(false);


  const videoRef = useRef<HTMLVideoElement>(null);


  const streamRef = useRef<MediaStream | null>(null);


  const peerRef = useRef<Peer | null>(null);


  const mediaConnectionRef = useRef<MediaConnection | null>(null);


  const activeCallsRef = useRef<MediaConnection[]>([]);

  // 存储所有连接的观看者的数据通道（用于广播画质状态）
  const activeDataConnectionsRef = useRef<DataConnection[]>([]);
  // 观看者端：存储与分享者的数据通道
  const dataConnectionRef = useRef<DataConnection | null>(null);

  // 存储观看者的心跳时间戳 { peerId: timestamp }
  const viewerHeartbeatsRef = useRef<Record<string, number>>({});
  // 观看者端：心跳定时器
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 自动重连相关
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const viewerStatsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isManualStopRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const remoteShareEndedRef = useRef(false);
  // 分享端明确回过「人数已满」：不要再自动重连，否则会一直撞上限并误报成网络问题。
  const remoteShareFullRef = useRef(false);
  // 本次建连是否被信令层限流拒绝过：决定「call 被关」是按限流解释还是推测满员。
  const viewerRateLimitedRef = useRef(false);
  // 「分享者不在线」是同一次信令错误上的结论：call 的 error 先到、close 紧随其后。
  // 不记住它，close 分支就只看到「没画面」而误判成满员。
  const viewerSharerUnavailableRef = useRef(false);
  // 本次观众连接已经因为「分享者暂时查不到」重试过几次（分享端重建 Peer 期间会这样）。
  const shareUnavailableAttemptsRef = useRef(0);
  const remoteShareEndHandledRef = useRef(false);
  const sharerReconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const sharerReconnectAttemptsRef = useRef(0);
  // 这次信令连接是什么时候打开的：只有稳定存活过才重置重试预算，否则「握手成功即被关」
  // 会把计数一直清零，屏端的自动恢复又变成不限次数。
  const sharerPeerOpenedAtRef = useRef<number | null>(null);
  const sharerPeerRebuildsRef = useRef(0);
  const {
    SCREEN_SHARE_CONNECT_TIMEOUT_MS,
    SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS,
    SCREEN_SHARE_MAX_PEER_REBUILDS,
    SCREEN_SHARE_SHARE_UNAVAILABLE_MAX_RETRIES,
    SCREEN_SHARE_SHARE_UNAVAILABLE_RETRY_MS,
    SCREEN_SHARE_RECONNECT_BASE_DELAY_MS,
    SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
    SCREEN_SHARE_HEARTBEAT_INTERVAL_MS,
    SCREEN_SHARE_BANDWIDTH_MONITOR_INTERVAL_MS,
    SCREEN_SHARE_BANDWARMUP_MS,
    SCREEN_SHARE_VIEWER_STATS_INTERVAL_MS,
    SHARE_ROOM_REGISTRATION_MAX_TIMEOUTS,
    SHARE_ROOM_RETRY_COUNTDOWN_TICK_MS,
  } = CONNECTION_TIMINGS;
  const MAX_RECONNECT_ATTEMPTS = SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS;
  // 观看者端：连接过程的全局超时定时器
  const connectingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 每次连接尝试自增；await 回来后若已被取消/被新尝试取代，就不再建 peer。
  const viewerConnectAttemptRef = useRef(0);
  // 分享会话令牌：停止分享后让仍在 await 中的 initializePeer 作废，避免迟到注册占住会话名额。
  const peerSessionTokenRef = useRef(0);
  // 服务端登记的房号：每次开始分享登记一次；信令重建复用同一 peerId + code + secret，
  // 这样已发出去的链接不会失效，服务端也认这是同一会话（同 secretHash 才允许接管）。
  const shareRoomRef = useRef<ScreenShareRoom | null>(null);
  // 最后一次房号登记失败的原因：重试预算耗尽时用它给出具体文案（限流/占用/网络），
  // 而不是一律说成「无法连接信令服务器」。
  const shareRoomFailureRef = useRef<ScreenShareRoomFailure | null>(null);
  // 房号续期连续失败计数：达到 CONNECTION_TIMINGS.SHARE_ROOM_RENEWAL_MAX_FAILURES 才提示。
  const shareRoomRenewalFailuresRef = useRef(0);
  // 连续「登记超时」次数：服务端连续两次 8s 不响应就不是抖动，继续退避只会把界面
  // 永久停在「正在连接服务器」，要落成可操作终态。
  const shareRoomTimeoutsRef = useRef(0);
  // 初始化单飞闸门：开始共享/看门狗/恢复退避都可能触发 initializePeer，慢网络下会有第二次
  // 调用在上一次还没结束时进来。并发调用会各自登记房号，先登记的成为无人撤销的孤儿。
  const peerInitFlightRef = useRef<SingleFlightSlot>(createSingleFlightSlot());
  // 信令是否已经「坏到需要恢复」：只有它为真时恢复 effect 才会重试，避免刚点开始共享
  // （peer 正在握手）就被当成故障去重建。
  const sharerSignalingBrokenRef = useRef(false);
  // 终态只落一次：并发的 error/disconnected 回调不能重复收尾。
  const sharerFailureHandledRef = useRef(false);
  // conflict/终态要在 error 回调里停下整个分享，但那个回调创建在 failSharerSession
  // 定义之前，用 ref 取最新实现。
  const failSharerSessionRef = useRef<(message: string) => void>(() => {});
  // 正在 answer 途中、还没进 activeCalls 的观众：提前占住名额，避免并发超员。
  const pendingViewerPeersRef = useRef<Set<string>>(new Set());

  // 同一个 viewer 可能在旧 call 的 ICE 宽限期内重连，新的 MediaConnection 会复用同一个
  // peerId。监控器必须绑定到具体的 PeerConnection，否则新连接会继承旧 PC 的定时器。
  const bandwidthMonitorsRef = useRef<Map<string, {
    timer: ReturnType<typeof setInterval>;
    pc: RTCPeerConnection;
  }>>(new Map());


  const [qualityLevel, setQualityLevel] = useState<'high' | 'medium' | 'low'>('high');
  // 观看者端：当前的画质状态
  const [remoteQuality, setRemoteQuality] = useState<'high' | 'medium' | 'low'>('high');


  const qualityLevelRef = useRef<'high' | 'medium' | 'low'>('high');
  const peerQualityLevelRef = useRef<Map<string, 'high' | 'medium' | 'low'>>(new Map());
  // 只有中继需要成本上限；LAN/P2P 不设人为码率上限。
  const peerRelayRef = useRef<Map<string, boolean>>(new Map());
  const peerAppliedCapRef = useRef<Map<string, number>>(new Map());

  // 多个 viewer 同时降档时只提示一次，避免逐条带 peer 后缀的 toast 刷屏。
  const qualityNoticeAtRef = useRef(0);


  const qualityLabels = useMemo(() => ({
    high: '原画',
    medium: '高清',
    low: '流畅',
  }), []);

  // 「支持 6 人」不是承诺：建议人数由聚合上行预算推导，超过建议值只提示画质可能下降。
  const viewerCapacity = useMemo(
    () => describeViewerCapacity(SCREEN_SHARE_LIMITS.MAX_VIEWERS),
    [],
  );
  // 绿色 LIVE 只由「已登记 + 信令健康」驱动；isSharing 单独为真只代表还在采集与重连。
  const isShareLive = isSharing && isPeerReady;

  // share-full 送达失败计数：告知是 best-effort，静默失败必须能被看见。
  const shareFullTelemetry = useMemo(() => createShareFullTelemetry(), []);
  // 「已开始」提示要等信令 ready 才发：采集成功不等于观众能连上。
  const shareStartNotice = useMemo(() => createShareStartNotice(), []);

  // 限流冷却：剩余秒数跟着 tick 走，到点自动解除。房号登记与观众建连共用同一拍。
  useEffect(() => {
    if (shareRoomRetryAt === null && viewerRetryAt === null) return;
    const timer = window.setInterval(
      () => setRetryCooldownTick((tick) => tick + 1),
      SHARE_ROOM_RETRY_COUNTDOWN_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [shareRoomRetryAt, viewerRetryAt]);
  const shareRoomRetryCooldown = useMemo(
    () => describeRetryCooldown(shareRoomRetryAt, Date.now()),
    // retryCooldownTick 只负责触发重算，不参与取值。
    [shareRoomRetryAt, retryCooldownTick],
  );
  const viewerRetryCooldown = useMemo(
    () => describeRetryCooldown(viewerRetryAt, Date.now()),
    [viewerRetryAt, retryCooldownTick],
  );

  // 冷却到点就把截止时间清掉：否则 ticker 会为两个永远非 null 的 state 每秒重渲染
  // 这个 2800 行的组件，直到用户再点一次「开始共享」。
  useEffect(() => {
    if (shareRoomRetryAt !== null && describeRetryCooldown(shareRoomRetryAt, Date.now()).canRetry) {
      setShareRoomRetryAt(null);
    }
    if (viewerRetryAt !== null && describeRetryCooldown(viewerRetryAt, Date.now()).canRetry) {
      setViewerRetryAt(null);
    }
  }, [shareRoomRetryAt, viewerRetryAt, retryCooldownTick]);

  const browserProfile = useMemo(
    () =>
      getScreenShareBrowserProfile({
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        platform: typeof navigator === 'undefined' ? '' : navigator.platform,
        maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
      }),
    [],
  );

  const persistViewerSession = useCallback((sharerId: string) => {
    if (typeof window === 'undefined') return;
    writeScreenShareViewSession(
      (key, value) => window.sessionStorage.setItem(key, value),
      sharerId,
    );
  }, []);

  const clearPersistedViewerSession = useCallback(() => {
    if (typeof window === 'undefined') return;
    clearScreenShareViewSession((key) => window.sessionStorage.removeItem(key));
  }, []);

  // 分享端胶囊展示的是“大多数观看者”的画质，而不是最差的那个：单个弱网 viewer
  // 由它自己的降档处理，不应该让整个分享端看起来一直在降级。
  const getAggregateQualityLevel = useCallback((): 'high' | 'medium' | 'low' => {
    return resolveAggregateQuality(Array.from(peerQualityLevelRef.current.values()));
  }, []);

  const syncAggregateQualityLevel = useCallback(() => {
    const next = getAggregateQualityLevel();
    setQualityLevel(next);
    qualityLevelRef.current = next;
  }, [getAggregateQualityLevel]);

  const sendQualityToViewer = useCallback((peerId: string, level: 'high' | 'medium' | 'low') => {
    const conn = activeDataConnectionsRef.current.find((c) => c.peer === peerId && c.open);
    if (!conn) return;
    try {
      conn.send({ type: 'quality', value: level });
    } catch {
      // Ignore transient send failures.
    }
  }, []);

  const notifyQualityChange = useCallback((message: string) => {
    const now = Date.now();
    if (now - qualityNoticeAtRef.current < 10_000) return;
    qualityNoticeAtRef.current = now;
    onNotification(message, 'info');
  }, [onNotification]);

  const setPeerQualityLevel = useCallback((
    peerId: string,
    level: 'high' | 'medium' | 'low',
    options?: { broadcast?: boolean },
  ) => {
    const prev = peerQualityLevelRef.current.get(peerId);
    if (prev === level) return false;
    peerQualityLevelRef.current.set(peerId, level);
    syncAggregateQualityLevel();
    if (options?.broadcast !== false) {
      sendQualityToViewer(peerId, level);
    }
    return true;
  }, [sendQualityToViewer, syncAggregateQualityLevel]);


  const qualityCaptureConstraints = SCREEN_SHARE_CAPTURE_PRESETS;


  const getCaptureTargetResolution = useCallback((level: 'high' | 'medium' | 'low') => {
    const dpr = window.devicePixelRatio || 1;
    const baseWidth = Math.floor(window.screen.width * dpr);
    const baseHeight = Math.floor(window.screen.height * dpr);
    const sourceWidth = Math.min(3840, Math.max(1280, baseWidth || 1920));
    const sourceHeight = Math.min(2160, Math.max(720, baseHeight || 1080));
    const scale = qualityCaptureConstraints[level].scaleResolutionDownBy || 1;
    return {
      width: Math.max(640, Math.floor(sourceWidth / scale)),
      height: Math.max(360, Math.floor(sourceHeight / scale)),
    };
  }, [qualityCaptureConstraints]);

  const buildDisplayMediaConstraints = useCallback((): DisplayMediaStreamOptions => {
    const dpr = window.devicePixelRatio || 1;
    const baseWidth = Math.floor(window.screen.width * dpr);
    const baseHeight = Math.floor(window.screen.height * dpr);
    const idealWidth = Math.min(3840, Math.max(1280, baseWidth || 1920));
    const idealHeight = Math.min(2160, Math.max(720, baseHeight || 1080));

    return {
      video: {
        cursor: 'always',
        displaySurface: 'monitor',
        width: { ideal: idealWidth },
        height: { ideal: idealHeight },
        frameRate: { ideal: 60, max: 60 },
      } as MediaTrackConstraints,
      audio: true,
    };
  }, []);

  const applyLocalTrackConstraints = useCallback(async (
    stream: MediaStream | null,
    level: 'high' | 'medium' | 'low',
  ) => {
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || !videoTrack.applyConstraints) return;
    const preset = qualityCaptureConstraints[level];
    const resolution = getCaptureTargetResolution(level);
    try {
      const constraints: MediaTrackConstraints & { resizeMode?: ConstrainDOMString } = {
        width: { ideal: resolution.width, max: resolution.width },
        height: { ideal: resolution.height, max: resolution.height },
        frameRate: { ideal: preset.maxFrameRate, max: preset.maxFrameRate },
      };
      constraints.resizeMode = 'none';
      await videoTrack.applyConstraints(constraints);
    } catch (err) {
      logDebug('warn', 'Failed to apply local track constraints:', err);
    }
  }, [qualityCaptureConstraints, getCaptureTargetResolution]);

  const preferVideoCodecs = useCallback((peerConnection: RTCPeerConnection) => {
    if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return;
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps?.codecs?.length) return;
    const preferredOrder = getPreferredScreenShareCodecOrder(browserProfile).map((codec) => codec.toLowerCase());

    const rankCodec = (mimeType: string) => {
      const mt = mimeType.toLowerCase();
      const preferredIndex = preferredOrder.indexOf(mt);
      return preferredIndex === -1 ? preferredOrder.length : preferredIndex;
    };

    const sorted = [...caps.codecs].sort((a, b) => rankCodec(a.mimeType) - rankCodec(b.mimeType));
    peerConnection.getTransceivers().forEach((transceiver) => {
      const kind = transceiver.receiver?.track?.kind || transceiver.sender?.track?.kind;
      if (kind !== 'video') return;
      if (typeof transceiver.setCodecPreferences !== 'function') return;
      try {
        transceiver.setCodecPreferences(sorted);
      } catch (err) {
        logDebug('warn', 'setCodecPreferences failed:', err);
      }
    });
  }, [browserProfile]);


  const applyBitrateConstraints = useCallback(async (
    peerConnection: RTCPeerConnection,
    level: 'high' | 'medium' | 'low',
    maxBitrateCap?: number,
  ): Promise<boolean> => {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');
    let applied = true;

    if (videoSender) {

      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      // LAN/P2P 不设人为上限，只有中继按成本封顶；实际速率交给每条连接的 GCC。
      const boundedMaxBitrate = typeof maxBitrateCap === 'number' && maxBitrateCap > 0
        ? Math.floor(maxBitrateCap)
        : resolveBitrateCap(level);
      const baseFramerate = qualityCaptureConstraints[level].maxFrameRate;

      if (params.encodings.length > 1) {
        const profileRatios =
          level === 'high'
            ? [0.58, 0.30, 0.12]
            : level === 'medium'
              ? [0.50, 0.32, 0.18]
              : [0.42, 0.33, 0.25];
        params.encodings.forEach((encoding, idx) => {
          const ratio = profileRatios[Math.min(idx, profileRatios.length - 1)];
          encoding.maxBitrate = Math.max(120000, Math.floor(boundedMaxBitrate * ratio));
          encoding.maxFramerate = Math.max(15, baseFramerate - idx * 15);
          if (typeof encoding.scaleResolutionDownBy !== 'number') {
            encoding.scaleResolutionDownBy = idx === 0 ? 1 : idx === 1 ? 1.5 : 2.5;
          }
          if ('priority' in encoding) {
            (encoding as any).priority = idx === 0 ? 'high' : level === 'low' ? 'low' : 'medium';
          }
        });
      } else {
        params.encodings[0].maxBitrate = boundedMaxBitrate;
        params.encodings[0].maxFramerate = baseFramerate;
        params.encodings[0].scaleResolutionDownBy = qualityCaptureConstraints[level].scaleResolutionDownBy;

        if ('networkPriority' in params.encodings[0]) {
          (params.encodings[0] as any).networkPriority = level === 'high' ? 'high' : level === 'medium' ? 'medium' : 'low';
        }
        if ('priority' in params.encodings[0]) {
          (params.encodings[0] as any).priority = level === 'high' ? 'high' : level === 'medium' ? 'medium' : 'low';
        }
      }

      // 共享场景优先可读性：在带宽波动时尽量保分辨率而不是先降清晰度
      (params as any).degradationPreference = level === 'low' ? 'balanced' : 'maintain-resolution';

      try {
        await videoSender.setParameters(params);
        logDebug('log', `Applied ${level} quality bitrate cap: ${(boundedMaxBitrate / 1000000).toFixed(2)}Mbps`);
      } catch (err) {
        applied = false;
        logDebug('warn', 'Failed to set bitrate parameters:', err);
      }
    }
    return applied;
  }, [qualityCaptureConstraints]);


  useEffect(() => {
    qualityLevelRef.current = qualityLevel;
  }, [qualityLevel]);

  // 屏幕共享可能持续数小时。TURN 短期凭证 1h 过期后，分享端仍会用构造时冻结的
  // iceServers 给新 viewer 建 PC，导致后来者拿不到 relay 候选。这里定期换新配置；
  // 已建立的 relay allocation 不受影响。
  useEffect(() => {
    if (!isSharing) return;
    const timer = window.setInterval(() => {
      void getIceConfig()
        .then((fresh) => {
          // 配置接口失败会返回 STUN-only 回退；写回去会把后续 viewer 的中继能力丢掉。
          if (!fresh.hasTurn) return;
          peerRef.current?.updateIceServers(fresh.iceServers);
        })
        .catch(() => {});
    }, CONNECTION_TIMINGS.SHARE_CODE_RENEWAL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isSharing]);


  // 监听连接状态，一旦结束连接过程（无论是成功还是失败），就清除超时定时器
  useEffect(() => {
    if (!isConnecting && connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }
  }, [isConnecting]);


  const getUniqueViewerCount = useCallback(() => {
    return new Set(activeCallsRef.current.map((c) => c.peer)).size;
  }, []);

  const startBandwidthMonitoring = useCallback((call: MediaConnection) => {
    const pc = call.peerConnection;
    if (!pc) return;
    const existing = bandwidthMonitorsRef.current.get(call.peer);
    if (existing) {
      if (existing.pc === pc) return;
      // 旧连接还没 close 就来了新连接：先停掉旧监控，否则新 PC 永远拿不到监控。
      clearInterval(existing.timer);
      bandwidthMonitorsRef.current.delete(call.peer);
    }

    let lastBytesSent = 0;
    let lastPacketsSent = 0;
    let lastPacketsLost = 0;
    let lastTimestamp = Date.now();
    let consecutiveLowBandwidth = 0;
    let consecutiveHighBandwidth = 0;
    const monitorStartedAt = Date.now();
    const BANDWIDTH_WARMUP_MS = SCREEN_SHARE_BANDWARMUP_MS;

    const applyLevel = async (level: 'high' | 'medium' | 'low') => {
      // 每个观众独立编码：上限 = min(画质/中继上限, 聚合上行预算 / 当前观众数)。
      const cap = resolvePerViewerBitrateCap(
        level,
        peerRelayRef.current.get(call.peer) ?? false,
        getUniqueViewerCount(),
      );
      // 只有 setParameters 真正成功才记录，否则限流失败后会被误判为「已应用」。
      const applied = await applyBitrateConstraints(pc, level, cap);
      if (applied) {
        peerAppliedCapRef.current.set(call.peer, cap);
      }
    };

    const monitor = async () => {
      try {
        const stats = await pc.getStats();
        let currentBytesSent = 0;
        let packetsLost = 0;
        let packetsSent = 0;
        const outboundCandidates: any[] = [];
        const remoteInboundCandidates: any[] = [];

        stats.forEach((report: any) => {
          const mediaKind = report.kind || report.mediaType;
          if (report.type === 'outbound-rtp' && mediaKind === 'video' && !report.isRemote) {
            outboundCandidates.push(report);
          }
          if (report.type === 'remote-inbound-rtp' && mediaKind === 'video') {
            remoteInboundCandidates.push(report);
          }
        });

        let selectedPair: any = null;
        stats.forEach((report: any) => {
          if (selectedPair) return;
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPair = stats.get(report.selectedCandidatePairId) || null;
          }
        });
        if (!selectedPair) {
          stats.forEach((report: any) => {
            if (selectedPair) return;
            if (
              report.type === 'candidate-pair' &&
              (report.selected === true || (report.nominated === true && report.state === 'succeeded'))
            ) {
              selectedPair = report;
            }
          });
        }
        if (selectedPair) {
          const localCandidate = selectedPair.localCandidateId
            ? stats.get(selectedPair.localCandidateId) as any
            : null;
          const remoteCandidate = selectedPair.remoteCandidateId
            ? stats.get(selectedPair.remoteCandidateId) as any
            : null;
          const localType = localCandidate?.candidateType as string | undefined;
          const remoteType = remoteCandidate?.candidateType as string | undefined;
          // 两侧都取不到候选类型时不要猜成 P2P：那会把中继链路的 8M 上限放开到 100M。
          if (localType || remoteType) {
            peerRelayRef.current.set(
              call.peer,
              localType === 'relay' || remoteType === 'relay',
            );
          }
        }

        if (outboundCandidates.length > 0) {
          const selectedOutbound = outboundCandidates.reduce((best, item) => {
            const bestBytes = typeof best?.bytesSent === 'number' ? best.bytesSent : -1;
            const itemBytes = typeof item?.bytesSent === 'number' ? item.bytesSent : -1;
            return itemBytes > bestBytes ? item : best;
          }, outboundCandidates[0] as any);

          currentBytesSent = selectedOutbound?.bytesSent || 0;
          packetsSent = selectedOutbound?.packetsSent || 0;

          const linkedRemoteId = selectedOutbound?.remoteId;
          if (linkedRemoteId && stats.has(linkedRemoteId)) {
            const linkedRemote = stats.get(linkedRemoteId) as any;
            if (linkedRemote && linkedRemote.type === 'remote-inbound-rtp') {
              packetsLost = linkedRemote.packetsLost || 0;
            }
          }
        }

        if (packetsLost === 0 && remoteInboundCandidates.length > 0) {
          packetsLost = remoteInboundCandidates.reduce((maxLost, item) => {
            const lost = typeof item?.packetsLost === 'number' ? item.packetsLost : 0;
            return Math.max(maxLost, lost);
          }, 0);
        }

        const now = Date.now();
        const timeDiff = (now - lastTimestamp) / 1000;
        if (timeDiff <= 0) return;
        const bytesDiff = currentBytesSent - lastBytesSent;
        const currentBitrate = (bytesDiff * 8) / timeDiff;
        const sentDiff = Math.max(0, packetsSent - lastPacketsSent);
        const lostDiff = Math.max(0, packetsLost - lastPacketsLost);
        const packetLossRate = (sentDiff + lostDiff) > 0 ? (lostDiff / (sentDiff + lostDiff)) : 0;

        lastBytesSent = currentBytesSent;
        lastPacketsSent = packetsSent;
        lastPacketsLost = packetsLost;
        lastTimestamp = now;



        const currentQuality = peerQualityLevelRef.current.get(call.peer) || 'high';

        // 路由可能在 ICE 重启后变化：从直连切到中继时补上成本上限，反之放开。
        // 这一步必须在预热返回之前执行——否则中继的前 8 秒会按 P2P 的 100M 上限
        // 发送，恰好是 TURN 流量最贵、也最容易把上行打满的起播阶段。
        const relay = peerRelayRef.current.get(call.peer) ?? false;
        // 观众人数变化后预算份额随之变化，2 秒内通过这里重新下发上限。
        const expectedCap = resolvePerViewerBitrateCap(
          currentQuality,
          relay,
          getUniqueViewerCount(),
        );
        if (peerAppliedCapRef.current.get(call.peer) !== expectedCap) {
          await applyLevel(currentQuality);
        }

        // 连接初期带宽估计和丢包统计波动很大，先预热避免误降档导致“刚连上先糊”
        if (now - monitorStartedAt < BANDWIDTH_WARMUP_MS) {
          return;
        }

        // 清晰优先策略：
        // 默认保持高清/原画，只有在“持续且明显卡顿”时才降档。
        const shouldDowngrade = shouldDowngradeQuality(currentQuality, packetLossRate, currentBitrate);

        if (shouldDowngrade) {
          consecutiveLowBandwidth++;
          consecutiveHighBandwidth = 0;

          // 每 2 秒检测一次：
          // high -> medium 需要连续 12 秒严重卡顿；
          // medium -> low 需要连续 16 秒严重卡顿。
          const lowThreshold = currentQuality === 'high' ? 6 : 8;
          if (consecutiveLowBandwidth >= lowThreshold) {
            if (currentQuality === 'high') {
              setPeerQualityLevel(call.peer, 'medium');
              await applyLevel('medium');
              notifyQualityChange('部分观看者网络波动，已自动降低画质');
            } else if (currentQuality === 'medium') {
              setPeerQualityLevel(call.peer, 'low');
              await applyLevel('low');
              notifyQualityChange('部分观看者网络不稳定，已切换到流畅模式');
            }
            consecutiveLowBandwidth = 0;
          }
        } else if (shouldUpgradeQuality(packetLossRate)) { // 只有丢包率极低时才考虑升级
          consecutiveHighBandwidth++;
          consecutiveLowBandwidth = 0;

          if (consecutiveHighBandwidth >= 5) {
            if (currentQuality === 'low') {
              setPeerQualityLevel(call.peer, 'medium');
              await applyLevel('medium');
              notifyQualityChange('观看网络好转，已自动恢复画质');
            } else if (currentQuality === 'medium') {
              setPeerQualityLevel(call.peer, 'high');
              await applyLevel('high');
              notifyQualityChange('观看网络良好，已切换回原画');
            }
            consecutiveHighBandwidth = 0;
          }
        } else {
          consecutiveLowBandwidth = 0;
          consecutiveHighBandwidth = 0;
        }
      } catch (err) {
      logDebug('warn', 'Bandwidth monitoring error:', err);
      }
    };


    void monitor();
    const timer = setInterval(monitor, SCREEN_SHARE_BANDWIDTH_MONITOR_INTERVAL_MS);
    bandwidthMonitorsRef.current.set(call.peer, { timer, pc });
  }, [applyBitrateConstraints, getUniqueViewerCount, notifyQualityChange, setPeerQualityLevel]);


  const stopBandwidthMonitoring = useCallback((peerId?: string) => {
    if (peerId) {
      const monitor = bandwidthMonitorsRef.current.get(peerId);
      if (monitor) {
        clearInterval(monitor.timer);
        bandwidthMonitorsRef.current.delete(peerId);
      }
      peerRelayRef.current.delete(peerId);
      peerAppliedCapRef.current.delete(peerId);
      return;
    }

    bandwidthMonitorsRef.current.forEach((monitor) => clearInterval(monitor.timer));
    bandwidthMonitorsRef.current.clear();
    peerRelayRef.current.clear();
    peerAppliedCapRef.current.clear();
  }, []);

  const syncViewerCount = useCallback(() => {
    setViewerCount(getUniqueViewerCount());
  }, [getUniqueViewerCount]);

  const addActiveCall = useCallback((call: MediaConnection) => {
    if (activeCallsRef.current.includes(call)) {
      return false;
    }
    const before = getUniqueViewerCount();
    activeCallsRef.current.push(call);
    const after = getUniqueViewerCount();
    setViewerCount(after);
    return after > before;
  }, [getUniqueViewerCount]);

  const removeActiveCall = useCallback((call: MediaConnection) => {
    const beforeLength = activeCallsRef.current.length;
    activeCallsRef.current = activeCallsRef.current.filter(c => c !== call);
    // 同一观众重连时可能同时有旧 call 正在关闭、新 call 已经建立。按 peer 清理的
    // 状态只有在该 peer 没有任何活跃 call 时才能删，否则会把新连接刚算出的
    // 中继判定与已应用码率一起抹掉。
    const hasPeerCall = activeCallsRef.current.some(c => c.peer === call.peer);
    if (!hasPeerCall) {
      peerQualityLevelRef.current.delete(call.peer);
      peerRelayRef.current.delete(call.peer);
      peerAppliedCapRef.current.delete(call.peer);
      stopBandwidthMonitoring(call.peer);
    }
    syncAggregateQualityLevel();

    if (beforeLength !== activeCallsRef.current.length) {
      syncViewerCount();
    }

    if (activeCallsRef.current.length === 0) {
      stopBandwidthMonitoring();
    }
  }, [syncViewerCount, stopBandwidthMonitoring, syncAggregateQualityLevel]);


  const initializePeerUnlocked = useCallback(async () => {
    const sessionToken = peerSessionTokenRef.current;
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    sharerSignalingBrokenRef.current = false;

    const iceConfig = await getIceConfig();
    const { default: PeerRuntime } = await loadPeerRuntime();
    // 用户可能在拉配置期间停止共享；此时再注册会留下一个空信令会话占用每 IP 名额。
    if (peerSessionTokenRef.current !== sessionToken) return;

    // 房号必须先到服务端登记：没有登记就拿不到口令与 secret，信令 WS 会被拒；
    // 观众链接也只在登记后才有意义（TTL 到期/撤销后不可再用）。
    let room = shareRoomRef.current;
    if (!room) {
      const registration = await registerScreenShareRoom({ peerId: createScreenSharePeerId() });
      if (peerSessionTokenRef.current !== sessionToken) {
        if (registration.status === 'ok') void revokeScreenShareRoom(registration.room);
        return;
      }
      if (registration.status !== 'ok') {
        shareRoomFailureRef.current = registration;
        logDebug(
          'warn',
          'Screen share room registration failed:',
          registration.reason,
          registration.retryAfterMs ?? '',
        );
        setIsPeerReady(false);
        // 服务端给了 Retry-After 就必须让用户等过它，否则点重试只是再吃一次 429。
        setShareRoomRetryAt(
          registration.retryAfterMs ? Date.now() + registration.retryAfterMs : null,
        );
        // 限流是服务端明确的拒绝：继续退避重试只会吃更多 429，直接进终态。
        // 其它原因（占用/网络）交给恢复 effect 退避重试，预算耗尽后由它按记录的原因落终态。
        if (isTerminalScreenShareRoomFailure(registration.reason)) {
          failSharerSessionRef.current(registration.message);
          return;
        }
        if (registration.reason === 'timeout') {
          shareRoomTimeoutsRef.current += 1;
          if (shareRoomTimeoutsRef.current >= SHARE_ROOM_REGISTRATION_MAX_TIMEOUTS) {
            failSharerSessionRef.current(registration.message);
            return;
          }
        } else {
          shareRoomTimeoutsRef.current = 0;
        }
        sharerSignalingBrokenRef.current = true;
        setSharerRecoveryTick((tick) => tick + 1);
        return;
      }
      room = registration.room;
      shareRoomTimeoutsRef.current = 0;
      shareRoomFailureRef.current = null;
      shareRoomRef.current = room;
      setShareRoom(room);
    }

    const id = room.peerId;
    const useSecurePeerServer = window.location.protocol === 'https:';
    // 重建是新建 PeerRuntime：proof 存在实例内存里，不主动接回来的话过了静态摘要
    // 宽限期就只能拿到 4010（分享直接终态、已发链接全废）。
    const peer = new PeerRuntime(id, {
      debug: 0,
      secure: useSecurePeerServer,
      pingInterval: 5000, // 缩短心跳间隔以保持 VPN 隧道活跃
      // 服务端首次绑定后只认轮换 proof；还没拿到 proof 时退回首连用的静态摘要。
      ...resolveScreenSharePeerCredentials(room),
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: 'all',
      }
    });

    const handleSignalingReady = (openedId: string) => {
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }
      sharerSignalingBrokenRef.current = false;
      sharerPeerOpenedAtRef.current = Date.now();
      setPeerId(openedId);
      setIsPeerReady(true);
      setHasBeenReady(true);
      // 房号登记与信令握手都完成了才说「已开始」：采集成功那一刻观众还打不开链接。
      const startNotice = shareStartNotice.takeOnReady();
      if (startNotice) onNotification(startNotice, 'success');
      // 只清掉「信令不可达」的提示；其它错误（权限、设备）不该被恢复事件覆盖。
      setError((prev) => (prev === SIGNALING_UNREACHABLE_MESSAGE ? null : prev));
    };

    peer.on('open', (openedId) => {
      logDebug('log', 'Peer ID:', openedId);
      handleSignalingReady(openedId);
      onNotification(`连接 ID: ${openedId}`, 'info');
    });

    // proof 每次注册都会轮换：接住最新值，重建/刷新后才有凭证可用。
    peer.on('session-proof', (proof) => {
      rememberScreenShareSessionProof(room, proof);
    });

    // 'open' 只在首次注册时发一次；自动重连成功后必须重新把 isPeerReady 置回 true，
    // 否则 UI 永远停在「正在连接服务器...」，恢复 effect 也会反复重建 peer。
    peer.on('signaling:restored', (openedId) => {
      logDebug('log', 'Signaling restored:', openedId);
      handleSignalingReady(openedId);
      onNotification('信令连接已恢复', 'success');
    });

    // 监听传入的数据连接（用于发送画质状态给观看者）
    peer.on('connection', (conn) => {
      logDebug('log', 'Data connection received from:', conn.peer);
      activeDataConnectionsRef.current.push(conn);
      // 每个观众只保留一条数据连接：重复接入会让心跳与画质状态互相覆盖。
      // 先入列再关旧连接，旧连接的 close 处理器因此能看到新的替代连接。
      activeDataConnectionsRef.current
        .filter(c => c !== conn && c.peer === conn.peer)
        .forEach(c => { try { c.close(); } catch {} });

      // 初始化该观看者的心跳时间
      viewerHeartbeatsRef.current[conn.peer] = Date.now();

      conn.on('open', () => {
        const level = peerQualityLevelRef.current.get(conn.peer) || 'high';
        peerQualityLevelRef.current.set(conn.peer, level);
        syncAggregateQualityLevel();
        sendQualityToViewer(conn.peer, level);
      });

      conn.on('data', (data: any) => {
        if (data && data.type === 'heartbeat') {
          // 更新心跳时间戳
          viewerHeartbeatsRef.current[conn.peer] = Date.now();
        }
      });

      conn.on('close', () => {
        activeDataConnectionsRef.current = activeDataConnectionsRef.current.filter(c => c !== conn);
        const stillConnected = activeDataConnectionsRef.current.some(c => c.peer === conn.peer);
        if (stillConnected) return;
        // 观众离开后座位不该再等 ICE 的 disconnected 宽限（旧实现会让「重连中的观众」
        // 在宽限窗口里占两个座位）。只回收已经不在 connected 的媒体连接，避免数据
        // 通道的瞬时抖动误杀正在观看的 call。
        activeCallsRef.current
          .filter(c => c.peer === conn.peer)
          .forEach(c => {
            const state = c.peerConnection?.connectionState;
            if (!state || state === 'closed' || state === 'failed' || state === 'disconnected') {
              try { c.close(); } catch {}
            }
          });
        delete viewerHeartbeatsRef.current[conn.peer];
      });

      conn.on('error', (err) => {
        console.error('Data connection error:', err);
        activeDataConnectionsRef.current = activeDataConnectionsRef.current.filter(c => c !== conn);
        delete viewerHeartbeatsRef.current[conn.peer];
      });
    });

    peer.on('call', (call) => {
      const existingViewers = new Set(activeCallsRef.current.map(c => c.peer));
      const pendingViewers = pendingViewerPeersRef.current;
      const trackedPeer = existingViewers.has(call.peer) || pendingViewers.has(call.peer);
      const viewerConn = activeDataConnectionsRef.current.find(c => c.peer === call.peer);
      // 名额判定与「被拒时怎么告知观众」都是纯函数，组件只负责执行（见 viewerAdmission）。
      const plan = planViewerAdmission({
        activeViewers: existingViewers.size,
        pendingViewers: pendingViewers.size,
        maxViewers: SCREEN_SHARE_LIMITS.MAX_VIEWERS,
        tracked: trackedPeer,
        dataChannel: viewerConn ? (viewerConn.open ? 'open' : 'pending') : 'absent',
      });
      if (plan.kind === 'reject-share-full') {
        // P2P mesh 下每多一个 viewer 就多一份上行编码，超过上限后在分享端直接拒绝，
        // 比让信令的每 IP 会话上限在加入中途失败更可解释。
        onNotification(`观看人数已达上限（${SCREEN_SHARE_LIMITS.MAX_VIEWERS} 人）`, 'info');
        // 光关 call 的话观众只能等到 20s 超时并以为是网络/防火墙问题。已登记的连接
        // 直接发；还没登记就反向连一条（观众端会接受入站连接并读 share-full）。
        const delivered = deliverShareFull(plan.delivery, {
          connection: (viewerConn ?? null) as unknown as ShareFullConnection | null,
          connect: (viewerPeerId) => {
            try { return peer.connect(viewerPeerId) as unknown as ShareFullConnection; } catch { return null; }
          },
          peerId: call.peer,
        });
        // 送不出去就没人告诉观众「人满了」，观众只能等到超时；这个静默缺口必须留痕。
        shareFullTelemetry.record(plan.delivery, delivered);
        try { call.close(); } catch {}
        return;
      }

      // 正常重连会换新 peerId（观众侧每次 new PeerRuntime），所以同一个 peerId 再来
      // 一条 call 只可能是客户端故意多开：关掉旧 call，保证每个 peer 最多一条媒体连接，
      // 否则一个「观众」就能让分享端跑 N 条 PeerConnection 并绕过 MAX_VIEWERS。
      if (trackedPeer && !pendingViewers.has(call.peer)) {
        activeCallsRef.current
          .filter((active) => active.peer === call.peer)
          .forEach((active) => { try { active.close(); } catch {} });
      }

      // answer() 要等一次 round-trip：名额必须现在占，不能等 answer 回来才计入。
      const reservedSeat = plan.reserveSeat;
      if (reservedSeat) pendingViewers.add(call.peer);
      const releaseSeat = () => {
        if (reservedSeat) pendingViewers.delete(call.peer);
      };

      // close/error 必须在 answer 之前挂上：viewer 可能在 answer 在途时断开，
      // 而 answer() 对已关闭的 call 会正常 resolve，晚挂的监听永远不会触发。
      // viewerGone 让 answer 的 then 能分辨「观众已经走了」和「还没连上」。
      let viewerGone = false;
      let connectTimer: number | null = null;
      const clearConnectTimer = () => {
        if (connectTimer !== null) {
          window.clearTimeout(connectTimer);
          connectTimer = null;
        }
      };
      call.on('close', () => {
        viewerGone = true;
        clearConnectTimer();
        releaseSeat();
        removeActiveCall(call);
      });

      call.on('error', (err) => {
        console.error('Call error:', err);
        viewerGone = true;
        clearConnectTimer();
        releaseSeat();
        removeActiveCall(call);
      });

      const stream = streamRef.current;
      if (!stream) {
        // 已经停止共享：直接拒绝，别让观看者黑屏等满超时。
        releaseSeat();
        try { call.close(); } catch {}
        return;
      }

      if (call.peerConnection) {
        preferVideoCodecs(call.peerConnection);
      }
      setPeerQualityLevel(call.peer, 'high');

      // answer 可能因为 WS 正在重连而失败。不 await 的话失败是静默的：call 仍然
      // 被计入门槛与带宽监控，观看者却永远收不到流。失败时立即关闭并释放名额。
      void call.answer(stream)
        .then(() => {
          // 不能拿 call.open 当门槛：answer() 在 ICE 连上之前就 resolve，这时 open 还是
          // false，用它过滤会让观看人数、MAX_VIEWERS 与带宽监控永远不生效（E2E 实测
          // 观众已有画面，分享端仍显示 0 人）。观众在 answer 途中离开由 viewerGone 兜住。
          if (viewerGone) {
            releaseSeat();
            peerQualityLevelRef.current.delete(call.peer);
            return;
          }

          const hasNewViewer = addActiveCall(call);
          releaseSeat();
          if (hasNewViewer) {
            onNotification('有观看者加入', 'info');
          }

          if (call.peerConnection) {
            // call.open 只在 PC 进入 connected（或收到 track）后才为真。ICE 一直连不上时
            // 这条 call 会永远占着名额，到期直接回收，观众刷新即可重试。
            connectTimer = window.setTimeout(() => {
              if (viewerGone || call.open || !streamRef.current) return;
              onNotification('观看者连接超时，已释放名额', 'info');
              try { call.close(); } catch {}
              viewerGone = true;
              removeActiveCall(call);
            }, SCREEN_SHARE_VIEWER_CONNECT_TIMEOUT_MS);
            call.peerConnection.addEventListener('connectionstatechange', () => {
              if (call.peerConnection?.connectionState === 'connected') clearConnectTimer();
            });

            const currentQuality = peerQualityLevelRef.current.get(call.peer) || 'high';
            // 首次 stats 之前还不知道是不是中继：先按中继上限起播，最多 2 秒后
            // 监控器会按真实候选类型放开。宁可晚 2 秒提速，也不要起播时把 TURN 打满。
            // 人数取 addActiveCall 之后的计数，新观众加入时预算份额立刻生效。
            const initialCap = resolvePerViewerBitrateCap(
              currentQuality,
              peerRelayRef.current.get(call.peer) ?? true,
              getUniqueViewerCount(),
            );
            applyBitrateConstraints(call.peerConnection, currentQuality, initialCap);
            // 某些浏览器在初始协商后才完全挂载 sender 参数，短延迟重复应用可减少前几秒模糊
            setTimeout(() => {
              if (call.peerConnection && !viewerGone) {
                const quality = peerQualityLevelRef.current.get(call.peer) || 'high';
                applyBitrateConstraints(
                  call.peerConnection,
                  quality,
                  resolvePerViewerBitrateCap(
                    quality,
                    peerRelayRef.current.get(call.peer) ?? true,
                    getUniqueViewerCount(),
                  ),
                );
              }
            }, 1200);
            startBandwidthMonitoring(call);
          }
        })
        .catch((err) => {
          console.error('Failed to answer viewer call:', err);
          releaseSeat();
          try { call.close(); } catch {}
          onNotification('观看者连接建立失败，请刷新后重试', 'error');
        });
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      const errorType = err?.type ?? '';
      logDebug('warn', 'Screen share signaling error:', errorType);
      // 这些类型重连不会好：服务端已经明确拒绝（占用/无效/未授权/限流/超限），
      // 继续把它当成「暂时连不上」只会留下假共享。直接落终态。
      const terminal =
        errorType === 'session-conflict' ||
        errorType === 'unavailable-id' ||
        errorType === 'invalid-id' ||
        errorType === 'unauthorized' ||
        errorType === 'rate-limited' ||
        errorType === 'message-too-large';
      if (terminal) {
        // session-conflict：同一会话不接受这次接管（本浏览器丢了会话凭证，或有人拿链接顶号）。
        // 其它终端类型：房间/凭证已被服务端判死。两者都重开比反复重连更可解释。
        setIsPeerReady(false);
        failSharerSessionRef.current(getSharerPeerRuntimeErrorMessage(errorType));
        return;
      }
      if (errorType === 'disconnected' || errorType === 'network' || errorType === 'socket-error') {
        // 信令重连预算耗尽：peerRuntime 自己不会再发 disconnected 事件，靠 tick 让恢复
        // effect 再跑一次，由它决定重连、重建 peer 还是放弃。
        setError(SIGNALING_UNREACHABLE_MESSAGE);
        setIsPeerReady(false);
        sharerSignalingBrokenRef.current = true;
        setSharerRecoveryTick((tick) => tick + 1);
        return;
      }
      setError(getPeerRuntimeErrorMessage(errorType));
      setIsPeerReady(false);
      sharerSignalingBrokenRef.current = true;
      setSharerRecoveryTick((tick) => tick + 1);
    });

    peer.on('disconnected', () => {
      logDebug('log', 'Peer disconnected');
      // 不在这里直调 peer.reconnect()：那会绕过指数退避，把「握手成功即被关」放大成
      // 每秒一次的重连风暴。退避与重建由下面的 recovery effect 统一负责。
      setIsPeerReady(false);
      sharerSignalingBrokenRef.current = true;
      setSharerRecoveryTick((tick) => tick + 1);
    });

    peerRef.current = peer;
    return peer;
  }, [onNotification, shareStartNotice, applyBitrateConstraints, startBandwidthMonitoring, getUniqueViewerCount, addActiveCall, removeActiveCall, preferVideoCodecs, sendQualityToViewer, syncAggregateQualityLevel, setPeerQualityLevel]);

  // 单飞包装：已在飞时直接放弃这一次，由在飞的那次结果驱动后续（它的失败会自己 tick 回
  // 恢复流程）。返回 false 表示这一调用没有真正执行初始化，调用方据此不要消耗重试预算。
  const initializePeer = useCallback(async (): Promise<boolean> => {
    const flight = peerInitFlightRef.current.current();
    if (!flight.tryEnter()) return false;
    try {
      await initializePeerUnlocked();
      return true;
    } finally {
      flight.leave();
    }
  }, [initializePeerUnlocked]);


  // 分享者端：定期检查观看者心跳，移除断开的连接。
  // 判定本身在 viewerHeartbeatPolicy：传输健康时无视心跳缺失（后台标签页会把观看端的
  // 3 秒心跳节流到分钟级），只有传输也不健康时才按 30s 软超时 / 5min 硬超时收尾。
  useEffect(() => {
    if (!isSharing) return;

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const deadPeers: string[] = [];

      // 检查所有活跃的数据连接
      activeDataConnectionsRef.current.forEach((conn) => {
        const call = activeCallsRef.current.find((item) => item.peer === conn.peer);
        const verdict = decideViewerHeartbeat({
          lastHeartbeatAt: viewerHeartbeatsRef.current[conn.peer],
          now,
          connectionState: call?.peerConnection?.connectionState,
          dataChannelOpen: conn.open,
          tabHidden: document.hidden,
        });
        if (verdict.action === 'close') {
          logDebug('log', `Viewer ${conn.peer} removed (${verdict.reason})`);
          deadPeers.push(conn.peer);
          try { conn.close(); } catch {}
          return;
        }
        if (verdict.refresh) {
          viewerHeartbeatsRef.current[conn.peer] = now;
        }
      });

      if (deadPeers.length > 0) {
        // 关闭对应的媒体连接
        activeCallsRef.current.forEach((call) => {
          if (deadPeers.includes(call.peer)) {
            removeActiveCall(call);
            try { call.close(); } catch {}
          }
        });

        // 兜底同步，避免极端情况下 close 事件丢失导致观看人数未更新
        syncViewerCount();
      }
    }, CONNECTION_TIMINGS.SCREEN_SHARE_VIEWER_HEARTBEAT_CHECK_INTERVAL_MS);

    return () => clearInterval(checkInterval);
  }, [isSharing, removeActiveCall, syncViewerCount]);

  const broadcastShareEnded = useCallback((reason: 'stopped' | 'window_closed' = 'stopped') => {
    activeDataConnectionsRef.current.forEach((conn) => {
      if (!conn.open) return;
      try {
        conn.send({ type: 'share-ended', reason });
      } catch {
        // Ignore best-effort notify errors.
      }
    });
  }, []);

  // 信令彻底失败：停掉采集与预览、撤销房号、清掉链接，并留下红色终态卡片。
  // 旧实现只弹一条 toast 就 return，而 isSharing 仍为 true、链接仍可复制，
  // 观众打开却是「找不到分享者」——这就是「假共享」。终态必须收干净。
  const failSharerSession = useCallback((message: string) => {
    if (sharerFailureHandledRef.current) return;
    sharerFailureHandledRef.current = true;
    logDebug('warn', 'Screen share session failed:', message);

    // 让仍在 await 的 initializePeer 作废，别在终态之后又注册一个新会话。
    // 闸门换新对象而不是就地清空：旧调用结束时的 leave() 只碰它自己那一个。
    peerSessionTokenRef.current += 1;
    peerInitFlightRef.current.reset();
    const room = shareRoomRef.current;
    shareRoomRef.current = null;
    setShareRoom(null);
    if (room) {
      void revokeScreenShareRoom(room);
      // 房号已撤销：留着的 proof 只会在下一次共享里被误当成有效凭证。
      forgetScreenShareSessionProof(room);
    }

    broadcastShareEnded('stopped');
    if (sharerReconnectTimerRef.current) {
      clearTimeout(sharerReconnectTimerRef.current);
      sharerReconnectTimerRef.current = null;
    }
    sharerReconnectAttemptsRef.current = 0;
    sharerPeerRebuildsRef.current = 0;
    sharerPeerOpenedAtRef.current = null;
    sharerSignalingBrokenRef.current = false;
    shareRoomFailureRef.current = null;
    shareRoomRenewalFailuresRef.current = 0;
    shareRoomTimeoutsRef.current = 0;
    setShareRoomRenewalWarning(false);
    setShareRoomExpired(false);

    if (streamRef.current) {
      // 统一走 releaseCapturedStream：先摘 onended 再停轨。裸 stop() 现在不触发 ended，
      // 但哪天有人改成「stop + ended」就会打回 stopScreenShare，把终态再跑一遍。
      releaseCapturedStream(streamRef.current);
      streamRef.current = null;
    }

    activeDataConnectionsRef.current.forEach((conn) => { try { conn.close(); } catch {} });
    activeDataConnectionsRef.current = [];
    viewerHeartbeatsRef.current = {};

    activeCallsRef.current.forEach((call) => { try { call.close(); } catch {} });
    activeCallsRef.current = [];
    setViewerCount(0);
    peerQualityLevelRef.current.clear();
    setQualityLevel('high');
    qualityLevelRef.current = 'high';
    stopBandwidthMonitoring();

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsSharing(false);
    setIsPeerReady(false);
    setPeerId(null);
    setCopied(false);
    setError(null);
    setSharerFailure({ reason: 'signaling_failed', message, hadShareLink: room !== null });
    onNotification(message, 'error');
  }, [broadcastShareEnded, onNotification, stopBandwidthMonitoring]);

  // 首连看门狗：登记成功但信令一直没 open 时，不能永远停在「正在连接服务器」。
  // 到点后标记故障并唤醒恢复 effect；重试预算耗尽由它落终态。
  useEffect(() => {
    if (!isSharing || isPeerReady) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      if (sharerFailureHandledRef.current) return;
      // 判定收在纯函数里：已 ready / 已停止分享都不该再判超时。
      const decision = planSharerFirstConnectWatchdog({
        isSharing,
        isPeerReady,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: SCREEN_SHARE_CONNECT_TIMEOUT_MS,
      });
      if (decision !== 'timeout') return;
      logDebug('warn', 'Screen share signaling not ready after connect timeout');
      setError(SIGNALING_UNREACHABLE_MESSAGE);
      setIsPeerReady(false);
      sharerSignalingBrokenRef.current = true;
      setSharerRecoveryTick((tick) => tick + 1);
    }, SCREEN_SHARE_CONNECT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [isSharing, isPeerReady, sharerRecoveryTick]);

  useEffect(() => {
    if (!isSharing) {
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }
      sharerReconnectAttemptsRef.current = 0;
      sharerPeerOpenedAtRef.current = null;
      sharerPeerRebuildsRef.current = 0;
      sharerSignalingBrokenRef.current = false;
      return;
    }

    if (isPeerReady) {
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }
      // 稳定存活过才算恢复成功；刚 open 就被关的抖动不清零，否则重试计数永远走不到上限。
      const openedAt = sharerPeerOpenedAtRef.current;
      if (
        openedAt !== null &&
        Date.now() - openedAt >= CONNECTION_TIMINGS.SIGNALING_RECONNECT_STABLE_MS
      ) {
        sharerReconnectAttemptsRef.current = 0;
        sharerPeerRebuildsRef.current = 0;
      }
      return;
    }

    // 只有明确判定过故障（握手报错/断开/看门狗超时）才进入恢复流程：刚点「开始共享」
    // 时的正常握手中状态不该被当成故障去重建。
    if (!sharerSignalingBrokenRef.current) return;
    if (sharerReconnectTimerRef.current) return;

    // 上一轮连接活够久再断：视为新故障，重新给一轮重试预算。
    const openedAt = sharerPeerOpenedAtRef.current;
    if (
      openedAt !== null &&
      Date.now() - openedAt >= CONNECTION_TIMINGS.SIGNALING_RECONNECT_STABLE_MS
    ) {
      sharerReconnectAttemptsRef.current = 0;
    }
    sharerPeerOpenedAtRef.current = null;

    const attempt = sharerReconnectAttemptsRef.current + 1;
    sharerReconnectAttemptsRef.current = attempt;

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), SCREEN_SHARE_RECONNECT_MAX_DELAY_MS);
    sharerReconnectTimerRef.current = setTimeout(async () => {
      sharerReconnectTimerRef.current = null;
      if (!isSharing) return;
      // 上一次初始化还没结束（弱网下单次 init 会超过看门狗与退避间隔）：跳过这一次，
      // 不与它并发。在飞那次的失败通路会自己 tick 回来重排，成功则直接进 ready。
      // 但闸门不能无条件信任：登记本身有超时兜底，真被卡住时必须换一个新闸门继续，
      // 否则恢复流程每轮都在这里早退，界面永久停在「正在连接服务器」。
      const initSlot = peerInitFlightRef.current;
      if (initSlot.current().isInFlight()) {
        if (!initSlot.current().isStale(Date.now(), CONNECTION_TIMINGS.SHARE_INIT_MAX_HOLD_MS)) {
          return;
        }
        logDebug('warn', 'Screen share init gate looks stuck; replacing it');
        initSlot.reset();
      }

      const currentPeer = peerRef.current;
      const peerMissing = !currentPeer || currentPeer.destroyed;

      // 信令状态是判定输入：只有明确救不回来的状态才值得销毁 peer（销毁会换掉 peerId
      // 并关掉所有观众的媒体连接，把可自愈的抖动升级成全员断流）。
      const signalingState = peerMissing ? 'destroyed' : currentPeer.signalingRecoveryState();

      // 判定全部收在 planSharerRecovery：终态文案、重试/重建预算、信令状态只有一处决策，
      // 这里只负责执行动作。
      const decide = (state: SharerSignalingState): SharerRecoveryDecision =>
        planSharerRecovery({
          hasShareRoom: shareRoomRef.current !== null,
          attempt,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          peerMissing,
          peerRebuilds: sharerPeerRebuildsRef.current,
          maxPeerRebuilds: SCREEN_SHARE_MAX_PEER_REBUILDS,
          signalingState: state,
          roomFailureMessage: shareRoomFailureRef.current?.message ?? null,
          unreachableMessage: SIGNALING_UNREACHABLE_MESSAGE,
          reconnectExhaustedMessage: SHARER_RECONNECT_EXHAUSTED_MESSAGE,
          sessionRejectedMessage: SIGNALING_SESSION_REJECTED_MESSAGE,
        });
      let decision: SharerRecoveryDecision = decide(signalingState);

      // 终态：停采集、撤房号、给出「重新开始共享」。继续退避只会留下假共享。
      if (decision.kind === 'terminal') {
        failSharerSession(decision.message);
        return;
      }

      // 房号都还没登记成功：没有可复用的会话，重试一次完整初始化（含登记）。
      if (decision.kind === 'initialize-peer') {
        await initializePeer();
        return;
      }

      if (decision.kind === 'rebuild-peer') {
        // peer 对象没了但房号还在：重建后已发出去的链接仍然有效。
        sharerPeerRebuildsRef.current += 1;
        onNotification('信令连接恢复失败，正在重建共享连接...', 'info');
        try {
          if (currentPeer && !currentPeer.destroyed) currentPeer.destroy();
        } catch {
          // Ignore destroy errors.
        }
        await initializePeer();
        sharerReconnectAttemptsRef.current = 0;
        sharerPeerOpenedAtRef.current = null;
        return;
      }

      if (decision.kind === 'retry-signaling') {
        // WS 停在 idle：先试着把信令拉起来。retry 之后状态可能已经变成 exhausted /
        // destroyed（重连立刻失败），这时必须在本轮就重读并重建，而不是等下一次 effect
        // 重排——否则界面会永久停在「正在连接服务器」。
        try {
          currentPeer?.retrySignaling();
        } catch {
          // retry 内部已处理异常，用重读后的状态继续判定。
        }
        const retriedState: SharerSignalingState =
          currentPeer && !currentPeer.destroyed
            ? currentPeer.signalingRecoveryState()
            : 'destroyed';
        if (retriedState === signalingState) return;
        decision = decide(retriedState);
        if (decision.kind === 'terminal') {
          failSharerSession(decision.message);
          return;
        }
        if (decision.kind === 'rebuild-peer') {
          sharerPeerRebuildsRef.current += 1;
          onNotification('信令连接恢复失败，正在重建共享连接...', 'info');
          try {
            if (currentPeer && !currentPeer.destroyed) currentPeer.destroy();
          } catch {
            // Ignore destroy errors.
          }
          await initializePeer();
          sharerReconnectAttemptsRef.current = 0;
          sharerPeerOpenedAtRef.current = null;
        }
      }
    }, delay);
  }, [
    isSharing,
    isPeerReady,
    peerId,
    sharerRecoveryTick,
    onNotification,
    initializePeer,
    failSharerSession,
  ]);

  // 房号续期与过期感知。
  //
  // 续期：长时间分享时用同 peerId + 同 secret 重新登记，只延长 TTL 不换口令，已发出去的
  // 链接因此不会在中途过期。单次失败不影响当前会话（TTL 有 24 小时余量），连续失败到
  // SHARE_ROOM_RENEWAL_MAX_FAILURES 才提示——但仍然不掐直播。
  //
  // 过期：后台标签页里的 setInterval 会被节流到分钟级，房号可能在无人续期时过掉。所以回到
  // 前台/网络恢复时立刻续一次，并且把「链接已失效」显式画出来——给一个已经作废的链接配
  // 绿色「正在共享」，就是把观众骗进来再看「找不到分享者」。
  const renewShareRoomNow = useCallback(async () => {
    const currentRoom = shareRoomRef.current;
    if (!currentRoom) return;
    const renewal = await renewScreenShareRoom(currentRoom);
    logDebug(
      renewal.ok ? 'log' : 'warn',
      'Screen share room renewal:',
      renewal.ok,
      renewal.expiresAt ?? '',
    );
    if (renewal.ok) {
      shareRoomRenewalFailuresRef.current = 0;
      setShareRoomRenewalWarning(false);
      setShareRoomExpired(false);
      if (renewal.expiresAt !== null) {
        const renewedRoom = { ...currentRoom, expiresAt: renewal.expiresAt };
        shareRoomRef.current = renewedRoom;
        setShareRoom(renewedRoom);
      }
      return;
    }
    shareRoomRenewalFailuresRef.current += 1;
    // 续期失败意味着「链接 TTL 在走向过期」，不是信令故障：只提示，不碰
    // sharerSignalingBrokenRef。否则恢复 effect 会为了一个服务端明确拒绝去重建 peer，
    // 把本可自愈的抖动升级成全员断流；清理时也不可能只撤自己那一次标记。
    if (shareRoomRenewalFailuresRef.current >= CONNECTION_TIMINGS.SHARE_ROOM_RENEWAL_MAX_FAILURES) {
      setShareRoomRenewalWarning(true);
    }
    if (isScreenShareRoomExpired(currentRoom)) setShareRoomExpired(true);
  }, []);

  useEffect(() => {
    if (!isSharing || !shareRoom) return;
    const timer = window.setInterval(
      () => void renewShareRoomNow(),
      CONNECTION_TIMINGS.SHARE_CODE_RENEWAL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [isSharing, shareRoom, renewShareRoomNow]);

  // 回到前台/网络恢复立刻续期：切后台期间定时器被节流，不能等下一个 30 分钟窗口。
  useEffect(() => {
    if (!isSharing) return;
    const handleWake = () => {
      if (document.visibilityState === 'hidden') return;
      void renewShareRoomNow();
    };
    document.addEventListener('visibilitychange', handleWake);
    window.addEventListener('online', handleWake);
    return () => {
      document.removeEventListener('visibilitychange', handleWake);
      window.removeEventListener('online', handleWake);
    };
  }, [isSharing, renewShareRoomNow]);

  // 过期看门狗：续期一直失败时，界面也必须承认链接已经作废。
  // 一次性定时器直接对齐 expiresAt；续期成功会让 expiresAt 变远，effect 重排。
  useEffect(() => {
    if (!isSharing || !shareRoom) return;
    const schedule = planShareRoomExpiryCheck({ expiresAt: shareRoom.expiresAt }, Date.now());
    if (!schedule) return;
    if (schedule.delayMs === 0) {
      setShareRoomExpired(true);
      return;
    }
    const timer = window.setTimeout(() => {
      const currentRoom = shareRoomRef.current;
      setShareRoomExpired(currentRoom ? isScreenShareRoomExpired(currentRoom) : false);
    }, schedule.delayMs);
    return () => window.clearTimeout(timer);
  }, [isSharing, shareRoom]);



  const stopViewing = useCallback((isManual = true) => {
    // 让所有在途的 connectToSharer 在下一个 await 之后失效，避免取消后还建出幽灵会话。
    viewerConnectAttemptRef.current += 1;
    // 标记是否为手动停止
    isManualStopRef.current = isManual;

    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (viewerStatsTimerRef.current) {
      clearInterval(viewerStatsTimerRef.current);
      viewerStatsTimerRef.current = null;
    }

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (mediaConnectionRef.current) {
      mediaConnectionRef.current.close();
      mediaConnectionRef.current = null;
    }

    if (dataConnectionRef.current) {
      dataConnectionRef.current.close();
      dataConnectionRef.current = null;
    }

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    streamRef.current = null;
    setIsViewing(false);
    setIsConnecting(false);
    setViewerConnectingStage('');

    // 只有手动停止时才清除目标ID，方便重连
    if (isManual) {
      clearPersistedViewerSession();
      setTargetSharerId(null);
      setError(null);
      reconnectAttemptsRef.current = 0;
      remoteShareEndedRef.current = false;
      remoteShareEndHandledRef.current = false;
      remoteShareFullRef.current = false;
    }
  }, [clearPersistedViewerSession]);

  const handleRemoteShareEnded = useCallback((reason = '共享已结束') => {
    if (remoteShareEndHandledRef.current) return;
    remoteShareEndHandledRef.current = true;
    remoteShareEndedRef.current = true;
    clearPersistedViewerSession();
    stopViewing(false);
    setError(reason);
    onNotification(reason, 'info');
  }, [clearPersistedViewerSession, onNotification, stopViewing]);


  const connectToSharer = useCallback(async (sharerId: string, isRetry = false) => {
    // attempt token：取消/新连接会让旧的 await 链作废。
    const attemptId = viewerConnectAttemptRef.current + 1;
    viewerConnectAttemptRef.current = attemptId;

    // 任何一次新建连都必须先撤销排队中的自动重连，否则旧定时器会把新连接拆掉。
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // 如果是新的连接请求（非重连），重置重连计数
    if (!isRetry) {
      reconnectAttemptsRef.current = 0;
      isManualStopRef.current = false;
      remoteShareEndedRef.current = false;
      remoteShareEndHandledRef.current = false;
      remoteShareFullRef.current = false;
      // 有限重试的预算只在「用户自己发起新连接」时重置：放在 isRetry 之外会让 3 秒
      // 自动重试每次清零计数，peer-unavailable 永远停在重试态，永不进终态。
      shareUnavailableAttemptsRef.current = 0;
    }
    // 新的一次建连：上一次的限流/不在线结论不再适用（冷却结束后才允许点重试）。
    viewerRateLimitedRef.current = false;
    viewerSharerUnavailableRef.current = false;
    setViewerRetryAt(null);

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    if (mediaConnectionRef.current) {
      mediaConnectionRef.current.close();
      mediaConnectionRef.current = null;
    }

    setError(null);
    setIsConnecting(true);
    setViewerConnectingStage('fetching_ice');
    setTargetSharerId(sharerId);
    persistViewerSession(sharerId);

    // 设置全局连接超时（弱网场景下放宽）
    // 如果超时内没有建立连接（没有进入 isViewing 状态），则判定失败
    if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
    connectingTimeoutRef.current = setTimeout(() => {
      // 检查是否还在连接中（如果没有成功进入 viewing，且没有被手动取消）
      // 注意：这里无法直接访问最新的 state，但可以通过清理函数触发
        logDebug('log', 'Global connection timed out');
      setError('连接超时，无法建立 P2P 通道，请检查网络或防火墙');
      setIsConnecting(false);
      // 触发一次清理，但不标记为手动停止，以便允许用户重试
      stopViewing(false);
    }, SCREEN_SHARE_CONNECT_TIMEOUT_MS);

    // 如果是重连尝试，显示正在重连的状态
    if (isRetry) {
      onNotification(`正在尝试重连 (${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})...`, 'info');
    }

    const iceConfig = await getIceConfig();
    if (viewerConnectAttemptRef.current !== attemptId || isManualStopRef.current) return;
    setViewerConnectingStage('connecting_signaling');
    const useSecurePeerServer = window.location.protocol === 'https:';
    const { default: PeerRuntime } = await loadPeerRuntime();
    if (viewerConnectAttemptRef.current !== attemptId || isManualStopRef.current) return;
    const peer = new PeerRuntime({
      debug: 0,
      secure: useSecurePeerServer,
      pingInterval: 5000,
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: 'all',
      }
    });

    peerRef.current = peer;

    // 会话消息可能来自我们自己发起的数据连接，也可能来自分享端满员时反向连的那一条
    // （此时我们这条还没登记到分享端）。两条都走同一段处理，否则「人数已满」会被静默丢掉。
    const handleViewerSessionData = (data: any) => {
      logDebug('log', 'Received data:', data);
      if (data && data.type === 'quality' && data.value) {
        setRemoteQuality(data.value as 'high' | 'medium' | 'low');
        return;
      }
      if (data && data.type === 'share-ended') {
        const reasonLabel = data.reason === 'window_closed' ? '共享方已离开页面，屏幕共享已结束' : '共享方已停止共享';
        handleRemoteShareEnded(reasonLabel);
        return;
      }
      if (data && data.type === 'share-full') {
        // 达到观看人数上限：明确告知并停止自动重连，避免把「人数满」误判成网络问题。
        remoteShareFullRef.current = true;
        setError(getShareFullMessage(SCREEN_SHARE_LIMITS.MAX_VIEWERS));
        setIsConnecting(false);
        onNotification('分享人数已满，请稍后再试', 'info');
        stopViewing(false);
      }
    };

    peer.on('connection', (conn) => {
      conn.on('data', handleViewerSessionData);
    });

    // 'open' 只在首次注册时发一次；信令自动重连成功后走 'signaling:restored'。
    // 两处都进入同一条建会话路径，否则观看端在连接过程中遇到 WS 抖动会永远停在错误页。
    const stopFreezeWatch = () => {
      if (viewerStatsTimerRef.current) {
        clearInterval(viewerStatsTimerRef.current);
        viewerStatsTimerRef.current = null;
      }
    };

    const reportSuspectedShareFull = () => {
      stopFreezeWatch();
      stopViewing(false);
      setIsViewing(false);
      setIsConnecting(false);
      setError(getSuspectedShareFullMessage(SCREEN_SHARE_LIMITS.MAX_VIEWERS));
      // 这条是推断出来的（告知丢包），不能像确定拒绝那样用肯定语气。
      onNotification('可能人数已满，请稍后再试', 'info');
    };

    const reportViewerRateLimited = (retryAfterMs: number) => {
      viewerRateLimitedRef.current = true;
      setViewerRetryAt(Date.now() + retryAfterMs);
      stopFreezeWatch();
      stopViewing(false);
      setIsConnecting(false);
      setError(RATE_LIMITED_CONNECTION_MESSAGE);
    };

    const handleViewerSignalingReady = () => {
      if (viewerConnectAttemptRef.current !== attemptId || isManualStopRef.current) {
        peer.destroy();
        return;
      }
      // 信令又通了说明服务器可达：之前那条「信令不可达」类的红条已经过期。
      // 限流文案例外——它带着冷却倒计时，清掉就等于放用户立刻重试。
      setError((prev) => (prev === RATE_LIMITED_CONNECTION_MESSAGE ? prev : null));
      if (dataConnectionRef.current) return; // 已经建过会话，恢复事件只代表信令可用
      logDebug('log', 'Viewer peer opened, calling:', sharerId);
      // 信令 open 不代表媒体连通：这里不重置重连预算，否则 ICE 反复失败时会永远重连。
      // 预算只在 connectionState === 'connected' 时清零（见 handleViewerConnectionState）。
      setViewerConnectingStage('connecting_media');

      // 1. 建立数据连接（用于接收画质信息 和 发送心跳）
      const dataConn = peer.connect(sharerId);
      // 数据通道开过就说明分享端已经接手这次会话：满员拒绝发生在通道建立之前，
      // 「从未 open」因此是判疑似满员的必要条件（见 viewerShareFullFallback）。
      let dataChannelOpened = false;

      dataConn.on('open', () => {
          dataChannelOpened = true;
          logDebug('log', 'Data connection opened');

        // 启动心跳发送（每3秒一次）
        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = setInterval(() => {
          if (dataConn.open) {
            dataConn.send({ type: 'heartbeat' });
          }
        }, SCREEN_SHARE_HEARTBEAT_INTERVAL_MS);
      });

      dataConn.on('data', handleViewerSessionData);

      dataConn.on('error', (err) => {
        console.error('Data connection error:', err);
      });

      dataConnectionRef.current = dataConn;


      // 2. 建立媒体连接
      const call = peer.call(sharerId);

      if (!call) {
        setError('无法发起连接，请检查连接 ID');
        setIsConnecting(false);
        return;
      }

      setViewerConnectingStage('waiting_stream');
      let hasReceivedStream = false;

      const reconnectViewerAfterLoss = () => {
        if (isManualStopRef.current || remoteShareEndedRef.current || remoteShareFullRef.current) return;
        if (viewerConnectAttemptRef.current !== attemptId) return;
        stopFreezeWatch();
        logDebug('warn', 'Unexpected disconnection, attempting reconnect...');
        stopViewing(false); // 不清除 targetId

        const plan = planViewerReconnect({
          attempts: reconnectAttemptsRef.current,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          baseDelayMs: SCREEN_SHARE_RECONNECT_BASE_DELAY_MS,
          maxDelayMs: SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
        });
        if (plan.kind === 'exhausted') {
          // 预算用尽：必须给出终态和手动重试入口，不能永远停在「正在重试」。
          setError(VIEWER_RECONNECT_EXHAUSTED_MESSAGE);
          onNotification('屏幕共享连接断开', 'error');
          return;
        }

        reconnectAttemptsRef.current = plan.attempt;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          connectToSharer(sharerId, true);
        }, plan.delayMs);
        setError(describeViewerReconnectWait(plan.delayMs));
      };

      // share-full 的告知是 best-effort：没送到时观众只看到 call 被关。旧实现把它当断链
      // 自动重连，最后报「连接超时/检查防火墙」，把人数问题说成了网络问题。

      // 被信令层限流：连接压根没建起来，重试要等窗口过去。必须记下这次结论，
      // 否则随后到达的 call-close 会把状态覆盖成「可能人数已满」，把人引到错的行动上。

      // 冻帧比“没有新帧”更可靠：低码率下的静态画面本来就可能长时间无帧，而 freezeCount
      // 只在解码器收到新帧却无法推进画面时增长。
      const startFreezeWatch = (pc: RTCPeerConnection) => {
        stopFreezeWatch();
        let lastFreezeCount = 0;
        let hasBaseline = false;
        let stalledWindows = 0;
        viewerStatsTimerRef.current = setInterval(() => {
          if (document.hidden || isManualStopRef.current) {
            // 后台期间解码会暂停，回到前台时 freezeCount 可能一次性跳变；丢弃基线避免误判。
            hasBaseline = false;
            return;
          }
          if (viewerConnectAttemptRef.current !== attemptId) {
            stopFreezeWatch();
            return;
          }
          void pc
            .getStats()
            .then((stats) => {
              let freezeCount = 0;
              stats.forEach((report) => {
                if (
                  report.type === 'inbound-rtp' &&
                  report.kind === 'video' &&
                  typeof report.freezeCount === 'number'
                ) {
                  freezeCount += report.freezeCount;
                }
              });
              if (!hasBaseline) {
                hasBaseline = true;
                lastFreezeCount = freezeCount;
                return;
              }
              const delta = freezeCount - lastFreezeCount;
              lastFreezeCount = freezeCount;
              if (delta < 2) {
                stalledWindows = 0;
                return;
              }
              // 单次窗口翻倍也可能来自切源/降档，连续两个窗口都冻结才重连，
              // 避免 5 秒抖动就烧掉一次重连预算。
              stalledWindows += 1;
              if (stalledWindows < 2) return;
              stopFreezeWatch();
              logDebug('warn', 'Viewer video stalled, reconnecting', { freezeCountDelta: delta });
              onNotification('检测到画面卡死，正在重新连接...', 'info');
              reconnectViewerAfterLoss();
            })
            .catch(() => {
              // getStats 失败不升级为断链，下一轮再试。
            });
        }, SCREEN_SHARE_VIEWER_STATS_INTERVAL_MS);
      };

      // 观众侧连接看护：`stream` 事件在 ICE 连通之前就会到，光靠冻帧看护发现不了
      // 「一直黑屏」。failed 立即重连，disconnected 给一段宽限再重连，connected 清零。
      const viewerPc = call.peerConnection;
      let viewerDisconnectedSince = 0;
      const clearViewerWatch = () => {
        if (viewerGraceTimer) {
          clearTimeout(viewerGraceTimer);
          viewerGraceTimer = null;
        }
        viewerPc?.removeEventListener('connectionstatechange', handleViewerConnectionState);
      };
      let viewerGraceTimer: NodeJS.Timeout | null = null;
      const retryViewerConnection = (message: string) => {
        clearViewerWatch();
        onNotification(message, 'info');
        reconnectViewerAfterLoss();
      };
      const handleViewerConnectionState = () => {
        if (viewerConnectAttemptRef.current !== attemptId) {
          clearViewerWatch();
          return;
        }
        const state = viewerPc?.connectionState ?? 'unknown';
        if (state === 'disconnected' && viewerDisconnectedSince === 0) {
          viewerDisconnectedSince = Date.now();
        }
        const decision = decideViewerConnection({
          state,
          disconnectedForMs: Date.now() - viewerDisconnectedSince,
          graceMs: VIEWER_DISCONNECT_GRACE_MS,
        });
        if (decision === 'ok') {
          // 媒体通道真的连上了，这一轮断链预算才算白攒。
          if (state === 'connected') reconnectAttemptsRef.current = 0;
          viewerDisconnectedSince = 0;
          if (viewerGraceTimer) {
            clearTimeout(viewerGraceTimer);
            viewerGraceTimer = null;
          }
          return;
        }
        if (decision === 'wait' && state === 'disconnected' && !viewerGraceTimer) {
          viewerGraceTimer = setTimeout(() => {
            viewerGraceTimer = null;
            const lateState = viewerPc?.connectionState ?? 'unknown';
            if (lateState === 'connected' || viewerConnectAttemptRef.current !== attemptId) return;
            if (decideViewerConnection({ state: lateState, disconnectedForMs: Date.now() - viewerDisconnectedSince, graceMs: VIEWER_DISCONNECT_GRACE_MS }) !== 'retry') return;
            retryViewerConnection('视频连接中断，正在重新连接...');
          }, VIEWER_DISCONNECT_GRACE_MS);
          return;
        }
        if (decision === 'retry') {
          retryViewerConnection(state === 'failed' ? '视频连接建立失败，正在重试...' : '视频连接已断开，正在重新连接...');
        }
      };
      if (viewerPc) {
        viewerPc.addEventListener('connectionstatechange', handleViewerConnectionState);
        handleViewerConnectionState();
      }

      call.on('stream', (remoteStream) => {
        if (viewerConnectAttemptRef.current !== attemptId) return;
        if (hasReceivedStream) {
              logDebug('log', 'Stream event fired again, skipping duplicate handling');
          return;
        }
        hasReceivedStream = true;
        // 画面到了说明分享端就在：清掉重试预算，以及之前信令抖动留下的红条。
        shareUnavailableAttemptsRef.current = 0;
        setError(null);


        const audioTracks = remoteStream.getAudioTracks();
        const videoTracks = remoteStream.getVideoTracks();

        // Keep receiver playout delay near real-time when the browser exposes
        // RTCRtpReceiver.playoutDelayHint on the active peer connections.
        if (
          typeof (window as any).RTCRtpReceiver !== 'undefined' &&
          'playoutDelayHint' in (window as any).RTCRtpReceiver.prototype &&
          peerRef.current
        ) {
          Object.values(peerRef.current.connections).forEach((conns: any) => {
            conns.forEach((conn: any) => {
              if (conn.peerConnection) {
                const receivers = conn.peerConnection.getReceivers();
                receivers.forEach((receiver: any) => {
                  if (receiver.track?.kind === 'video' && 'playoutDelayHint' in receiver) {
                    receiver.playoutDelayHint = 0;
                    logDebug('log', 'Set playoutDelayHint to 0 for real-time latency');
                  }
                });
              }
            });
          });
        }

                logDebug('log', 'Received remote stream:', {
          audioTracks: audioTracks.length,
          videoTracks: videoTracks.length,
          audioDetails: audioTracks.map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted })),
          videoDetails: videoTracks.map(t => ({ label: t.label, enabled: t.enabled }))
        });


        streamRef.current = remoteStream;

        setIsViewing(true);
        setIsConnecting(false);
        setNeedsPlayClick(false);
        if (call.peerConnection) startFreezeWatch(call.peerConnection);
        onNotification('已连接到屏幕共享', 'success');
      });

      call.on('close', () => {
        if (viewerConnectAttemptRef.current !== attemptId) return;
        logDebug('log', 'Call closed');

        // 同样是「call 结束」，含义可能完全不同：共享方结束、自己取消、满员被拒、
        // 或者真的断链。判定收在纯函数里，测试能证明满员不会被误报成网络故障。
        // 分享者不在线（peer-unavailable/invalid-id/unauthorized）由 peer 级错误分类，
        // 这里不重复判断：那条路径会给出有限重试或「分享暂时不可用」终态。
        const outcome = planViewerCallEndOutcome({
          manualStop: isManualStopRef.current,
          shareEnded: remoteShareEndedRef.current,
          shareFull: remoteShareFullRef.current,
          receivedStream: hasReceivedStream,
          dataChannelOpened,
          rateLimited: viewerRateLimitedRef.current,
          sharerUnavailable: viewerSharerUnavailableRef.current,
        });

        if (outcome === 'share-ended') {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        if (outcome === 'share-full') {
          // share-full 已由数据通道处理过（remoteShareFullRef 已置位），这里只收尾。
          stopViewing(false);
          return;
        }

        if (outcome === 'manual-stop') {
          stopViewing(true);
          onNotification('屏幕共享已结束', 'info');
          return;
        }

        if (outcome === 'rate-limited') {
          // peer 层已经落过限流状态（倒计时+文案）；这里只保证不被满员文案覆盖。
          return;
        }

        if (outcome === 'suspected-share-full') {
          reportSuspectedShareFull();
          return;
        }

        reconnectViewerAfterLoss();
      });

      call.on('error', (err) => {
        if (viewerConnectAttemptRef.current !== attemptId) return;
        console.error('Call error:', err);

        // 限流必须先判：信令层的拒绝会同时触发 call 关闭，而 call 关闭的默认推断是
        // 「没画面 → 可能人数已满」。先走满员推断的话，用户会先看到「分享人数已满」，
        // 再被限流文案覆盖（媒体 offer 被拒时约一半概率命中），或者干脆停在满员终态。
        if ((err as { type?: string } | null)?.type === 'rate-limited') {
          if (readRateLimitLayer(err) === 'session') {
            stopViewing(false);
            setIsConnecting(false);
            setError(VIEWER_SESSION_LIMIT_MESSAGE);
            return;
          }
          if (!viewerRateLimitedRef.current) {
            reportViewerRateLimited(readRetryAfterMs(err) ?? SIGNALING_OFFER_RATE_LIMIT.blockMs);
          }
          return;
        }

        // 分享者不在线类错误（死链、重建窗口、首帧前 ICE 失败）不能走「疑似满员」：
        // 名额满不满此时无从判断，先弹满员通知会把用户引到「等别人退出」这个错误行动上。
        // 交给 peer 级错误分类（有限重试 → 「分享暂时不可用」终态）。
        const errorType = (err as { type?: string } | null)?.type;
        const sharerUnavailable =
          errorType === 'peer-unavailable' ||
          errorType === 'invalid-id' ||
          errorType === 'unauthorized';
        // call 的 close 紧随 error 而来（peerRuntime 同步 emitClose），把结论记下来，
        // 否则 close 分支只看到「没画面、没数据通道」就落进「疑似满员」。
        if (sharerUnavailable) {
          viewerSharerUnavailableRef.current = true;
        }

        const outcome = planViewerCallEndOutcome({
          manualStop: isManualStopRef.current,
          shareEnded: remoteShareEndedRef.current,
          shareFull: remoteShareFullRef.current,
          receivedStream: hasReceivedStream,
          dataChannelOpened,
          rateLimited: viewerRateLimitedRef.current,
          sharerUnavailable,
        });

        if (outcome === 'sharer-unavailable') {
          // peer.on('error') 已经在同一次信令错误上跑过分类：这里只保证不落满员文案。
          return;
        }

        if (outcome === 'share-ended') {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        if (outcome === 'share-full') {
          stopViewing(false);
          return;
        }

        if (outcome === 'manual-stop') {
          stopFreezeWatch();
          setError(getMediaConnectionErrorMessage(err));
          setIsConnecting(false);
          return;
        }

        if (outcome === 'rate-limited') {
          // peer 层已经落过限流状态（倒计时+文案）；这里只保证不被满员文案覆盖。
          return;
        }

        if (outcome === 'suspected-share-full') {
          reportSuspectedShareFull();
          return;
        }

        // 媒体通道报错同样消耗重连预算：预算内继续重试，用尽了才落终态。
        // 以前这里只写一条通用媒体错误就收工，重试链断在半路，用户既没有终态也看不到原因。
        reconnectViewerAfterLoss();
      });

      mediaConnectionRef.current = call;
    };

    peer.on('open', handleViewerSignalingReady);
    peer.on('signaling:restored', handleViewerSignalingReady);

    peer.on('error', (err) => {
      console.error('Peer error:', err);

      if (remoteShareEndedRef.current) {
        handleRemoteShareEnded('共享方已结束共享');
        return;
      }

      // 信令层错误的分类只在这里判：链接已死、被限流、其它。
      const peerErrorPlan = planViewerPeerError({
        type: err.type ?? '',
        manualStop: isManualStopRef.current,
        shareEnded: remoteShareEndedRef.current,
        retryAfterMs: readRetryAfterMs(err),
        fallbackRetryAfterMs: SIGNALING_OFFER_RATE_LIMIT.blockMs,
        limit: readRateLimitLayer(err),
        shareUnavailableAttempts: shareUnavailableAttemptsRef.current,
        maxShareUnavailableRetries: SCREEN_SHARE_SHARE_UNAVAILABLE_MAX_RETRIES,
      });

      if (peerErrorPlan.kind === 'ignore') return;

      if (peerErrorPlan.kind === 'share-unavailable-retry') {
        // 分享端重建 Peer 时会复用同一个房号：这几秒里房号查不到，但恢复后旧链接仍然有效。
        // 所以先等一个窗口再连一次，不判死、也不清持久化会话（否则用户要重新打开链接）。
        shareUnavailableAttemptsRef.current += 1;
        stopViewing(false);
        setIsConnecting(true);
        onNotification(VIEWER_SHARE_UNAVAILABLE_RETRY_MESSAGE, 'info');
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          connectToSharer(sharerId, true);
        }, SCREEN_SHARE_SHARE_UNAVAILABLE_RETRY_MS);
        return;
      }

      if (peerErrorPlan.kind === 'share-unavailable') {
        // 重试用完仍然查不到：进终态，但只描述「暂时不可用」——分享端可能正在重连，
        // 旧链接恢复后还能用，所以不让用户去索取新链接。
        stopViewing(true);
        setError(VIEWER_SHARE_UNAVAILABLE_MESSAGE);
        onNotification(VIEWER_SHARE_UNAVAILABLE_MESSAGE, 'info');
        return;
      }

      if (peerErrorPlan.kind === 'session-limit') {
        // 会话名额（12 个/IP）被同出口的其它设备占着：给倒计时等于骗用户干等。
        stopViewing(false);
        setIsConnecting(false);
        setError(VIEWER_SESSION_LIMIT_MESSAGE);
        return;
      }

      if (peerErrorPlan.kind === 'rate-limited') {
        reportViewerRateLimited(peerErrorPlan.retryAfterMs);
        return;
      }

      // 画面还在放的时候，信令层的一条错误不该把 UI 打成红色终态：用户看得见画面，
      // 红条只会自相矛盾，而且信令恢复后没有任何代码会去清它。
      if (
        planViewerErrorSurface({
          hasMediaConnection: Boolean(mediaConnectionRef.current),
          mediaHealthy: viewerMediaIsHealthy(mediaConnectionRef.current),
        }) === 'suppress'
      ) {
        logDebug('warn', 'Viewer signaling error while media still healthy, suppressed');
        return;
      }

      // 重连预算已经用尽时，迟到的一条 peer 错误不能把终态文案盖回「请重试」：
      // 那会让人以为还有自动重试在跑，实际已经不会再试了。
      const exhausted =
        planViewerReconnect({
          attempts: reconnectAttemptsRef.current,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          baseDelayMs: SCREEN_SHARE_RECONNECT_BASE_DELAY_MS,
          maxDelayMs: SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
        }).kind === 'exhausted';
      if (exhausted) {
        setError(VIEWER_RECONNECT_EXHAUSTED_MESSAGE);
      } else {
        setError(getMediaConnectionErrorMessage(err));
      }
      setIsConnecting(false);
    });
  }, [onNotification, stopViewing, handleRemoteShareEnded, persistViewerSession]);


  const cancelConnecting = useCallback(() => {
    stopViewing();
    onNotification('已取消连接', 'info');
  }, [stopViewing, onNotification]);


  const dismissViewerError = useCallback(() => {
    setError(null);
  }, []);

  const retryConnection = useCallback(() => {
    // 冷却期内点重试只会再吃一次限流：按钮在 UI 上已禁用，这里再兜一层。
    if (viewerRetryCooldown.secondsLeft !== null) return;
    if (targetSharerId) {
      connectToSharer(targetSharerId);
    }
  }, [targetSharerId, connectToSharer, viewerRetryCooldown.secondsLeft]);


  useEffect(() => {
    if (initialViewId && !hasInitialConnectedRef.current) {
      hasInitialConnectedRef.current = true;
      connectToSharer(initialViewId);
    }
  }, [initialViewId, connectToSharer]);


  const shareLink = useMemo(() => {
    if (!peerId) return null;
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return `${baseUrl}?view=${peerId}`;
  }, [peerId]);


  const copyShareLink = useCallback(async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      onNotification('分享链接已复制', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onNotification('复制失败', 'error');
    }
  }, [shareLink, onNotification]);


  useEffect(() => {
    if ((isSharing || isViewing) && streamRef.current && videoRef.current) {
      const video = videoRef.current;
      const stream = streamRef.current;


      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }


      if (isSharing && !isViewing) {
        video.muted = true;
        video.play().catch((error) => {
          logDebug('warn', 'Muted video autoplay failed', error);
        });
      }
    }
  }, [isSharing, isViewing]);


  const viewerVideoRef = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;


    videoRef.current = video;
    video.setAttribute('webkit-playsinline', 'true');
    video.playsInline = true;

    const stream = streamRef.current;
    if (!stream) {
      logDebug('log', 'No stream available yet');
      return;
    }


    if (video.srcObject === stream) return;

    logDebug('log', 'Callback ref: Attaching stream to video element...');
    video.srcObject = stream;
    video.defaultMuted = true;
    video.muted = true;

    video.play()
      .then(() => {
          logDebug('log', 'Video playback started (muted)');
        setNeedsPlayClick(false);
      })
      .catch(error => {
        if (error.name === 'AbortError') {
            logDebug('log', 'Play request was interrupted');
        } else {
          logDebug('warn', 'Autoplay failed:', error);
          setNeedsPlayClick(true);
        }
      });
  }, [isViewing]);


  useEffect(() => {
    return () => {

      // 卸载（切换 tab / 路由）不等于用户点了「停止共享」：先通知观看者，
      // 否则他们只能等重连退避超时才回到可重试态。
      broadcastShareEnded('window_closed');

      bandwidthMonitorsRef.current.forEach((entry) => clearInterval(entry.timer));
      bandwidthMonitorsRef.current.clear();
      if (viewerStatsTimerRef.current) {
        clearInterval(viewerStatsTimerRef.current);
        viewerStatsTimerRef.current = null;
      }

      // 清理数据连接
      if (dataConnectionRef.current) {
        dataConnectionRef.current.close();
      }
      activeDataConnectionsRef.current.forEach(conn => conn.close());
      activeDataConnectionsRef.current = [];
      viewerHeartbeatsRef.current = {};

      if (streamRef.current) {
        releaseCapturedStream(streamRef.current);
      }

      activeCallsRef.current.forEach(call => call.close());
      activeCallsRef.current = [];
      setViewerCount(0);
      peerQualityLevelRef.current.clear();
      setQualityLevel('high');
      qualityLevelRef.current = 'high';

      if (peerRef.current) {
        peerRef.current.destroy();
      }

      if (mediaConnectionRef.current) {
        mediaConnectionRef.current.close();
      }
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }

      // 卸载后必须彻底停掉观看端定时器：否则挂起的重连会在组件已卸载时重新建连，
      // 分享端会看到一个永不消失的观看者并持续推流。
      isManualStopRef.current = true;
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (connectingTimeoutRef.current) {
        clearTimeout(connectingTimeoutRef.current);
        connectingTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // 整页关闭/刷新时清掉观看会话，避免下次打开自动连一个已经结束的分享；
    // bfcache 恢复（persisted）不清，返回页面仍可继续观看。
    const clearViewerSessionOnExit = (event: PageTransitionEvent) => {
      if (!event.persisted) clearPersistedViewerSession();
    };
    window.addEventListener('pagehide', clearViewerSessionOnExit);
    return () => window.removeEventListener('pagehide', clearViewerSessionOnExit);
  }, [clearPersistedViewerSession]);

  useEffect(() => {
    const notifyShareEndOnPageExit = () => {
      if (!isSharing) return;
      broadcastShareEnded('window_closed');
      // 页面卸载后没人等 Promise：立刻撤销房号，否则旧链接能一直活到 TTL（24h）。
      // 正常「停止共享」走 revokeScreenShareRoom，仍然会有返回值与收尾。
      revokeScreenShareRoomBeacon(shareRoomRef.current);
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      // bfcache 恢复（persisted）时页面还会回来继续共享：撤销会把链接误杀。
      if (event.persisted) return;
      notifyShareEndOnPageExit();
    };
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', notifyShareEndOnPageExit);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', notifyShareEndOnPageExit);
    };
  }, [isSharing, broadcastShareEnded]);

  const getScreenShareAudioSuffix = useCallback((stream: MediaStream) => {
    return stream.getAudioTracks().length > 0 ? '（含音频）' : '';
  }, []);

  const prepareCapturedStream = useCallback(async (stream: MediaStream) => {
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      (videoTrack as any).contentHint = 'detail';
    }
    await applyLocalTrackConstraints(stream, qualityLevelRef.current);
    return stream;
  }, [applyLocalTrackConstraints]);

  const attachSharePreviewStream = useCallback((stream: MediaStream, logMessage: string) => {
    streamRef.current = stream;

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch((error) => {
        logDebug('warn', logMessage, error);
      });
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        stopScreenShare();
      };
    }
  }, []);

  /**
   * 丢弃当前预览流：先摘 onended 再停轨道。
   *
   * 只 stop 不摘绑定的旧实现里，旧轨的 onended 仍指向 stopScreenShare：用户关掉原来
   * 那个窗口（或旧源被系统结束）时，会把刚刚重启/切换后的新分享一起停掉。
   */
  const releaseShareStream = useCallback(() => {
    const previous = streamRef.current;
    streamRef.current = null;
    releaseCapturedStream(previous);
  }, []);

  const replaceActiveCallTracks = useCallback((stream: MediaStream) => {
    const nextVideoTrack = stream.getVideoTracks()[0];
    const nextAudioTrack = stream.getAudioTracks()[0];

    activeCallsRef.current.forEach((call) => {
      const senders = call.peerConnection?.getSenders();
      if (!senders) return;

      const videoSender = senders.find((sender) => sender.track?.kind === 'video');
      if (videoSender && nextVideoTrack) {
        videoSender.replaceTrack(nextVideoTrack);
      }

      const audioSender = findLiveAudioSender(call.peerConnection);
      if (audioSender) {
        // 新源可能没有音轨（用户没勾选共享音频）。replaceTrack(null) 会停止发送旧源的声音；
        // 若原来源没有音轨，PeerJS 已完成的协商里没有 audio m-line，加新音轨需要重协商，
        // 这里不静默补轨，交给「重新开始共享」完成。
        void audioSender.replaceTrack(nextAudioTrack ?? null);
      }
    });
  }, []);

  const startScreenShare = async () => {
    // 冷却期内发起登记只会再吃一次 429，还会把静默期往后推：按钮已禁用，这里再兜一层。
    if (shareRoomRetryCooldown.secondsLeft !== null) return;
    setError(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setError('您的浏览器不支持屏幕共享，请使用桌面端浏览器:Chrome、Edge 或 Firefox');
      onNotification('屏幕共享不可用', 'error');
      return;
    }

    try {
      const stream = await prepareCapturedStream(
        await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaConstraints())
      );

      // 重启前先彻底丢弃旧流（摘 onended + 停轨）：旧轨还活着的话，它的 onended 仍会
      // 调 stopScreenShare，把这次新分享一起停掉。
      releaseShareStream();
      attachSharePreviewStream(stream, 'Share preview playback failed');
      peerSessionTokenRef.current += 1;
      // 新分享是全新会话：清掉上一次的终态标记与重试预算。
      sharerFailureHandledRef.current = false;
      sharerSignalingBrokenRef.current = false;
      sharerReconnectAttemptsRef.current = 0;
      sharerPeerRebuildsRef.current = 0;
      shareRoomFailureRef.current = null;
      shareRoomRenewalFailuresRef.current = 0;
      setShareRoomRenewalWarning(false);
      setShareRoomExpired(false);
      // 冷却还在走就别清：清了之后「关闭」终态卡再点主按钮就能绕过倒计时去撞 429。
      if (shareRoomRetryCooldown.secondsLeft === null) {
        setShareRoomRetryAt(null);
      }
      // 上一轮链接已经作废（过期/被拒）：丢掉死房号，重新登记一个，而不是拿它去撞。
      if (shareRoomExpired) {
        shareRoomRef.current = null;
        setShareRoom(null);
      }
      setSharerFailure(null);
      setIsSharing(true);
      // 「已开始」要等信令 ready 再发：这里只记下这次的音频后缀。
      shareStartNotice.queue(getScreenShareAudioSuffix(stream));
      void initializePeer().then((started) => {
        if (started) return;
        // 闸门被别的初始化占着（典型场景：刚停止又立刻开始）：不能静默吞掉，
        // 交给恢复流程在它结束之后再起一次。
        sharerSignalingBrokenRef.current = true;
        setSharerRecoveryTick((tick) => tick + 1);
      });
    } catch (err) {
      const failure = describeCaptureError(err);
      logDebug('warn', 'screen-share start failed', {
        name: failure.name,
        message: failure.message,
        embeddedFrame: isEmbeddedFrame(),
      });
      setError(failure.description);
      if (!failure.isCancel) {
        onNotification('屏幕共享启动失败', 'error');
      }
    }
  };

  const changeScreenSource = async () => {
    try {
      const newStream = await prepareCapturedStream(
        await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaConstraints())
      );

      // 已有 MediaConnection 只有在协商时就有 audio m-line（即存在 audio sender）才能
      // 收到新源的音轨；否则 replaceTrack 无处可挂，提示里不能宣称“含音频”。
      const canCarryAudio = activeCallsRef.current.every(
        (call) => findLiveAudioSender(call.peerConnection) !== null
      );
      const audioSuffix = newStream.getAudioTracks().length > 0 && canCarryAudio ? '（含音频）' : '';

      releaseShareStream();
      attachSharePreviewStream(newStream, 'Window switch preview playback failed');
      replaceActiveCallTracks(newStream);
      onNotification(`已切换共享窗口${audioSuffix}`, 'success');
    } catch (err) {
      const failure = describeCaptureError(err);
      logDebug('warn', 'screen-share change source failed', {
        name: failure.name,
        message: failure.message,
      });
      if (!failure.isCancel) {
        onNotification('切换共享窗口失败', 'error');
      }
    }
  };

  const stopScreenShare = () => {
    // 让仍在 await 的 initializePeer 作废，避免停止后又有新 peer 注册。
    // 闸门换新：否则「停止 → 立刻再开始」的新初始化会在旧闸门上拿到 false 被丢弃。
    peerSessionTokenRef.current += 1;
    peerInitFlightRef.current.reset();
    // 结束分享即撤销房号：旧链接（?view=<peerId>）之后不可再用，也不会被新会话复用。
    const room = shareRoomRef.current;
    shareRoomRef.current = null;
    setShareRoom(null);
    if (room) {
      void revokeScreenShareRoom(room);
      forgetScreenShareSessionProof(room);
    }
    broadcastShareEnded('stopped');
    if (sharerReconnectTimerRef.current) {
      clearTimeout(sharerReconnectTimerRef.current);
      sharerReconnectTimerRef.current = null;
    }
    sharerReconnectAttemptsRef.current = 0;
    sharerPeerRebuildsRef.current = 0;
    sharerSignalingBrokenRef.current = false;
    sharerFailureHandledRef.current = false;
    shareRoomFailureRef.current = null;
    shareRoomRenewalFailuresRef.current = 0;
    shareRoomTimeoutsRef.current = 0;
    setShareRoomRenewalWarning(false);
    setShareRoomExpired(false);
    setSharerFailure(null);
    // 停止共享就结束这一轮限流上下文：冷却不该跨「用户主动停止」继续生效。
    setShareRoomRetryAt(null);

    if (streamRef.current) {
      // 同 failSharerSession：停轨统一走 helper，别在这里留一份裸 stop()。
      releaseCapturedStream(streamRef.current);
      streamRef.current = null;
    }

    activeDataConnectionsRef.current.forEach((conn) => conn.close());
    activeDataConnectionsRef.current = [];
    viewerHeartbeatsRef.current = {};

    activeCallsRef.current.forEach((call) => call.close());
    activeCallsRef.current = [];
    setViewerCount(0);
    peerQualityLevelRef.current.clear();
    setQualityLevel('high');
    qualityLevelRef.current = 'high';
    stopBandwidthMonitoring();

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsSharing(false);
    setPeerId(null);
    setIsPeerReady(false);
    onNotification('屏幕共享已停止', 'info');
  };

  useEffect(() => {
    failSharerSessionRef.current = failSharerSession;
  });

  return (
    <ScreenShareUI
      isSharing={isSharing}
      isViewing={isViewing}
      isConnecting={isConnecting}
      viewerConnectingStage={viewerConnectingStage}
      error={error}
      targetSharerId={targetSharerId}
      cancelConnecting={cancelConnecting}
      retryConnection={retryConnection}
      dismissConnectionError={() => {
        clearPersistedViewerSession();
        setTargetSharerId(null);
        setError(null);
      }}
      dismissError={dismissViewerError}
      viewerVideoRef={viewerVideoRef}
      needsPlayClick={needsPlayClick}
      onViewerPlayClick={() => {
        if (videoRef.current) {
          const hasAudioTrack = (streamRef.current?.getAudioTracks().length ?? 0) > 0;
          videoRef.current.muted = !hasAudioTrack;
          videoRef.current.play()
            .then(() => {
              setNeedsPlayClick(false);
            })
            .catch((error) => {
              logDebug('warn', 'Viewer play button retry failed', error);
            });
        }
      }}
      stopViewing={() => stopViewing(true)}
      qualityLabels={qualityLabels}
      remoteQuality={remoteQuality}
      shareLink={shareLink}
      copyShareLink={copyShareLink}
      copied={copied}
      isPeerReady={isPeerReady}
      isShareLive={isShareLive}
      shareRoomRenewalWarning={shareRoomRenewalWarning}
      shareRoomExpired={shareRoomExpired}
      hasBeenReady={hasBeenReady}
      sharerFailure={sharerFailure}
      dismissSharerFailure={() => {
        setSharerFailure(null);
        sharerFailureHandledRef.current = false;
      }}
      recommendedViewerCount={viewerCapacity.recommended}
      shareRoomRetrySeconds={shareRoomRetryCooldown.secondsLeft}
      viewerRetrySeconds={viewerRetryCooldown.secondsLeft}
      maxViewerCount={viewerCapacity.max}
      viewerCount={viewerCount}
      qualityLevel={qualityLevel}
      sharerVideoRef={videoRef}
      changeScreenSource={changeScreenSource}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
    />
  );
};



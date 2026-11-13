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
import { createSessionSecretHash } from '../services/signaling/sessionBinding';
import { logDebug } from '../services/diagnostics';
import { SIGNALING_UNREACHABLE_MESSAGE, getPeerRuntimeErrorMessage } from '../services/connectionGuidance';
import { canAdmitViewer } from '../services/screenShare/viewerAdmission';
import {
  CONNECTION_TIMINGS,
  SCREEN_SHARE_LIMITS,
  SCREEN_SHARE_VIEWER_CONNECT_TIMEOUT_MS,
} from '../constants/transfer';
import {
  SCREEN_SHARE_CAPTURE_PRESETS,
  resolveAggregateQuality,
  resolveBitrateCap,
  shouldDowngradeQuality,
  shouldUpgradeQuality,
  type ScreenShareQualityLevel,
} from '../services/screenShare/bitratePolicy';

interface ScreenShareProps {
  onNotification: (message: string, type: 'success' | 'info' | 'error') => void;
  initialViewId?: string;
  /** 共享/观看/建连进行中时为 true：页面滑动据此禁用，避免误触切换页面中断画面 */
  onBusyChange?: (busy: boolean) => void;
}

type QualityLevel = ScreenShareQualityLevel;

// 屏幕录制失败不止「用户取消」一种：浏览器可能对「用户取消」「权限策略拒绝」
// 「嵌入式预览框」都抛 NotAllowedError，所以这里把原始 name/message 一起带出来，
// 不要把所有 NotAllowedError 都说成用户取消。
type ScreenCaptureFailure = {
  name: string;
  message: string;
  isCancel: boolean;
  description: string;
};

const isEmbeddedFrame = () =>
  typeof window !== 'undefined' && window.self !== window.top;

const hasUserActivation = (): boolean => {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation ? activation.isActive : true;
};

export const describeScreenCaptureFailure = (error: unknown): ScreenCaptureFailure => {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const embedded = isEmbeddedFrame();

  if (name === 'AbortError') {
    return { name, message, isCancel: true, description: '用户取消了屏幕共享' };
  }

  if (name === 'NotSupportedError') {
    return {
      name,
      message,
      isCancel: false,
      description: '当前环境不支持屏幕录制（无桌面会话、无头浏览器或嵌入式预览框）',
    };
  }

  if (name === 'NotReadableError') {
    return {
      name,
      message,
      isCancel: false,
      description: '系统拒绝了屏幕录制（可能被安全软件或其他应用占用），请重试',
    };
  }

  if (name === 'NotAllowedError') {
    // Chrome 对「用户取消」「策略拒绝」「缺少用户手势」都给 NotAllowedError，
    // 只有 message 恰好是 "Permission denied" 且页面不在 iframe 里时才可能是取消。
    const looksLikeCancel = /^permission denied\.?$/i.test(message.trim());
    if (looksLikeCancel && !embedded && hasUserActivation()) {
      return { name, message, isCancel: true, description: '用户取消了屏幕共享' };
    }
    if (embedded) {
      return {
        name,
        message,
        isCancel: false,
        description:
          '浏览器拒绝了屏幕录制：当前页面嵌在预览框/iframe 中，浏览器默认禁止在这里录制屏幕，请在新标签页直接打开后重试',
      };
    }
    if (!hasUserActivation()) {
      return {
        name,
        message,
        isCancel: false,
        description:
          '浏览器没有把这次点击识别为用户手势（可能是脚本或自动化触发），请在页面上手动点击「开始共享屏幕」后重试',
      };
    }
    return {
      name,
      message,
      isCancel: false,
      description: `浏览器拒绝了屏幕录制：${message || name}，请检查浏览器的屏幕录制权限、企业策略，或在独立标签页中重试`,
    };
  }

  return {
    name,
    message,
    isCancel: false,
    description: `屏幕共享启动失败：${message || '未知错误'}${name ? `（${name}）` : ''}`,
  };
};

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
    SCREEN_SHARE_RECONNECT_BASE_DELAY_MS,
    SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
    SCREEN_SHARE_HEARTBEAT_INTERVAL_MS,
    SCREEN_SHARE_BANDWIDTH_MONITOR_INTERVAL_MS,
    SCREEN_SHARE_BANDWARMUP_MS,
    SCREEN_SHARE_VIEWER_STATS_INTERVAL_MS,
  } = CONNECTION_TIMINGS;
  const MAX_RECONNECT_ATTEMPTS = SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS;
  // 观看者端：连接过程的全局超时定时器
  const connectingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 每次连接尝试自增；await 回来后若已被取消/被新尝试取代，就不再建 peer。
  const viewerConnectAttemptRef = useRef(0);
  // 分享会话令牌：停止分享后让仍在 await 中的 initializePeer 作废，避免迟到注册占住会话名额。
  const peerSessionTokenRef = useRef(0);
  // 分享会话的密钥摘要：每次开始分享生成一次；同一分享内的信令重连复用同一个，
  // 避免把「自己」认成顶替者。停止分享即清空，下次分享换新身份。
  const sharerSessionSecretHashRef = useRef<string | null>(null);
  // conflict 时要在 error 回调里停下整个分享（清链接与密钥），但那个回调创建在
  // stopScreenShare 定义之前，用 ref 取最新实现。
  const stopScreenShareRef = useRef<() => void>(() => {});
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
      const cap = resolveBitrateCap(level, peerRelayRef.current.get(call.peer) ?? false);
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
        if (peerAppliedCapRef.current.get(call.peer) !== resolveBitrateCap(currentQuality, relay)) {
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
  }, [applyBitrateConstraints, notifyQualityChange, setPeerQualityLevel]);


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

  const getUniqueViewerCount = useCallback(() => {
    return new Set(activeCallsRef.current.map((c) => c.peer)).size;
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


  const generatePeerId = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randomValues = new Uint32Array(6);
    crypto.getRandomValues(randomValues);
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(randomValues[i] % chars.length);
    }
    return `AERO-${id}`;
  }, []);


  const initializePeer = useCallback(async () => {
    const sessionToken = peerSessionTokenRef.current;
    if (peerRef.current) {
      peerRef.current.destroy();
    }

    const iceConfig = await getIceConfig();
    const { default: PeerRuntime } = await loadPeerRuntime();
    // 用户可能在拉配置期间停止共享；此时再注册会留下一个空信令会话占用每 IP 名额。
    if (peerSessionTokenRef.current !== sessionToken) return;
    // 会话密钥摘要只生成一次：重建 peer / 信令重连复用同一个，服务端才认这是同一会话。
    const sessionSecretHash =
      sharerSessionSecretHashRef.current ?? (await createSessionSecretHash());
    if (peerSessionTokenRef.current !== sessionToken) return;
    sharerSessionSecretHashRef.current = sessionSecretHash;
    const id = generatePeerId();
    const useSecurePeerServer = window.location.protocol === 'https:';
    const peer = new PeerRuntime(id, {
      debug: 0,
      secure: useSecurePeerServer,
      pingInterval: 5000, // 缩短心跳间隔以保持 VPN 隧道活跃
      sessionSecretHash,
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
      sharerPeerOpenedAtRef.current = Date.now();
      setPeerId(openedId);
      setIsPeerReady(true);
      // 只清掉「信令不可达」的提示；其它错误（权限、设备）不该被恢复事件覆盖。
      setError((prev) => (prev === SIGNALING_UNREACHABLE_MESSAGE ? null : prev));
    };

    peer.on('open', (openedId) => {
      logDebug('log', 'Peer ID:', openedId);
      handleSignalingReady(openedId);
      onNotification(`连接 ID: ${openedId}`, 'info');
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
      const alreadyTracked = existingViewers.has(call.peer) || pendingViewers.has(call.peer);
      if (!alreadyTracked && !canAdmitViewer({
        activeViewers: existingViewers.size,
        pendingViewers: pendingViewers.size,
        maxViewers: SCREEN_SHARE_LIMITS.MAX_VIEWERS,
      })) {
        // P2P mesh 下每多一个 viewer 就多一份上行编码，超过上限后在分享端直接拒绝，
        // 比让信令的每 IP 会话上限在加入中途失败更可解释。
        onNotification(`观看人数已达上限（${SCREEN_SHARE_LIMITS.MAX_VIEWERS} 人）`, 'info');
        try { call.close(); } catch {}
        return;
      }

      // answer() 要等一次 round-trip：名额必须现在占，不能等 answer 回来才计入。
      const reservedSeat = !alreadyTracked;
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
            const initialCap = resolveBitrateCap(
              currentQuality,
              peerRelayRef.current.get(call.peer) ?? true,
            );
            applyBitrateConstraints(call.peerConnection, currentQuality, initialCap);
            // 某些浏览器在初始协商后才完全挂载 sender 参数，短延迟重复应用可减少前几秒模糊
            setTimeout(() => {
              if (call.peerConnection && !viewerGone) {
                const quality = peerQualityLevelRef.current.get(call.peer) || 'high';
                applyBitrateConstraints(
                  call.peerConnection,
                  quality,
                  resolveBitrateCap(quality, peerRelayRef.current.get(call.peer) ?? true),
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
      if (err?.type === 'session-conflict') {
        // 同 peerId 的已有会话不接受这次接管：要么本浏览器丢了会话密钥，要么有人拿着
        // 分享链接顶号但拿不到密钥。重连只会反复被拒（两个方向互踢），交给用户重开。
        // 先完整停掉分享（会清链接、密钥与 peer），再用通知提示；继续显示
        // 「分享中」会让用户以为链接还能用，而这正是被顶号的状态。
        setIsPeerReady(false);
        stopScreenShareRef.current();
        onNotification(getPeerRuntimeErrorMessage('session-conflict'), 'error');
        return;
      }
      if (err?.type === 'disconnected') {
        // 信令重连预算耗尽：peerRuntime 自己不会再发 disconnected 事件，靠 tick 让恢复
        // effect 再跑一次，由它决定重建 peer 还是放弃。
        setError(SIGNALING_UNREACHABLE_MESSAGE);
        setIsPeerReady(false);
        setSharerRecoveryTick((tick) => tick + 1);
        return;
      }
      setError(`PeerJS 错误: ${err.message}`);
      setIsPeerReady(false);
    });

    peer.on('disconnected', () => {
      logDebug('log', 'Peer disconnected');
      // 不在这里直调 peer.reconnect()：那会绕过指数退避，把「握手成功即被关」放大成
      // 每秒一次的重连风暴。退避与重建由下面的 recovery effect 统一负责。
      setIsPeerReady(false);
    });

    peerRef.current = peer;
    return peer;
  }, [generatePeerId, onNotification, applyBitrateConstraints, startBandwidthMonitoring, addActiveCall, removeActiveCall, preferVideoCodecs, sendQualityToViewer, syncAggregateQualityLevel, setPeerQualityLevel]);


  // 分享者端：定期检查观看者心跳，移除断开的连接
  useEffect(() => {
    if (!isSharing) return;

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const timeoutThreshold = 10000; // 10秒未收到心跳视为断开

      const deadPeers: string[] = [];

      // 检查所有活跃的数据连接
      activeDataConnectionsRef.current.forEach(conn => {
        const lastHeartbeat = viewerHeartbeatsRef.current[conn.peer];
        if (lastHeartbeat && now - lastHeartbeat > timeoutThreshold) {
          logDebug('log', `Viewer ${conn.peer} timed out, closing connection`);
          deadPeers.push(conn.peer);
          conn.close();
        }
      });

      if (deadPeers.length > 0) {
        // 关闭对应的媒体连接
        activeCallsRef.current.forEach(call => {
          if (deadPeers.includes(call.peer)) {
            call.close();
          }
        });

        // 兜底同步，避免极端情况下 close 事件丢失导致观看人数未更新
        syncViewerCount();
      }
    }, 5000); // 每5秒检查一次

    return () => clearInterval(checkInterval);
  }, [isSharing, syncViewerCount]);

  useEffect(() => {
    if (!isSharing) {
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }
      sharerReconnectAttemptsRef.current = 0;
      sharerPeerOpenedAtRef.current = null;
      sharerPeerRebuildsRef.current = 0;
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

    // Recover only after we had a valid sharer peer id once.
    if (!peerId) return;
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
      const currentPeer = peerRef.current;
      if (!currentPeer || currentPeer.destroyed || !isSharing) return;

      // retrySignaling() 返回 false 也可能只是「WS 本来就 OPEN / 正在 CONNECTING」。
      // 只有明确救不回来的状态才值得销毁 peer：销毁会换掉 peerId 并关掉所有 viewer
      // 的媒体连接，把一个可自愈的信令抖动升级成全员断流。
      let recovery = currentPeer.signalingRecoveryState();
      if (recovery === 'idle') {
        try {
          currentPeer.retrySignaling();
        } catch {
          // retry 内部已处理异常；下一轮状态判定会决定是否重建。
        }
        recovery = currentPeer.signalingRecoveryState();
      }

      // 'rejected' 多是不可用的 id / 限流，换一个 peerId 也救不回来，反而会让所有
      // 已分享出去的链接失效。只有重连预算耗尽或对象已销毁才值得重建。
      if (recovery === 'rejected') {
        onNotification('信令服务拒绝了当前会话，请稍后重试', 'error');
        return;
      }
      const shouldRebuild = recovery === 'exhausted' || recovery === 'destroyed';
      if (!shouldRebuild) return;

      if (sharerPeerRebuildsRef.current >= SCREEN_SHARE_MAX_PEER_REBUILDS) {
        onNotification('信令连接持续失败，请刷新页面后重新开始共享', 'error');
        return;
      }
      sharerPeerRebuildsRef.current += 1;

      try {
        if (!currentPeer.destroyed) currentPeer.destroy();
      } catch {
        // Ignore destroy errors.
      }
      if (isSharing) {
        onNotification('信令连接恢复失败，正在重建共享连接 ID...', 'info');
        await initializePeer();
        sharerReconnectAttemptsRef.current = 0;
        sharerPeerOpenedAtRef.current = null;
      }
    }, delay);
  }, [isSharing, isPeerReady, peerId, sharerRecoveryTick, onNotification, initializePeer]);



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
    }

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

    // 'open' 只在首次注册时发一次；信令自动重连成功后走 'signaling:restored'。
    // 两处都进入同一条建会话路径，否则观看端在连接过程中遇到 WS 抖动会永远停在错误页。
    const handleViewerSignalingReady = () => {
      if (viewerConnectAttemptRef.current !== attemptId || isManualStopRef.current) {
        peer.destroy();
        return;
      }
      if (dataConnectionRef.current) return; // 已经建过会话，恢复事件只代表信令可用
      logDebug('log', 'Viewer peer opened, calling:', sharerId);
      // 连接成功，重置重连计数
      reconnectAttemptsRef.current = 0;
      setViewerConnectingStage('connecting_media');

      // 1. 建立数据连接（用于接收画质信息 和 发送心跳）
      const dataConn = peer.connect(sharerId);

      dataConn.on('open', () => {
          logDebug('log', 'Data connection opened');

        // 启动心跳发送（每3秒一次）
        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = setInterval(() => {
          if (dataConn.open) {
            dataConn.send({ type: 'heartbeat' });
          }
        }, SCREEN_SHARE_HEARTBEAT_INTERVAL_MS);
      });

      dataConn.on('data', (data: any) => {
            logDebug('log', 'Received data:', data);
        if (data && data.type === 'quality' && data.value) {
          setRemoteQuality(data.value as 'high' | 'medium' | 'low');
          return;
        }
        if (data && data.type === 'share-ended') {
          const reasonLabel = data.reason === 'window_closed' ? '共享方已离开页面，屏幕共享已结束' : '共享方已停止共享';
          handleRemoteShareEnded(reasonLabel);
        }
      });

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

      const stopFreezeWatch = () => {
        if (viewerStatsTimerRef.current) {
          clearInterval(viewerStatsTimerRef.current);
          viewerStatsTimerRef.current = null;
        }
      };

      const reconnectViewerAfterLoss = () => {
        if (isManualStopRef.current || remoteShareEndedRef.current) return;
        if (viewerConnectAttemptRef.current !== attemptId) return;
        stopFreezeWatch();
        logDebug('warn', 'Unexpected disconnection, attempting reconnect...');
        stopViewing(false); // 不清除 targetId

        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setError('连接断开，已达到最大重试次数，请手动重试');
          onNotification('屏幕共享连接断开', 'error');
          return;
        }

        reconnectAttemptsRef.current += 1;
        const delay = Math.min(
          SCREEN_SHARE_RECONNECT_BASE_DELAY_MS * reconnectAttemptsRef.current,
          SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
        );
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          connectToSharer(sharerId, true);
        }, delay);
        setError(`连接断开，${delay / 1000}秒后尝试重连...`);
      };

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

      call.on('stream', (remoteStream) => {
        if (viewerConnectAttemptRef.current !== attemptId) return;
        if (hasReceivedStream) {
              logDebug('log', 'Stream event fired again, skipping duplicate handling');
          return;
        }
        hasReceivedStream = true;


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

        if (remoteShareEndedRef.current) {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        if (isManualStopRef.current) {
          stopViewing(true);
          onNotification('屏幕共享已结束', 'info');
          return;
        }

        reconnectViewerAfterLoss();
      });

      call.on('error', (err) => {
        if (viewerConnectAttemptRef.current !== attemptId) return;
        stopFreezeWatch();
        console.error('Call error:', err);

        if (remoteShareEndedRef.current) {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        if (!isManualStopRef.current) {
          stopViewing(false);
          // 这里也可以触发重连，逻辑同上
          setError(`连接发生错误: ${err.message}`);
        } else {
          setError(`连接失败: ${err.message}`);
          setIsConnecting(false);
        }
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

      // 处理特定的 PeerJS 错误，尝试重连
      if (!isManualStopRef.current && (err.type === 'network' || err.type === 'peer-unavailable' || err.type === 'disconnected')) {
        if (err.type === 'peer-unavailable' && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          // 可能是分享者暂时掉线，稍后重试
          stopViewing(false);
          reconnectAttemptsRef.current += 1;
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
          }
          reconnectTimerRef.current = setTimeout(() => {
            connectToSharer(sharerId, true);
          }, 3000);
          setError('连接中断，正在尝试重新连接...');
          return;
        }
      }

      if (err.type === 'peer-unavailable') {
        setError('找不到该分享者，请确认连接 ID 是否正确或分享者仍在共享');
      } else {
        setError(`连接错误: ${err.message}`);
      }
      setIsConnecting(false);
    });
  }, [onNotification, stopViewing, handleRemoteShareEnded, persistViewerSession]);


  const cancelConnecting = useCallback(() => {
    stopViewing();
    onNotification('已取消连接', 'info');
  }, [stopViewing, onNotification]);


  const retryConnection = useCallback(() => {
    if (targetSharerId) {
      connectToSharer(targetSharerId);
    }
  }, [targetSharerId, connectToSharer]);


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
        streamRef.current.getTracks().forEach(track => track.stop());
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
    };
    window.addEventListener('pagehide', notifyShareEndOnPageExit);
    window.addEventListener('beforeunload', notifyShareEndOnPageExit);
    return () => {
      window.removeEventListener('pagehide', notifyShareEndOnPageExit);
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

      attachSharePreviewStream(stream, 'Share preview playback failed');
      peerSessionTokenRef.current += 1;
      setIsSharing(true);
      initializePeer();
      onNotification(`屏幕共享已开始${getScreenShareAudioSuffix(stream)}`, 'success');
    } catch (err) {
      const failure = describeScreenCaptureFailure(err);
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

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      attachSharePreviewStream(newStream, 'Window switch preview playback failed');
      replaceActiveCallTracks(newStream);
      onNotification(`已切换共享窗口${audioSuffix}`, 'success');
    } catch (err) {
      const failure = describeScreenCaptureFailure(err);
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
    peerSessionTokenRef.current += 1;
    // 分享结束即销毁会话密钥：下次分享必须是新身份，旧链接不能凭旧密钥接管。
    sharerSessionSecretHashRef.current = null;
    broadcastShareEnded('stopped');
    if (sharerReconnectTimerRef.current) {
      clearTimeout(sharerReconnectTimerRef.current);
      sharerReconnectTimerRef.current = null;
    }
    sharerReconnectAttemptsRef.current = 0;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
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
    stopScreenShareRef.current = stopScreenShare;
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
      viewerCount={viewerCount}
      qualityLevel={qualityLevel}
      sharerVideoRef={videoRef}
      changeScreenSource={changeScreenSource}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
    />
  );
};



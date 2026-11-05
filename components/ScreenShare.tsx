import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { loadPeerRuntime, type Peer, type MediaConnection, type DataConnection } from '../services/peerRuntime';
import { getIceConfig } from '../services/stunService';
import {
  getPreferredScreenShareCodecOrder,
  getScreenShareBrowserProfile,
  shouldEnableLayeredScreenShareEncoding,
} from '../services/screenShareCompatibility';
import {
  clearScreenShareViewSession,
  writeScreenShareViewSession,
} from '../services/screenShareViewerSession';
import { ScreenShareUI, ScreenShareViewerConnectingStage } from './screen-share/ScreenShareUI';
import { logDebug } from '../services/diagnostics';
import { CONNECTION_TIMINGS } from '../constants/transfer';

interface ScreenShareProps {
  onNotification: (message: string, type: 'success' | 'info' | 'error') => void;
  initialViewId?: string;
}

type NetworkRouteClass = 'lan' | 'wan' | 'relay' | 'unknown';

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
      description: '当前环境不支持屏幕录制（无桌面会话、无头浏览器或嵌入式预览框）。',
    };
  }

  if (name === 'NotReadableError') {
    return {
      name,
      message,
      isCancel: false,
      description: '系统拒绝了屏幕录制（可能被安全软件或其他应用占用），请重试。',
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
          '浏览器拒绝了屏幕录制：当前页面嵌在预览框/iframe 中，浏览器默认禁止在这里录制屏幕，请在新标签页直接打开后重试。',
      };
    }
    if (!hasUserActivation()) {
      return {
        name,
        message,
        isCancel: false,
        description:
          '浏览器没有把这次点击识别为用户手势（可能是脚本或自动化触发），请在页面上手动点击「开始共享屏幕」后重试。',
      };
    }
    return {
      name,
      message,
      isCancel: false,
      description: `浏览器拒绝了屏幕录制：${message || name}。请检查浏览器的屏幕录制权限、企业策略，或在独立标签页中重试。`,
    };
  }

  return {
    name,
    message,
    isCancel: false,
    description: `屏幕共享启动失败：${message || '未知错误'}${name ? `（${name}）` : ''}`,
  };
};

export const ScreenShare: React.FC<ScreenShareProps> = ({ onNotification, initialViewId }) => {
  const [isSharing, setIsSharing] = useState(false);
  const [isViewing, setIsViewing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [viewerConnectingStage, setViewerConnectingStage] = useState<ScreenShareViewerConnectingStage>('');
  const [error, setError] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [isPeerReady, setIsPeerReady] = useState(false);
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
  const isManualStopRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const remoteShareEndedRef = useRef(false);
  const remoteShareEndHandledRef = useRef(false);
  const sharerReconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const sharerReconnectAttemptsRef = useRef(0);
  const {
    SCREEN_SHARE_CONNECT_TIMEOUT_MS,
    SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS,
    SCREEN_SHARE_RECONNECT_BASE_DELAY_MS,
    SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
    SCREEN_SHARE_HEARTBEAT_INTERVAL_MS,
    SCREEN_SHARE_BANDWIDTH_MONITOR_INTERVAL_MS,
    SCREEN_SHARE_BANDWARMUP_MS,
  } = CONNECTION_TIMINGS;
  const MAX_RECONNECT_ATTEMPTS = SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS;
  const MAX_SHARER_SIGNAL_RECONNECT_ATTEMPTS = SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS;
  // 观看者端：连接过程的全局超时定时器
  const connectingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const bandwidthMonitorsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());


  const [qualityLevel, setQualityLevel] = useState<'high' | 'medium' | 'low'>('high');
  // 观看者端：当前的画质状态
  const [remoteQuality, setRemoteQuality] = useState<'high' | 'medium' | 'low'>('high');


  const qualityLevelRef = useRef<'high' | 'medium' | 'low'>('high');
  const peerQualityLevelRef = useRef<Map<string, 'high' | 'medium' | 'low'>>(new Map());
  const peerLayerModeRef = useRef<Map<string, 'single' | 'svc' | 'simulcast'>>(new Map());
  const peerRouteClassRef = useRef<Map<string, NetworkRouteClass>>(new Map());
  const peerDynamicCapRef = useRef<Map<string, number>>(new Map());


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

  const getAggregateQualityLevel = useCallback((): 'high' | 'medium' | 'low' => {
    const levels = Array.from(peerQualityLevelRef.current.values());
    if (levels.length === 0) return 'high';
    if (levels.includes('low')) return 'low';
    if (levels.includes('medium')) return 'medium';
    return 'high';
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


  const bitrateLimits = useMemo(() => ({
    high: { min: 2000000, max: 100000000 },    // 原画：最大 100Mbps，起步 2Mbps
    medium: { min: 500000, max: 8000000 },     // 高清：提升至 8Mbps，减少文字边缘糊化
    low: { min: 100000, max: 2500000 },        // 流畅：仍保留可读性，减少过度压缩
  }), []);

  const qualityCaptureConstraints = useMemo(() => ({
    high: { maxFrameRate: 60, scaleResolutionDownBy: 1 },
    medium: { maxFrameRate: 45, scaleResolutionDownBy: 1 },
    low: { maxFrameRate: 24, scaleResolutionDownBy: 1.25 },
  }), []);

  const routeBitrateCaps = useMemo<Record<NetworkRouteClass, { high: number; medium: number; low: number }>>(() => ({
    lan: { high: 100000000, medium: 12000000, low: 3500000 },
    wan: { high: 20000000, medium: 8000000, low: 2500000 },
    relay: { high: 6000000, medium: 3500000, low: 1500000 },
    unknown: { high: 12000000, medium: 6000000, low: 2000000 },
  }), []);

  const isPrivateOrMdnsAddress = useCallback((rawAddress?: string | null) => {
    if (!rawAddress) return false;
    const address = rawAddress.trim().toLowerCase();
    if (!address) return false;
    if (address.endsWith('.local')) return true;
    if (address === '::1') return true;
    if (address.startsWith('fe80:')) return true;
    if (address.startsWith('fc') || address.startsWith('fd')) return true;

    const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    return false;
  }, []);

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
    options?: { maxBitrateCap?: number },
  ) => {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');

    if (videoSender) {

      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      const levelLimits = bitrateLimits[level];
      const baseMaxBitrate = levelLimits.max;
      const requestedCap = typeof options?.maxBitrateCap === 'number' && options.maxBitrateCap > 0
        ? Math.floor(options.maxBitrateCap)
        : baseMaxBitrate;
      const boundedMaxBitrate = Math.max(levelLimits.min, Math.min(baseMaxBitrate, requestedCap));

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
          encoding.maxFramerate = Math.max(15, qualityCaptureConstraints[level].maxFrameRate - idx * 15);
          if (typeof encoding.scaleResolutionDownBy !== 'number') {
            encoding.scaleResolutionDownBy = idx === 0 ? 1 : idx === 1 ? 1.5 : 2.5;
          }
          if ('priority' in encoding) {
            (encoding as any).priority = idx === 0 ? 'high' : level === 'low' ? 'low' : 'medium';
          }
        });
      } else {
        params.encodings[0].maxBitrate = boundedMaxBitrate;
        params.encodings[0].maxFramerate = qualityCaptureConstraints[level].maxFrameRate;
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
        logDebug('warn', 'Failed to set bitrate parameters:', err);
      }
    }
  }, [bitrateLimits, qualityCaptureConstraints]);

  const configureAdaptiveVideoLayers = useCallback(async (call: MediaConnection) => {
    if (!shouldEnableLayeredScreenShareEncoding(browserProfile)) {
      peerLayerModeRef.current.set(call.peer, 'single');
      return;
    }
    const pc = call.peerConnection;
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;

    const supportsSimulcast = typeof (sender as any).setParameters === 'function';
    let mode: 'single' | 'svc' | 'simulcast' = 'single';

    if (supportsSimulcast) {
      const params = sender.getParameters();
      try {
        const canTrySimulcast =
          (!params.encodings || params.encodings.length <= 1) &&
          !((params.encodings?.[0] as any)?.rid);

        if (canTrySimulcast) {
          const simulcastParams: RTCRtpSendParameters = {
            ...params,
            encodings: [
              { rid: 'h', maxBitrate: 14_000_000, scaleResolutionDownBy: 1, maxFramerate: 60, active: true },
              { rid: 'm', maxBitrate: 6_000_000, scaleResolutionDownBy: 1.5, maxFramerate: 45, active: true },
              { rid: 'l', maxBitrate: 2_000_000, scaleResolutionDownBy: 2.5, maxFramerate: 24, active: true },
            ],
          };
          (simulcastParams as any).degradationPreference = 'maintain-resolution';
          await sender.setParameters(simulcastParams);
          mode = 'simulcast';
        }
      } catch (err) {
        // Simulcast may be unsupported on some browser/peerconnection states; fall through to SVC.
      }
    }

    if (mode === 'single') {
      const svcParams = sender.getParameters();
      if (!svcParams.encodings || svcParams.encodings.length === 0) {
        svcParams.encodings = [{}];
      }
      const first = svcParams.encodings[0] as any;
      if ('scalabilityMode' in first) {
        first.scalabilityMode = 'L3T3';
        mode = 'svc';
      }
      (svcParams as any).degradationPreference = 'maintain-resolution';
      try {
        await sender.setParameters(svcParams);
      } catch {
        mode = 'single';
      }
    }

    peerLayerModeRef.current.set(call.peer, mode);
  }, [browserProfile]);


  useEffect(() => {
    qualityLevelRef.current = qualityLevel;
  }, [qualityLevel]);


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
    if (bandwidthMonitorsRef.current.has(call.peer)) return;

    let lastBytesSent = 0;
    let lastPacketsSent = 0;
    let lastPacketsLost = 0;
    let lastTimestamp = Date.now();
    let consecutiveLowBandwidth = 0;
    let consecutiveHighBandwidth = 0;
    const monitorStartedAt = Date.now();
    const BANDWIDTH_WARMUP_MS = SCREEN_SHARE_BANDWARMUP_MS;

    const monitor = async () => {
      try {
        const stats = await pc.getStats();
        let currentBytesSent = 0;
        let packetsLost = 0;
        let packetsSent = 0;
        let availableOutgoingBitrate = 0;
        let routeClass: NetworkRouteClass = peerRouteClassRef.current.get(call.peer) || 'unknown';
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
          if (report.type === 'transport' && report.selectedCandidatePairId && stats.has(report.selectedCandidatePairId)) {
            selectedPair = stats.get(report.selectedCandidatePairId);
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

        if (selectedPair && typeof selectedPair.availableOutgoingBitrate === 'number') {
          availableOutgoingBitrate = selectedPair.availableOutgoingBitrate;
        }
        if (selectedPair) {
          const localCandidate = selectedPair.localCandidateId && stats.has(selectedPair.localCandidateId)
            ? stats.get(selectedPair.localCandidateId) as any
            : null;
          const remoteCandidate = selectedPair.remoteCandidateId && stats.has(selectedPair.remoteCandidateId)
            ? stats.get(selectedPair.remoteCandidateId) as any
            : null;

          const localType = (localCandidate?.candidateType || '').toLowerCase();
          const remoteType = (remoteCandidate?.candidateType || '').toLowerCase();
          const localAddress = localCandidate?.address || localCandidate?.ip || localCandidate?.ipAddress || '';
          const remoteAddress = remoteCandidate?.address || remoteCandidate?.ip || remoteCandidate?.ipAddress || '';

          if (localType === 'relay' || remoteType === 'relay') {
            routeClass = 'relay';
          } else if (isPrivateOrMdnsAddress(localAddress) && isPrivateOrMdnsAddress(remoteAddress)) {
            routeClass = 'lan';
          } else if (localType || remoteType || localAddress || remoteAddress) {
            routeClass = 'wan';
          }
          peerRouteClassRef.current.set(call.peer, routeClass);
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
        const limits = bitrateLimits[currentQuality];
        const routeCaps = routeBitrateCaps[routeClass];
        let targetDynamicCap = routeCaps[currentQuality];
        if (availableOutgoingBitrate > 0) {
          const headroomFactor = routeClass === 'relay' ? 0.72 : routeClass === 'wan' ? 0.82 : 0.88;
          const congestionSafeCap = Math.floor(availableOutgoingBitrate * headroomFactor);
          if (congestionSafeCap > 0) {
            targetDynamicCap = Math.min(targetDynamicCap, congestionSafeCap);
          }
        }
        targetDynamicCap = Math.max(bitrateLimits.low.min, targetDynamicCap);

        const previousCap = peerDynamicCapRef.current.get(call.peer);
        let smoothedCap = targetDynamicCap;
        if (typeof previousCap === 'number' && previousCap > 0) {
          if (targetDynamicCap < previousCap) {
            smoothedCap = Math.max(targetDynamicCap, Math.floor(previousCap * 0.75));
          } else if (targetDynamicCap > previousCap) {
            smoothedCap = Math.min(targetDynamicCap, Math.floor(previousCap * 1.15));
          }
          const closeEnough = Math.abs(smoothedCap - targetDynamicCap) / Math.max(targetDynamicCap, 1) < 0.05;
          if (closeEnough) smoothedCap = targetDynamicCap;
        }

        const capDelta = previousCap
          ? Math.abs(smoothedCap - previousCap) / Math.max(previousCap, 1)
          : 1;
        peerDynamicCapRef.current.set(call.peer, smoothedCap);
        if (capDelta >= 0.08) {
          await applyBitrateConstraints(pc, currentQuality, { maxBitrateCap: smoothedCap });
        }

        // 连接初期带宽估计和丢包统计波动很大，先预热避免误降档导致“刚连上先糊”
        if (now - monitorStartedAt < BANDWIDTH_WARMUP_MS) {
          return;
        }



        // 清晰优先策略：
        // 默认保持高清/原画，只有在“持续且明显卡顿”时才降档。
        const severeForHigh =
          packetLossRate > 0.12 || (packetLossRate > 0.03 && currentBitrate < limits.min * 0.45);
        const severeForMedium =
          packetLossRate > 0.18 || (packetLossRate > 0.05 && currentBitrate < limits.min * 0.35);

        const shouldDowngrade =
          currentQuality === 'high' ? severeForHigh : currentQuality === 'medium' ? severeForMedium : false;

        if (shouldDowngrade) {
          consecutiveLowBandwidth++;
          consecutiveHighBandwidth = 0;

          // 每 2 秒检测一次：
          // high -> medium 需要连续 12 秒严重卡顿；
          // medium -> low 需要连续 16 秒严重卡顿。
          const lowThreshold = currentQuality === 'high' ? 6 : 8;
          if (consecutiveLowBandwidth >= lowThreshold) {
            const activeCap = peerDynamicCapRef.current.get(call.peer);
            if (currentQuality === 'high') {
              setPeerQualityLevel(call.peer, 'medium');
              await applyBitrateConstraints(pc, 'medium', activeCap ? { maxBitrateCap: activeCap } : undefined);
              onNotification(`观看者 ${call.peer.slice(-4)} 网络波动，已降至高清模式`, 'info');
            } else if (currentQuality === 'medium') {
              setPeerQualityLevel(call.peer, 'low');
              await applyBitrateConstraints(pc, 'low', activeCap ? { maxBitrateCap: activeCap } : undefined);
              onNotification(`观看者 ${call.peer.slice(-4)} 网络极不稳定，已切换到流畅模式`, 'info');
            }
            consecutiveLowBandwidth = 0;
          }
        } else if (packetLossRate < 0.005) { // 只有丢包率极低时才考虑升级
          consecutiveHighBandwidth++;
          consecutiveLowBandwidth = 0;

          if (consecutiveHighBandwidth >= 5) {
            const activeCap = peerDynamicCapRef.current.get(call.peer);
            if (currentQuality === 'low') {
              setPeerQualityLevel(call.peer, 'medium');
              await applyBitrateConstraints(pc, 'medium', activeCap ? { maxBitrateCap: activeCap } : undefined);
              onNotification(`观看者 ${call.peer.slice(-4)} 网络好转，已恢复高清画质`, 'info');
            } else if (currentQuality === 'medium') {
              setPeerQualityLevel(call.peer, 'high');
              await applyBitrateConstraints(pc, 'high', activeCap ? { maxBitrateCap: activeCap } : undefined);
              onNotification(`观看者 ${call.peer.slice(-4)} 网络良好，已切换回原画模式`, 'info');
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
    bandwidthMonitorsRef.current.set(call.peer, timer);
  }, [bitrateLimits, routeBitrateCaps, applyBitrateConstraints, isPrivateOrMdnsAddress, onNotification, setPeerQualityLevel]);


  const stopBandwidthMonitoring = useCallback((peerId?: string) => {
    if (peerId) {
      const timer = bandwidthMonitorsRef.current.get(peerId);
      if (timer) {
        clearInterval(timer);
        bandwidthMonitorsRef.current.delete(peerId);
      }
      peerRouteClassRef.current.delete(peerId);
      peerDynamicCapRef.current.delete(peerId);
      return;
    }

    bandwidthMonitorsRef.current.forEach((timer) => clearInterval(timer));
    bandwidthMonitorsRef.current.clear();
    peerRouteClassRef.current.clear();
    peerDynamicCapRef.current.clear();
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
    peerQualityLevelRef.current.delete(call.peer);
    peerLayerModeRef.current.delete(call.peer);
    peerRouteClassRef.current.delete(call.peer);
    peerDynamicCapRef.current.delete(call.peer);
    syncAggregateQualityLevel();

    if (beforeLength !== activeCallsRef.current.length) {
      syncViewerCount();
      stopBandwidthMonitoring(call.peer);
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
    if (peerRef.current) {
      peerRef.current.destroy();
    }

    const iceConfig = await getIceConfig();
    const { default: PeerRuntime } = await loadPeerRuntime();
    const id = generatePeerId();
    const useSecurePeerServer = window.location.protocol === 'https:';
    const peer = new PeerRuntime(id, {
      debug: 0,
      secure: useSecurePeerServer,
      pingInterval: 5000, // 缩短心跳间隔以保持 VPN 隧道活跃
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: 'all',
      }
    });

    peer.on('open', (openedId) => {
      logDebug('log', 'Peer ID:', openedId);
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }
      sharerReconnectAttemptsRef.current = 0;
      setPeerId(openedId);
      setIsPeerReady(true);
      onNotification(`连接 ID: ${openedId}`, 'info');
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

      if (streamRef.current) {
        if (call.peerConnection) {
          preferVideoCodecs(call.peerConnection);
        }
        setPeerQualityLevel(call.peer, 'high');
        call.answer(streamRef.current);
        const hasNewViewer = addActiveCall(call);
        if (hasNewViewer) {
          onNotification('有观看者加入', 'info');
        }


        if (call.peerConnection) {
          const currentQuality = peerQualityLevelRef.current.get(call.peer) || 'high';
          configureAdaptiveVideoLayers(call);
          const activeCap = peerDynamicCapRef.current.get(call.peer);
          applyBitrateConstraints(
            call.peerConnection,
            currentQuality,
            activeCap ? { maxBitrateCap: activeCap } : undefined,
          );
          // 某些浏览器在初始协商后才完全挂载 sender 参数，短延迟重复应用可减少前几秒模糊
          setTimeout(() => {
            if (call.peerConnection && call.open) {
              const delayedCap = peerDynamicCapRef.current.get(call.peer);
              applyBitrateConstraints(
                call.peerConnection,
                peerQualityLevelRef.current.get(call.peer) || 'high',
                delayedCap ? { maxBitrateCap: delayedCap } : undefined,
              );
            }
          }, 1200);
          startBandwidthMonitoring(call);
        }

        call.on('close', () => {
          removeActiveCall(call);
        });

        call.on('error', (err) => {
          console.error('Call error:', err);
          removeActiveCall(call);
        });
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      setError(`PeerJS 错误: ${err.message}`);
      setIsPeerReady(false);
    });

    peer.on('disconnected', () => {
      logDebug('log', 'Peer disconnected');
      setIsPeerReady(false);
      if (!peer.destroyed) {
        try {
          peer.reconnect();
        } catch {
          // Fallback reconnect will be handled by the recovery effect.
        }
      }
    });

    peerRef.current = peer;
    return peer;
  }, [generatePeerId, onNotification, applyBitrateConstraints, startBandwidthMonitoring, addActiveCall, removeActiveCall, preferVideoCodecs, sendQualityToViewer, syncAggregateQualityLevel, setPeerQualityLevel, configureAdaptiveVideoLayers]);


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
      return;
    }

    if (isPeerReady) {
      if (sharerReconnectTimerRef.current) {
        clearTimeout(sharerReconnectTimerRef.current);
        sharerReconnectTimerRef.current = null;
      }
      sharerReconnectAttemptsRef.current = 0;
      return;
    }

    // Recover only after we had a valid sharer peer id once.
    if (!peerId) return;
    if (sharerReconnectTimerRef.current) return;

    const attempt = sharerReconnectAttemptsRef.current + 1;
    sharerReconnectAttemptsRef.current = attempt;

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), SCREEN_SHARE_RECONNECT_MAX_DELAY_MS);
    sharerReconnectTimerRef.current = setTimeout(async () => {
      sharerReconnectTimerRef.current = null;
      const currentPeer = peerRef.current;
      if (!currentPeer || currentPeer.destroyed || !isSharing) return;

      try {
        if (currentPeer.disconnected) {
          currentPeer.reconnect();
        }
      } catch {
        // Ignore and continue to fallback rebuild path below.
      }

      // Final fallback: rebuild peer when repeated reconnect attempts fail.
      if (attempt >= MAX_SHARER_SIGNAL_RECONNECT_ATTEMPTS) {
        try {
          if (!currentPeer.destroyed) currentPeer.destroy();
        } catch {
          // Ignore destroy errors.
        }
        if (isSharing) {
          onNotification('信令连接恢复失败，正在重建共享连接 ID...', 'info');
          await initializePeer();
        }
      }
    }, delay);
  }, [isSharing, isPeerReady, peerId, onNotification, initializePeer]);



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
    setViewerConnectingStage('connecting_signaling');
    const useSecurePeerServer = window.location.protocol === 'https:';
    const { default: PeerRuntime } = await loadPeerRuntime();
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

    peer.on('open', () => {
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

      call.on('stream', (remoteStream) => {
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
        onNotification('已连接到屏幕共享', 'success');
      });

      call.on('close', () => {
                logDebug('log', 'Call closed');

        if (remoteShareEndedRef.current) {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        // 只有非手动停止时，才触发重连逻辑
        if (!isManualStopRef.current) {
                  logDebug('log', 'Unexpected disconnection, attempting reconnect...');
          stopViewing(false); // 不清除 targetId

          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttemptsRef.current += 1;
            const delay = Math.min(
              SCREEN_SHARE_RECONNECT_BASE_DELAY_MS * reconnectAttemptsRef.current,
              SCREEN_SHARE_RECONNECT_MAX_DELAY_MS,
            ); // 指数退避

            if (reconnectTimerRef.current) {
              clearTimeout(reconnectTimerRef.current);
            }
            reconnectTimerRef.current = setTimeout(() => {
              connectToSharer(sharerId, true);
            }, delay);

            setError(`连接断开，${delay / 1000}秒后尝试重连...`);
          } else {
            setError('连接断开，已达到最大重试次数，请手动重试');
            onNotification('屏幕共享连接断开', 'error');
          }
        } else {
          stopViewing(true);
          onNotification('屏幕共享已结束', 'info');
        }
      });

      call.on('error', (err) => {
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
    });

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

      bandwidthMonitorsRef.current.forEach((timer) => clearInterval(timer));
      bandwidthMonitorsRef.current.clear();

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
      peerLayerModeRef.current.clear();
      peerRouteClassRef.current.clear();
      peerDynamicCapRef.current.clear();
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

      const audioSender = senders.find((sender) => sender.track?.kind === 'audio');
      if (audioSender && nextAudioTrack) {
        audioSender.replaceTrack(nextAudioTrack);
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

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      attachSharePreviewStream(newStream, 'Window switch preview playback failed');
      replaceActiveCallTracks(newStream);
      onNotification(`已切换共享窗口${getScreenShareAudioSuffix(newStream)}`, 'success');
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
    peerLayerModeRef.current.clear();
    peerRouteClassRef.current.clear();
    peerDynamicCapRef.current.clear();
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



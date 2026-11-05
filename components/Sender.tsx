import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  TransferState,
  FileMetadata,
  P2PMessage,
  FileStartPayload,
  FileCompletePayload,
  P2P_PROTOCOL_VERSION,
  type ConnectionTypeLabel,
} from '../types';
import { formatFileSize, generateFileFingerprint } from '../services/fileUtils';
import { createCrc32Hasher } from '../services/crc32WorkerClient';
import { DEFAULT_MAX_PREFIX_CRC_BYTES, computePrefixCrc32 } from '../services/send/prefixCrc';
import { isValidShareCode, requestShareCode, revokeShareSession } from '../services/shareCodeSession';
import { loadPeerRuntime, type Peer, type DataConnection } from '../services/peerRuntime';
import { NO_TURN_WARNING_MESSAGE } from '../services/connectionGuidance';
import { getIceConfig } from '../services/stunService';
import {
  CONNECTION_TIMINGS,
  EXPIRY_DURATIONS,
  TRANSFER_CONFIG,
  type ExpiryOption,
} from '../constants/transfer';
import {
  attachIceRouteToSession,
  collectIceRouteWithRetry,
  ConnectionSession,
  createConnectionSession,
  type IceRoute,
  markConnectionFailure,
  markConnectionSuccess,
  markIceConfigFetched,
  markSignalingOpen,
  markSessionEvent,
  startConnectionAttempt,
} from '../services/connectionTelemetry';
import { getBrowserNetworkProfile } from '../services/networkProfile';
import { normalizeTransferMessage } from '../services/protocol';
import {
  deriveAdaptiveFlow,
  type AdaptiveFlowProfile,
  type ConnectionMetrics,
  type ConnectionRoute,
} from '../services/transfer/adaptiveFlow';
import {
  isDataChannelMessageTooLargeError,
  resolveDataChannelChunkSize,
  waitForDataChannelDrain,
} from '../services/transfer/DataChannelTransmitter';
import { StreamingFileChunkReader } from '../services/transfer/StreamingFileChunkReader';
import { createRouteProbeLogPayload } from '../services/routeProbeLog';
import { getRouteSelectionDecision } from '../services/routeSelectionPolicy';
import { createSessionActivityTracker } from '../services/sessionActivityTracker';
import { resolveFileType } from '../services/fileType';
import {
  getCommittedTransferDisposition,
  isCommittedTransferMessageType,
} from '../services/send/committedTransferGuard';
import { createReceiverSessionRegistry } from '../services/send/receiverSessionRegistry';
import { getVisiblePeerIds } from '../services/send/logicalReceiverSessions';
import { createRouteCommitGate } from '../services/send/routeCommitGate';
import {
  captureLogicalReceiverState,
  restoreLogicalReceiverState,
} from '../services/send/sessionTransferState';
import { createSenderRouteHandshakeHandler } from '../services/send/routeHandshake';
import {
  isSendSequenceCurrent,
  ReceiveCreditGate,
  shouldReleasePeerState,
} from '../services/send/receiveCredit';
import { classifyCandidatePair } from '../services/networkAddress';
import { logDebug, shouldSuppressNoisyPeerError } from '../services/diagnostics';
import { SenderUI } from './sender/SenderUI';

interface SenderProps {
  onNotification: (msg: string, type: 'success' | 'info' | 'error') => void;
  deviceName: string;
}

type PeerTransferStat = {
  peerId: string;
  deviceName: string;
  connectionType: ConnectionTypeLabel;
  speed: string;
  progress: number;
  status: 'waiting' | 'transferring' | 'completed';
};

export const Sender: React.FC<SenderProps> = ({ onNotification, deviceName }) => {
  type PreparingStage = 'fetching_ice' | 'connecting_signaling';
  const [state, setState] = useState<TransferState>(TransferState.IDLE);
  const [fileList, setFileList] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [transferCode, setTransferCode] = useState<string>('');
  const [customCodeInput, setCustomCodeInput] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [totalProgress, setTotalProgress] = useState(0);
  const [currentSpeed, setCurrentSpeed] = useState<string>('0 KB/s');
  const [avgSpeed, setAvgSpeed] = useState<string>('0 KB/s');
  const [currentSpeedBytes, setCurrentSpeedBytes] = useState(0);
  const [avgSpeedBytes, setAvgSpeedBytes] = useState(0);
  
  const [individualStats, setIndividualStats] = useState<PeerTransferStat[]>([]);

  const [isDragOver, setIsDragOver] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  const [showFileList, setShowFileList] = useState(false);
  const [peerNames, setPeerNames] = useState<Record<string, string>>({});

  const [expiryOption, setExpiryOption] = useState<string>('1h');
  // 当前分享的口令登记（结束分享时用它带凭证注销，避免码在 TTL 内继续可被抢占）。
  const shareRegistrationRef = useRef<{ code: string; peerId: string; secret: string } | null>(null);
  const shareRenewalTimerRef = useRef<number | null>(null);
  const [remainingTime, setRemainingTime] = useState<string>('');

  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [preparingStage, setPreparingStage] = useState<PreparingStage>('fetching_ice');

  const peerRef = useRef<Peer | null>(null);
  const activeConnections = useRef<Set<DataConnection>>(new Set());
  const isDestroyingRef = useRef(false);
  const isMountedRef = useRef(true);

  const transferSessionId = useRef<number>(0);
  const activeTransfersCount = useRef<number>(0);
  const activeSendingPeersRef = useRef<Set<string>>(new Set());
  const peerSessionIdsRef = useRef<Map<string, string>>(new Map());
  const sessionToPeerRef = useRef<Map<string, string>>(new Map());
  const ghostCandidateSinceRef = useRef<Map<string, number>>(new Map());
  const peerConnectionTypeRef = useRef<Map<string, PeerTransferStat['connectionType']>>(new Map());
  const peerHeartbeatAtRef = useRef<Map<string, number>>(new Map());
  const peerAwaitingFinalizeAckRef = useRef<Set<string>>(new Set());
  const peerHasProgressSyncRef = useRef<Set<string>>(new Set());
  const peerTransferredBytesRef = useRef<Map<string, number>>(new Map());
  const peerTotalBytesRef = useRef<Map<string, number>>(new Map());
  const peerSyncStartAtRef = useRef<Map<string, number>>(new Map());
  const peerSyncBaseBytesRef = useRef<Map<string, number>>(new Map());
  const peerTransferEpochRef = useRef<Map<string, number>>(new Map());
  const pendingSendPeersRef = useRef<Set<string>>(new Set());
  const peerReceiveCreditRef = useRef<Map<string, ReceiveCreditGate>>(new Map());
  // 最近一次创建的信用门闸，即使 map 里已被清理也保留引用：续传时必须取消它，
  // 否则上一条发送序列会永久卡在 waitForAvailable 上，把新序列堵在活动集合外。
  const lastReceiveCreditRef = useRef<Map<string, ReceiveCreditGate>>(new Map());
  // 当前持有一条发送序列的连接，用于判断「活动集合里的旧序列」是否真的还活着。
  const activeSendConnRef = useRef<Map<string, DataConnection>>(new Map());
  const peerReceiveCreditOwnerRef = useRef<Map<string, string>>(new Map());

  const peerProgress = useRef<Map<string, number>>(new Map());
  const peerRealtimeSpeed = useRef<Map<string, number>>(new Map());
  const peerAverageSpeed = useRef<Map<string, number>>(new Map());

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileListRef = useRef<File[]>([]);
  const lastConnectionStatsPollRef = useRef<number>(0);
  const peerDebugLevel = import.meta.env.DEV ? 1 : 0;
  const shareTelemetryRef = useRef<ConnectionSession | null>(null);
  const localDeviceNameRef = useRef<string>(deviceName);
  const peerNamesRef = useRef<Record<string, string>>(peerNames);
  const lastStatsPollIndexRef = useRef(0);
  const signalingOpenTimeoutRef = useRef<number | null>(null);
  const receiverSessionRegistryRef = useRef(createReceiverSessionRegistry());
  const routeCommitGateRef = useRef(createRouteCommitGate());
  const preservedSessionStateRef = useRef(new Map<string, ReturnType<typeof captureLogicalReceiverState>>());
  const routeSelectionDecisionRef = useRef<ReturnType<typeof getRouteSelectionDecision> | null>(null);
  const connectionIdsRef = useRef(new WeakMap<DataConnection, string>());
  const shareActivityTrackerRef = useRef(createSessionActivityTracker());

  const getOrCreateConnectionId = (conn: DataConnection): string => {
    const existing = connectionIdsRef.current.get(conn);
    if (existing) return existing;
    const created = `${conn.peer}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    connectionIdsRef.current.set(conn, created);
    return created;
  };

  const findConnectionById = (connectionId: string) =>
    Array.from(activeConnections.current).find(
      (candidate) => connectionIdsRef.current.get(candidate) === connectionId
    ) ?? null;

  const movePeerName = (fromPeerId: string, toPeerId: string) => {
    setPeerNames((prev) => {
      if (!prev[fromPeerId]) {
        return prev;
      }

      const next = { ...prev };
      if (!next[toPeerId]) {
        next[toPeerId] = prev[fromPeerId];
      }
      delete next[fromPeerId];
      return next;
    });
  };

  const rebindCommittedSessionState = (fromPeerId: string, toPeerId: string) => {
    if (fromPeerId === toPeerId) {
      return;
    }

    movePeerName(fromPeerId, toPeerId);

    const moveMapValue = <T,>(map: Map<string, T>) => {
      if (!map.has(fromPeerId)) {
        return;
      }
      map.set(toPeerId, map.get(fromPeerId)!);
      map.delete(fromPeerId);
    };

    moveMapValue(peerProgress.current);
    moveMapValue(peerRealtimeSpeed.current);
    moveMapValue(peerAverageSpeed.current);
    moveMapValue(peerTransferredBytesRef.current);
    moveMapValue(peerTotalBytesRef.current);
    moveMapValue(peerSyncStartAtRef.current);
    moveMapValue(peerSyncBaseBytesRef.current);
    moveMapValue(peerTransferEpochRef.current);
    moveMapValue(peerConnectionTypeRef.current);
    moveMapValue(peerIsLAN.current);

    const previousCredit = peerReceiveCreditRef.current.get(fromPeerId);
    if (previousCredit) {
      previousCredit.cancel('Connection replaced');
      peerReceiveCreditRef.current.delete(fromPeerId);
      peerReceiveCreditOwnerRef.current.delete(fromPeerId);
    }

    if (peerHasProgressSyncRef.current.delete(fromPeerId)) {
      peerHasProgressSyncRef.current.add(toPeerId);
    }
    if (peerAwaitingFinalizeAckRef.current.delete(fromPeerId)) {
      peerAwaitingFinalizeAckRef.current.add(toPeerId);
    }
  };

  const bindReceiverSessionToPeer = (
    receiverSessionId: string,
    peerId: string,
    previousPeerId?: string | null
  ) => {
    const boundPeerId = previousPeerId ?? sessionToPeerRef.current.get(receiverSessionId) ?? null;

    if (boundPeerId && boundPeerId !== peerId) {
      rebindCommittedSessionState(boundPeerId, peerId);
    }

    const preservedState = preservedSessionStateRef.current.get(receiverSessionId);
    if (preservedState) {
      restoreLogicalReceiverState(preservedState, peerId, {
        peerProgress: peerProgress.current,
        peerRealtimeSpeed: peerRealtimeSpeed.current,
        peerAverageSpeed: peerAverageSpeed.current,
        peerTransferredBytes: peerTransferredBytesRef.current,
        peerTotalBytes: peerTotalBytesRef.current,
        peerSyncStartAt: peerSyncStartAtRef.current,
        peerSyncBaseBytes: peerSyncBaseBytesRef.current,
        peerTransferEpoch: peerTransferEpochRef.current,
        peerConnectionType: peerConnectionTypeRef.current,
        peerIsLAN: peerIsLAN.current,
        peerNames: peerNamesRef.current,
        peerHasProgressSync: peerHasProgressSyncRef.current,
        peerAwaitingFinalizeAck: peerAwaitingFinalizeAckRef.current,
        pendingSendPeers: pendingSendPeersRef.current,
        activeSendingPeers: activeSendingPeersRef.current,
      });
      if (preservedState.peerName) {
        setPeerNames((prev) => ({ ...prev, [peerId]: preservedState.peerName! }));
      }
      preservedSessionStateRef.current.delete(receiverSessionId);
    }

    peerSessionIdsRef.current.set(peerId, receiverSessionId);
    sessionToPeerRef.current.set(receiverSessionId, peerId);
  };

  const getVisibleConnections = () =>
    Array.from(activeConnections.current).filter((conn) => {
      const receiverSessionId = peerSessionIdsRef.current.get(conn.peer);
      if (!receiverSessionId) {
        return true;
      }

      return sessionToPeerRef.current.get(receiverSessionId) === conn.peer;
    });

  const resetCommittedRouteState = () => {
    receiverSessionRegistryRef.current = createReceiverSessionRegistry();
    routeCommitGateRef.current = createRouteCommitGate();
    connectionIdsRef.current = new WeakMap<DataConnection, string>();
  };

  const totalProgressRef = useRef(0);
  useEffect(() => {
    totalProgressRef.current = totalProgress;
  }, [totalProgress]);

  useEffect(() => {
    localDeviceNameRef.current = deviceName;
  }, [deviceName]);

  useEffect(() => {
    peerNamesRef.current = peerNames;
  }, [peerNames]);

  useEffect(() => {
    let interval: number;
    if (state === TransferState.TRANSFERRING || state === TransferState.PEER_CONNECTED) {
        interval = window.setInterval(() => {
            let totalSpeed = 0;
            let totalAvgSpeed = 0;
            let combinedProgress = 0;

            const stats: PeerTransferStat[] = getVisibleConnections().map((conn) => {
                const peerId = conn.peer;
                const progress = peerProgress.current.get(peerId) || 0;
                const realtimeSpeed = peerRealtimeSpeed.current.get(peerId) || 0;
                const avg = peerAverageSpeed.current.get(peerId) || 0;
                const hasTransferStarted = peerProgress.current.has(peerId) || activeSendingPeersRef.current.has(peerId);
                const waitingFinalizeAck = peerAwaitingFinalizeAckRef.current.has(peerId);

                const status: PeerTransferStat['status'] =
                    progress >= 100 && !waitingFinalizeAck ? 'completed' : hasTransferStarted && state === TransferState.TRANSFERRING ? 'transferring' : 'waiting';

                if (status === 'transferring' || status === 'completed') {
                    combinedProgress += progress;
                    totalSpeed += realtimeSpeed;
                    totalAvgSpeed += avg;
                }

                return {
                    peerId,
                    speed: status === 'transferring' ? `${formatFileSize(realtimeSpeed)}/s` : status === 'completed' ? '完成' : '--',
                    progress,
                    deviceName: peerNamesRef.current[peerId] || `设备 ...${peerId.slice(-4)}`,
                    connectionType: peerConnectionTypeRef.current.get(peerId) || '检测中',
                    status
                };
            });

            stats.sort((a, b) => {
                const order = { transferring: 0, waiting: 1, completed: 2 };
                const statusDiff = order[a.status] - order[b.status];
                if (statusDiff !== 0) return statusDiff;
                return a.deviceName.localeCompare(b.deviceName);
            });

            setIndividualStats(stats);

            if (state === TransferState.TRANSFERRING) {
                setCurrentSpeed(formatFileSize(totalSpeed) + '/s');
                setAvgSpeed(formatFileSize(totalAvgSpeed) + '/s');
                setCurrentSpeedBytes(totalSpeed);
                setAvgSpeedBytes(totalAvgSpeed);
                const activeProgressCount = stats.filter((s) => s.status !== 'waiting').length;

                if (activeProgressCount > 0) {
                    setTotalProgress(Math.floor(combinedProgress / activeProgressCount));
                } else {
                    if (activeTransfersCount.current === 0 && totalProgressRef.current === 100) {
                        
                    } else {
                        setTotalProgress(0);
                    }
                }
            }

            const now = Date.now();
            if (
              activeConnections.current.size > 0 &&
              now - lastConnectionStatsPollRef.current >= 3000
            ) {
              lastConnectionStatsPollRef.current = now;
              // Stagger: poll one connection per tick instead of all at once.
              const conns = Array.from(activeConnections.current);
              if (conns.length > 0) {
                const idx = lastStatsPollIndexRef.current % conns.length;
                lastStatsPollIndexRef.current = idx + 1;
                updateConnectionStats(conns[idx]);
              }
            }
        }, 800);
    }
    return () => clearInterval(interval);
  }, [state]);

  const updatePeerName = (peerId: string, name: string) => {
    const cleaned = name.trim().slice(0, 24);
    const finalName = cleaned || `设备 ...${peerId.slice(-4)}`;
    setPeerNames(prev => {
      if (prev[peerId] === finalName) {
        return prev;
      }
      return { ...prev, [peerId]: finalName };
    });
  };

  const removePeerName = (peerId: string) => {
    setPeerNames(prev => {
      if (!prev[peerId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  const updateConnectionStatusUI = () => {
    const count = getVisibleConnections().length;
    if (count > 1) {
       setConnectionStatus(`已连接 ${count} 个设备`);
    } else if (count === 0) {
       setConnectionStatus('');
    }
  };

  const peerIsLAN = useRef<Map<string, boolean>>(new Map());
  const peerAdaptiveFlowRef = useRef<Map<string, AdaptiveFlowProfile>>(new Map());
  const peerRouteLogSignatureRef = useRef<Map<string, string>>(new Map());
  const committedRouteLogSignatureRef = useRef<Map<string, string>>(new Map());

  const updateAdaptiveFlow = (
    peerId: string,
    route: ConnectionRoute,
    metrics: ConnectionMetrics,
    maxMessageSize?: number | null,
  ) => {
    const next = deriveAdaptiveFlow(route, metrics, maxMessageSize);
    const prev = peerAdaptiveFlowRef.current.get(peerId);
    if (
      prev &&
      prev.chunkSize === next.chunkSize &&
      prev.highWaterMark === next.highWaterMark &&
      prev.lowWaterMark === next.lowWaterMark &&
      prev.metrics.rttMs === metrics.rttMs &&
      prev.metrics.lossPct === metrics.lossPct
    ) {
      return;
    }
    peerAdaptiveFlowRef.current.set(peerId, {
      ...next,
      lastUpdatedAt: Date.now(),
      metrics,
    });
  };

  const updateConnectionStats = async (conn: DataConnection, options?: { updateUi?: boolean }): Promise<ConnectionRoute> => {
      const shouldUpdateUi = options?.updateUi ?? true;
      if (!conn.peerConnection || conn.peerConnection.connectionState === 'closed') {
        return { isLan: false, isRelay: false, protocol: 'udp' };
      }

      let route: ConnectionRoute = { isLan: false, isRelay: false, protocol: 'udp' };

      try {
          const stats = await conn.peerConnection.getStats();
          let selectedPair: any = null;

          stats.forEach(report => {
              if (report.type === 'transport' && report.selectedCandidatePairId) {
                  selectedPair = stats.get(report.selectedCandidatePairId);
              }
          });

          if (!selectedPair) {
              stats.forEach(report => {
                  if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.selected) {
                      selectedPair = report;
                  }
              });
          }

          if (selectedPair) {
              const localCandidate = stats.get(selectedPair.localCandidateId);
              const remoteCandidate = stats.get(selectedPair.remoteCandidateId);
              const protocol = localCandidate?.protocol || 'udp';
              const localCandidateType = localCandidate?.candidateType || '';
              const remoteCandidateType = remoteCandidate?.candidateType || '';
              const rttMs = typeof selectedPair.currentRoundTripTime === 'number'
                ? Math.round(selectedPair.currentRoundTripTime * 1000)
                : null;
              const availableOutgoingBitrate = typeof selectedPair.availableOutgoingBitrate === 'number'
                ? selectedPair.availableOutgoingBitrate
                : null;
              const localIP = localCandidate?.address || localCandidate?.ip || '';
              const remoteIP = remoteCandidate?.address || remoteCandidate?.ip || '';
              const pathType = classifyCandidatePair({
                localAddress: localIP,
                remoteAddress: remoteIP,
                localCandidateType,
                remoteCandidateType,
              });
              const isRelayConnection = pathType === 'TURN';
              const isLanConnection = pathType === 'LAN';
              route = { isLan: isLanConnection, isRelay: isRelayConnection, protocol };
              updateAdaptiveFlow(
                conn.peer,
                route,
                { rttMs, lossPct: null, availableOutgoingBitrate },
                conn.peerConnection.sctp?.maxMessageSize,
              );

              const turnUrl = typeof localCandidate?.url === 'string' && localCandidate.url.startsWith('turn')
                ? localCandidate.url
                : typeof remoteCandidate?.url === 'string' && remoteCandidate.url.startsWith('turn')
                  ? remoteCandidate.url
                  : '';
              const relayProtocol = localCandidate?.relayProtocol || remoteCandidate?.relayProtocol || '';
              const routeSignature = [
                protocol,
                localCandidateType,
                remoteCandidateType,
                localIP,
                remoteIP,
                turnUrl,
                relayProtocol,
              ].join('|');
              if (peerRouteLogSignatureRef.current.get(conn.peer) !== routeSignature) {
                peerRouteLogSignatureRef.current.set(conn.peer, routeSignature);
                logDebug('info', '[ice-route:selected]', {
                  role: 'sender',
                  peerId: conn.peer,
                  protocol,
                  localCandidateType,
                  remoteCandidateType,
                  localIP,
                  remoteIP,
                  localNetworkType: localCandidate?.networkType || '',
                  remoteNetworkType: remoteCandidate?.networkType || '',
                  relayProtocol,
                  turnUrlType: turnUrl ? (turnUrl.startsWith('turns:') ? 'turns' : 'turn') : 'none',
                  turnUrl: turnUrl || undefined,
                  rttMs,
                  availableOutgoingBitrate,
                  pathHint: isLanConnection ? 'lan' : isRelayConnection ? 'relay' : 'p2p',
                });
              }

              peerIsLAN.current.set(conn.peer, isLanConnection);
              const networkType = isRelayConnection ? '中继（速度会变慢）' : isLanConnection ? '直连' : '点对点';
              peerConnectionTypeRef.current.set(conn.peer, networkType);

              if (shouldUpdateUi) {
                  if (activeConnections.current.size === 1) {
                    setConnectionStatus(`已连接 | ${protocol.toUpperCase()} | ${networkType}`);
                  } else {
                    setConnectionStatus(`已连接 ${activeConnections.current.size} 个设备`);
                  }
              }
          }
      } catch (e) {
          
      }

      return route;
  };

  const logCommittedRouteSelection = async (
    conn: DataConnection,
    receiverSessionId: string,
    selectedKind: 'all' | 'relay'
  ) => {
    const pc = conn.peerConnection;
    if (!pc) return;

    const route: IceRoute | null = await collectIceRouteWithRetry(pc);
    attachIceRouteToSession(shareTelemetryRef.current, route);

    const selectionReason =
      route?.pathType === 'LAN' &&
      route.localCandidateType !== 'relay' &&
      route.remoteCandidateType !== 'relay'
        ? 'lan_direct'
        : route && route.localCandidateType !== 'relay' && route.remoteCandidateType !== 'relay'
          ? 'p2p_direct'
          : 'relay_fallback';
    const turnUrl = route?.localUrl?.startsWith('turn')
      ? route.localUrl
      : route?.remoteUrl?.startsWith('turn')
        ? route.remoteUrl
        : '';
    const routeSignature = [
      receiverSessionId,
      selectedKind,
      route?.protocol || '',
      route?.localCandidateType || '',
      route?.remoteCandidateType || '',
      route?.localUrl || '',
      route?.remoteUrl || '',
      route?.relayProtocol || '',
      route?.pathType || '',
    ].join('|');

    if (committedRouteLogSignatureRef.current.get(receiverSessionId) === routeSignature) {
      return;
    }
    committedRouteLogSignatureRef.current.set(receiverSessionId, routeSignature);

    logDebug('info', '[route-selected]', {
      role: 'sender',
      receiverSessionId,
      peerId: conn.peer,
      selectedKind,
      protocol: route?.protocol,
      localCandidateType: route?.localCandidateType,
      remoteCandidateType: route?.remoteCandidateType,
      localNetworkType: route?.localNetworkType,
      remoteNetworkType: route?.remoteNetworkType,
      relayProtocol: route?.relayProtocol,
      turnUrlType: turnUrl ? (turnUrl.startsWith('turns:') ? 'turns' : 'turn') : 'none',
      turnUrl: turnUrl || undefined,
      pathType: route?.pathType,
      rttMs: route?.rttMs,
      selectionReason,
      routePolicyClass: routeSelectionDecisionRef.current?.policyClass,
      routePolicyReasons: routeSelectionDecisionRef.current?.reasons,
      routePolicyStartRelayDelayMs: routeSelectionDecisionRef.current?.startRelayDelayMs,
      routePolicyP2pGraceWindowMs: routeSelectionDecisionRef.current?.p2pGraceWindowMs,
    });
  };

  
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) {
        e.preventDefault();
        e.returnValue = ''; 
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [state]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopSharing();
    };
  }, []);

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (err) { logDebug('warn', 'Wake Lock request failed:', err); }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && state === TransferState.TRANSFERRING) {
        requestWakeLock();
      }
    };
    if (state === TransferState.TRANSFERRING) {
      requestWakeLock();
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    return () => {
      if (wakeLock) wakeLock.release().catch(() => {});
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [state]);

  useEffect(() => {
    if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) {
      if (metadata?.constraints?.expiresAt) {
        const updateTimer = () => {
          const now = Date.now();
          const end = metadata.constraints!.expiresAt!;
          const diff = end - now;
          if (diff <= 0) {
            setRemainingTime('已过期');
            stopSharing();
            setErrorMsg('分享时间已结束。');
            setState(TransferState.ERROR);
            if (timerRef.current) clearInterval(timerRef.current);
          } else {
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            setRemainingTime(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
          }
        };
        updateTimer();
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(updateTimer, 1000);
      } else {
        setRemainingTime('永久有效');
      }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state, metadata]);

  const decodeFileName = useCallback((name: string) => {
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    setFileList(files);
    fileListRef.current = files;
    setState(TransferState.CONFIGURING);

    let totalSize = 0;
    const filesInfo = [];
    for (const f of files) {
        totalSize += f.size;
        const name = f.fullPath || (f as any).webkitRelativePath || f.name;
        filesInfo.push({
            name: decodeFileName(name),
            size: f.size,
            type: f.type,
            lastModified: f.lastModified,
            fingerprint: generateFileFingerprint(f)
        });
    }
    setMetadata({ files: filesInfo, totalSize: totalSize });
  }, [decodeFileName]);

  const traverseFileTree = (item: FileSystemEntry, path: string = ""): Promise<File[]> => {
    return new Promise((resolve, reject) => {
      if (item.isFile) {
        (item as FileSystemFileEntry).file((file: File) => {
          try {
            const safeFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
            safeFile.fullPath = path + file.name;
            resolve([safeFile]);
          } catch (e) {
            file.fullPath = path + file.name;
            resolve([file]);
          }
        }, (err: any) => resolve([]));
      } else if (item.isDirectory) {
        const dirReader = (item as FileSystemDirectoryEntry).createReader();
        const entries: FileSystemEntry[] = [];
        const readEntries = () => {
          dirReader.readEntries(async (results: FileSystemEntry[]) => {
            if (results.length === 0) {
               try {
                  const subPromises = entries.map(entry => traverseFileTree(entry, path + item.name + "/"));
                  const filesArrays = await Promise.all(subPromises);
                  resolve(filesArrays.flat());
               } catch (err) { reject(err); }
            } else {
               entries.push(...results);
               readEntries();
            }
          }, (err: any) => reject(err));
        };
        readEntries();
      }
    });
  };

  const handleDragEvents = useCallback((e: DragEvent) => {
      e.preventDefault();
      if (e.type === 'dragover') setIsDragOver(true);
      if (e.type === 'dragleave' && e.clientX === 0 && e.clientY === 0) setIsDragOver(false);
      if (e.type === 'drop') {
          setIsDragOver(false);
          const dataTransfer = e.dataTransfer;
          if (!dataTransfer) return;

          // webkitGetAsEntry() entries are only readable during the synchronous
          // drop dispatch, so resolve every dropped item before any await.
          const entries: FileSystemEntry[] = [];
          for (const item of Array.from(dataTransfer.items || [])) {
              const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
              if (entry) entries.push(entry);
          }
          const droppedFiles = Array.from(dataTransfer.files || []);
          if (entries.length === 0 && droppedFiles.length === 0) return;

          void (async () => {
              try {
                  const files: File[] = [];
                  for (const entry of entries) {
                      files.push(...(await traverseFileTree(entry, "")));
                  }
                  // Browsers without webkitGetAsEntry only expose plain files.
                  if (files.length === 0) {
                      files.push(
                          ...droppedFiles.map((f) =>
                              new File([f], f.name, { type: f.type, lastModified: f.lastModified })
                          )
                      );
                  }
                  if (files.length === 0) {
                      onNotification("拖拽内容中没有可发送的文件", "info");
                      return;
                  }
                  await processFiles(files);
              } catch (err) {
                  console.error("Drop processing failed", err);
                  onNotification("拖拽内容解析失败", "error");
              }
          })();
      }
  }, [processFiles]);

  useEffect(() => {
    if (state !== TransferState.IDLE) return;
    window.addEventListener('dragover', handleDragEvents);
    window.addEventListener('dragleave', handleDragEvents);
    window.addEventListener('drop', handleDragEvents);
    return () => {
      window.removeEventListener('dragover', handleDragEvents);
      window.removeEventListener('dragleave', handleDragEvents);
      window.removeEventListener('drop', handleDragEvents);
    };
  }, [state, handleDragEvents]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const safeFiles = Array.from(files).map((f: any) => new File([f], f.name, { type: f.type, lastModified: f.lastModified }));
    e.target.value = '';
    processFiles(safeFiles);
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const safeFiles = Array.from(files).map((f: any) => {
        const safe = new File([f], f.name, { type: f.type, lastModified: f.lastModified });
        safe.fullPath = f.webkitRelativePath || f.name;
        return safe;
    });
    e.target.value = '';
    processFiles(safeFiles);
  };

  const startSharing = async () => {
    if (!fileList.length || !metadata) return;
    const shareActivityToken = shareActivityTrackerRef.current.begin();
    shareTelemetryRef.current = createConnectionSession('sender', {
      fileCount: fileList.length,
      totalSize: metadata.totalSize,
      customCode: isValidShareCode(customCodeInput),
    });
    startConnectionAttempt(shareTelemetryRef.current, 'create_share');
    isDestroyingRef.current = false;
    
    
    peerProgress.current.clear();
    peerRealtimeSpeed.current.clear();
    peerAverageSpeed.current.clear();
    peerHasProgressSyncRef.current.clear();
    peerTransferredBytesRef.current.clear();
    peerTotalBytesRef.current.clear();
    peerSyncStartAtRef.current.clear();
    peerSyncBaseBytesRef.current.clear();
      peerTransferEpochRef.current.clear();
      pendingSendPeersRef.current.clear();
      peerReceiveCreditRef.current.forEach((credit) => credit.cancel('Share restarted'));
      peerReceiveCreditRef.current.clear();
      peerReceiveCreditOwnerRef.current.clear();
      resetCommittedRouteState();
    setIndividualStats([]);

    setState(TransferState.GENERATING_CODE);
    setPreparingStage('fetching_ice');
    setConnectionStatus('');
    const expiryDuration = EXPIRY_DURATIONS[expiryOption as ExpiryOption];
    const expiresAt = expiryDuration === undefined ? undefined : Date.now() + expiryDuration;
    const metadataWithConstraints: FileMetadata = { ...metadata, protocolVersion: P2P_PROTOCOL_VERSION, constraints: { expiresAt } };
    setMetadata(metadataWithConstraints);
    const iceConfig = await getIceConfig();
    if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken) || isDestroyingRef.current || !isMountedRef.current) {
      return;
    }
    const networkProfile = getBrowserNetworkProfile();
    routeSelectionDecisionRef.current = getRouteSelectionDecision({
      isMobileDevice: networkProfile.isMobileDevice,
      isConstrained: networkProfile.isConstrained,
      relayRecommended: iceConfig.relayRecommended,
      fetchLatencyMs: iceConfig.fetchLatencyMs,
    });
    setPreparingStage('connecting_signaling');
    markIceConfigFetched(shareTelemetryRef.current);
    markSessionEvent(shareTelemetryRef.current, 'ice_strategy_selected', {
      initialPolicy: iceConfig.iceTransportPolicy,
      relayRecommended: iceConfig.relayRecommended,
      relayReason: iceConfig.relayReason,
      fetchLatencyMs: iceConfig.fetchLatencyMs,
      networkType: networkProfile.connectionType,
      effectiveType: networkProfile.effectiveType,
      isLikelyMobileNetwork: networkProfile.isLikelyMobileNetwork,
      isConstrained: networkProfile.isConstrained,
    });

    if (
      iceConfig.hasTurn &&
      (iceConfig.iceTransportPolicy === 'relay' || iceConfig.relayRecommended) &&
      onNotification
    ) {
      onNotification('检测到当前网络更适合优先使用中继连接，已自动优化建连策略。', 'info');
    } else if (!iceConfig.hasTurn && onNotification) {
      onNotification(NO_TURN_WARNING_MESSAGE, 'info');
    }

    const clearSignalingOpenTimeout = () => {
      if (signalingOpenTimeoutRef.current !== null) {
        window.clearTimeout(signalingOpenTimeoutRef.current);
        signalingOpenTimeoutRef.current = null;
      }
    };

    const createSharePeer = async (attempt: number) => {
      // 口令一律 6 位、由服务端登记并与随机 peerId 绑定；用户手填的 6 位码同样走登记流程
      // （已被占用会返回 taken，不会悄悄降级成别的码）。
      const requestedCode = isValidShareCode(customCodeInput) ? customCodeInput : undefined;
      // 信令建连超时后会重试：此时口令已经登记过，再调一次登记接口只会拿到 409
      // （或者把码改绑）。直接复用上一次的 peerId + secret。
      const previousRegistration = shareRegistrationRef.current;
      const reuseRegistration = Boolean(
        previousRegistration && (!requestedCode || previousRegistration.code === requestedCode),
      );

      // 口令有效期跟随用户选择（服务端上限 24h）；「永久」按上限登记并在分享期间自动续期。
      const shareTtlSeconds = Math.min(
        86_400,
        Math.max(60, Math.round((expiryDuration ?? 86_400_000) / 1000)),
      );

      let senderPeerId: string;
      let displayCode: string;
      let signalingToken: string;
      if (reuseRegistration && previousRegistration) {
        senderPeerId = previousRegistration.peerId;
        displayCode = previousRegistration.code;
        signalingToken = previousRegistration.secret;
      } else {
        senderPeerId = `peer-${crypto.randomUUID()}`;
        const registration = await requestShareCode({ peerId: senderPeerId, requestedCode, ttlSeconds: shareTtlSeconds });

        if (registration.status !== 'ok') {
          if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken)) return;
          const message = registration.status === 'taken'
            ? '该口令已被占用，请换一个 6 位口令'
            : registration.status === 'rate-limited'
              ? '创建口令过于频繁，请稍后再试'
              : '创建分享口令失败，请重试';
          setErrorMsg(message);
          setState(TransferState.ERROR);
          return;
        }

        displayCode = registration.code;
        signalingToken = registration.secret;
        shareRegistrationRef.current = {
          code: registration.code,
          peerId: senderPeerId,
          secret: registration.secret,
        };

        if (expiryOption === 'never') {
          if (shareRenewalTimerRef.current !== null) {
            window.clearInterval(shareRenewalTimerRef.current);
          }
          // 同 peerId + 同 secret 的重新登记只是延长过期时间，不会换码。
          shareRenewalTimerRef.current = window.setInterval(() => {
            if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken)) return;
            const current = shareRegistrationRef.current;
            if (!current) return;
            void requestShareCode({
              peerId: current.peerId,
              requestedCode: current.code,
              ttlSeconds: 86_400,
              secret: current.secret,
            }).catch(() => {});
          }, 30 * 60 * 1000);
        }
      }

      const signalingCode = displayCode;

      let customPeer: Peer;
      try {
        const { default: PeerRuntime } = await loadPeerRuntime();
        customPeer = new PeerRuntime(senderPeerId, {
          debug: peerDebugLevel,
          pingInterval: 5000,
          signalingCode,
          signalingToken,
          config: {
            iceServers: iceConfig.iceServers,
            iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
            iceTransportPolicy: iceConfig.iceTransportPolicy,
          }
        });
      } catch {
        if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken)) {
          return;
        }
        setErrorMsg('加载连接模块失败，请重试');
        setState(TransferState.ERROR);
        return;
      }

      if (
        !shareActivityTrackerRef.current.isCurrent(shareActivityToken) ||
        isDestroyingRef.current ||
        !isMountedRef.current
      ) {
        try { customPeer.destroy(); } catch {}
        return;
      }

      clearSignalingOpenTimeout();
      signalingOpenTimeoutRef.current = window.setTimeout(() => {
        if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken) || isDestroyingRef.current) return;
        if (peerRef.current !== customPeer) return;
        markSessionEvent(shareTelemetryRef.current, 'signaling_open_timeout', { attempt });
        try { customPeer.destroy(); } catch {}
        if (attempt < CONNECTION_TIMINGS.SENDER_MAX_SIGNALING_OPEN_RETRY) {
          setPreparingStage('connecting_signaling');
          void createSharePeer(attempt + 1);
          return;
        }
        setErrorMsg('准备传输节点超时，请重试');
        setState(TransferState.ERROR);
      }, CONNECTION_TIMINGS.SENDER_SIGNALING_OPEN_TIMEOUT_MS);

      customPeer.on('open', clearSignalingOpenTimeout);
      customPeer.on('error', clearSignalingOpenTimeout);
      setupPeerListeners(customPeer, displayCode, metadataWithConstraints, shareActivityToken);
    };

    void createSharePeer(0);
  };

  const cleanupConnectionState = (conn: DataConnection) => {
      const closingConnectionId = connectionIdsRef.current.get(conn);
      const hasReplacementConnection = Array.from(activeConnections.current).some(
        (candidate) => candidate !== conn && candidate.peer === conn.peer,
      );
      const creditOwnerId = peerReceiveCreditOwnerRef.current.get(conn.peer);
      if (!creditOwnerId || creditOwnerId === closingConnectionId) {
        peerReceiveCreditRef.current.get(conn.peer)?.cancel('Connection closed');
        peerReceiveCreditRef.current.delete(conn.peer);
        peerReceiveCreditOwnerRef.current.delete(conn.peer);
      }
      if (closingConnectionId) {
          receiverSessionRegistryRef.current.releaseConnection(closingConnectionId);
          routeCommitGateRef.current.releaseConnection(closingConnectionId);
          connectionIdsRef.current.delete(conn);
      }
      activeConnections.current.delete(conn);
      if (!shouldReleasePeerState(closingConnectionId, creditOwnerId, hasReplacementConnection)) {
          updateConnectionStatusUI();
          return;
      }
      const removedSessionId = peerSessionIdsRef.current.get(conn.peer);
      const stillBoundToClosingPeer =
        !!removedSessionId && sessionToPeerRef.current.get(removedSessionId) === conn.peer;
      if (stillBoundToClosingPeer && removedSessionId) {
          const preservedState = captureLogicalReceiverState(conn.peer, {
            peerProgress: peerProgress.current,
            peerRealtimeSpeed: peerRealtimeSpeed.current,
            peerAverageSpeed: peerAverageSpeed.current,
            peerTransferredBytes: peerTransferredBytesRef.current,
            peerTotalBytes: peerTotalBytesRef.current,
            peerSyncStartAt: peerSyncStartAtRef.current,
            peerSyncBaseBytes: peerSyncBaseBytesRef.current,
            peerTransferEpoch: peerTransferEpochRef.current,
            peerConnectionType: peerConnectionTypeRef.current,
            peerIsLAN: peerIsLAN.current,
            peerNames: peerNamesRef.current,
            peerHasProgressSync: peerHasProgressSyncRef.current,
            peerAwaitingFinalizeAck: peerAwaitingFinalizeAckRef.current,
            pendingSendPeers: pendingSendPeersRef.current,
            activeSendingPeers: activeSendingPeersRef.current,
          });
          if (preservedState) {
            preservedSessionStateRef.current.set(removedSessionId, preservedState);
          }
      }

      if (peerAwaitingFinalizeAckRef.current.delete(conn.peer)) {
          activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
      }
      peerProgress.current.delete(conn.peer);
      peerRealtimeSpeed.current.delete(conn.peer);
      peerAverageSpeed.current.delete(conn.peer);
      peerHasProgressSyncRef.current.delete(conn.peer);
      peerTransferredBytesRef.current.delete(conn.peer);
      peerTotalBytesRef.current.delete(conn.peer);
      peerSyncStartAtRef.current.delete(conn.peer);
      peerSyncBaseBytesRef.current.delete(conn.peer);
      peerTransferEpochRef.current.delete(conn.peer);
      pendingSendPeersRef.current.delete(conn.peer);
      activeSendingPeersRef.current.delete(conn.peer);
      ghostCandidateSinceRef.current.delete(conn.peer);
      peerConnectionTypeRef.current.delete(conn.peer);
      peerHeartbeatAtRef.current.delete(conn.peer);
      peerAdaptiveFlowRef.current.delete(conn.peer);
      peerRouteLogSignatureRef.current.delete(conn.peer);
      removePeerName(conn.peer);

      if (stillBoundToClosingPeer && removedSessionId) {
          sessionToPeerRef.current.delete(removedSessionId);
          committedRouteLogSignatureRef.current.delete(removedSessionId);
      }
      peerSessionIdsRef.current.delete(conn.peer);

      updateConnectionStatusUI();

      if (isDestroyingRef.current) return;
      if (activeSendingPeersRef.current.size === 0 && pendingSendPeersRef.current.size === 0) {
          if (activeConnections.current.size > 0) {
              setState(TransferState.PEER_CONNECTED);
              return;
          }

          setConnectionStatus('');
          setState(TransferState.WAITING_FOR_PEER);
      }
  };

  useEffect(() => {
      const sweep = () => {
          const now = Date.now();
          const conns = Array.from(activeConnections.current);

          conns.forEach((conn) => {
              const dataChannel = (conn as any).dataChannel as RTCDataChannel | undefined;
              const pc = conn.peerConnection;

              const dcState = dataChannel?.readyState;
              const pcState = pc?.connectionState;
              const closedByState =
                  !conn.open ||
                  dcState === 'closed' ||
                  pcState === 'closed' ||
                  pcState === 'failed';

              const unstableByState =
                  dcState === 'closing' ||
                  pcState === 'disconnected';

              if (closedByState) {
                  try { if (conn.open) conn.close(); } catch {}
                  cleanupConnectionState(conn);
                  return;
              }

              const transportHealthy =
                  pcState === 'connected' &&
                  (dcState === 'open' || conn.open);
              const lastHeartbeatAt = peerHeartbeatAtRef.current.get(conn.peer) ?? now;
              const heartbeatGapMs = now - lastHeartbeatAt;

              // Browsers heavily throttle timers in background tabs. When SCTP/DataChannel
              // is still healthy, trust WebRTC transport keepalive and avoid heartbeat-based kills.
              if (transportHealthy) {
                  peerHeartbeatAtRef.current.set(conn.peer, now);
              } else if (heartbeatGapMs >= CONNECTION_TIMINGS.SENDER_HARD_HEARTBEAT_TIMEOUT_MS) {
                  markSessionEvent(shareTelemetryRef.current, 'heartbeat_hard_timeout_kill', {
                    peer: conn.peer,
                    timeoutMs: heartbeatGapMs,
                    pcState: pcState ?? 'unknown',
                    dcState: dcState ?? 'unknown',
                  });
                  try { if (conn.open) conn.close(); } catch {}
                  cleanupConnectionState(conn);
                  return;
              } else if (heartbeatGapMs >= CONNECTION_TIMINGS.SENDER_HEARTBEAT_TIMEOUT_MS) {
                  markSessionEvent(shareTelemetryRef.current, 'heartbeat_stale_signal', {
                    peer: conn.peer,
                    timeoutMs: heartbeatGapMs,
                    pcState: pcState ?? 'unknown',
                    dcState: dcState ?? 'unknown',
                  });
              }

              if (unstableByState) {
                  const firstSeen = ghostCandidateSinceRef.current.get(conn.peer) ?? now;
                  ghostCandidateSinceRef.current.set(conn.peer, firstSeen);
                  if (now - firstSeen >= CONNECTION_TIMINGS.SENDER_GHOST_GRACE_MS) {
                      markSessionEvent(shareTelemetryRef.current, 'ghost_sweep_kill', {
                        peer: conn.peer,
                        pcState: pcState ?? 'unknown',
                        dcState: dcState ?? 'unknown',
                        graceDurationMs: now - firstSeen,
                      });
                      try { if (conn.open) conn.close(); } catch {}
                      cleanupConnectionState(conn);
                  }
                  return;
              }

              ghostCandidateSinceRef.current.delete(conn.peer);
          });
      };

      const timer = window.setInterval(sweep, CONNECTION_TIMINGS.SENDER_GHOST_SWEEP_INTERVAL_MS);
      return () => clearInterval(timer);
  }, []);

  const scheduleSendFileSequence = (conn: DataConnection, startFileIndex: number, startByteOffset: number) => {
      // Bump the per-peer epoch so any running sendFileSequence for this peer
      // will detect the change at its next check-point and exit gracefully.
      const nextEpoch = (peerTransferEpochRef.current.get(conn.peer) || 0) + 1;
      peerTransferEpochRef.current.set(conn.peer, nextEpoch);

      // Track as pending so cleanupConnectionState knows a transfer is
      // scheduled even before sendFileSequence starts executing.
      pendingSendPeersRef.current.add(conn.peer);
      setTimeout(() => {
          sendFileSequence(conn, startFileIndex, startByteOffset, nextEpoch);
      }, 100);
  };

  const getTotalFileBytes = () => fileListRef.current.reduce((total, file) => total + file.size, 0);

  const getResumeOffset = (fileIndex: number, byteOffset: number) => {
      const files = fileListRef.current;
      if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex > files.length) {
        throw new Error('Invalid resume fileIndex');
      }
      if (fileIndex === files.length) {
        if (byteOffset !== 0) {
          throw new Error('Completed transfer resume byteOffset must be zero');
        }
        return getTotalFileBytes();
      }
      if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset > files[fileIndex].size) {
        throw new Error('Invalid resume byteOffset');
      }
      return files.slice(0, fileIndex).reduce((total, file) => total + file.size, 0) + byteOffset;
  };

  const getPositionForOverallOffset = (overallOffset: number) => {
      const files = fileListRef.current;
      const totalBytes = getTotalFileBytes();
      if (!Number.isSafeInteger(overallOffset) || overallOffset < 0 || overallOffset > totalBytes) {
        throw new Error('Invalid persistedOverallBytes');
      }
      if (overallOffset === 0) {
        return { fileIndex: 0, byteOffset: 0 };
      }

      let remaining = overallOffset;
      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        if (remaining < files[fileIndex].size) {
          return { fileIndex, byteOffset: remaining };
        }
        remaining -= files[fileIndex].size;
      }
      return { fileIndex: files.length, byteOffset: 0 };
  };

  const initializeReceiveCredit = (
    conn: DataConnection,
    persistedOverallBytes: number,
    receiveWindowBytes: number,
  ) => {
      const peerId = conn.peer;
      const previous = peerReceiveCreditRef.current.get(peerId) ?? lastReceiveCreditRef.current.get(peerId);
      previous?.cancel('New transfer sequence started');
      const credit = new ReceiveCreditGate(
        getTotalFileBytes(),
        persistedOverallBytes,
        receiveWindowBytes,
      );
      peerReceiveCreditRef.current.set(peerId, credit);
      lastReceiveCreditRef.current.set(peerId, credit);
      peerReceiveCreditOwnerRef.current.set(peerId, getOrCreateConnectionId(conn));
      return credit;
  };

  const rejectInvalidFlowControl = (conn: DataConnection, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      peerReceiveCreditRef.current.get(conn.peer)?.cancel(error instanceof Error ? error : message);
      logDebug('warn', '[flow-control-invalid]', { peerId: conn.peer, reason: message });
      try { if (conn.open) conn.close(); } catch {}
  };

  const setupPeerListeners = (
    peer: Peer,
    code: string,
    sessionMetadata: FileMetadata,
    shareActivityToken: number
  ) => {
      peerRef.current = peer;
      peer.on('open', () => {
          if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken) || peerRef.current !== peer) {
              return;
          }
          markSignalingOpen(shareTelemetryRef.current);
          markConnectionSuccess(shareTelemetryRef.current, { code });
          setTransferCode(code);
          setPreparingStage('fetching_ice');
          setState(TransferState.WAITING_FOR_PEER);
      });
      peer.on('disconnected', () => {
          if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken) || peerRef.current !== peer) {
              return;
          }
          if (peer && !peer.destroyed) peer.reconnect();
      });
      peer.on('error', (err) => {
          if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken) || peerRef.current !== peer) {
              return;
          }
          if (err.type === 'unavailable-id') {
              markConnectionFailure(shareTelemetryRef.current, 'code_unavailable');
              setErrorMsg('该口令已被占用，请换一个。');
              setState(TransferState.CONFIGURING);
          } else {
              if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') { return; }
              if (!shouldSuppressNoisyPeerError({
                errorType: err?.type,
                transferState: state,
                activeConnections: activeConnections.current.size,
              })) {
                logDebug('error', 'Peer Error:', err);
              }
              markConnectionFailure(shareTelemetryRef.current, `peer_error:${err.type}`);
              if (activeConnections.current.size === 0) {
                 setErrorMsg(`连接错误: ${err.type}`);
                 setPreparingStage('fetching_ice');
                 setState(TransferState.ERROR);
              }
          }
      });
      peer.on('connection', (conn) => {
          if (!shareActivityTrackerRef.current.isCurrent(shareActivityToken) || peerRef.current !== peer) {
             try { conn.close(); } catch {}
             return;
          }
          if (sessionMetadata.constraints?.expiresAt && Date.now() > sessionMetadata.constraints.expiresAt) {
             conn.on('open', () => {
                 conn.send({ type: 'REJECT_TRANSFER', payload: { reason: '分享已过期' } });
                 setTimeout(() => conn.close(), 1000);
             });
             return;
          }
          
          conn.on('open', () => {
              markSessionEvent(shareTelemetryRef.current, 'receiver_connected', { peerId: conn.peer });
              activeConnections.current.add(conn);
              peerHeartbeatAtRef.current.set(conn.peer, Date.now());
              peerProgress.current.set(conn.peer, peerProgress.current.get(conn.peer) || 0);
              peerRealtimeSpeed.current.set(conn.peer, peerRealtimeSpeed.current.get(conn.peer) || 0);
              peerAverageSpeed.current.set(conn.peer, peerAverageSpeed.current.get(conn.peer) || 0);
              peerHasProgressSyncRef.current.delete(conn.peer);
              peerTransferredBytesRef.current.set(conn.peer, peerTransferredBytesRef.current.get(conn.peer) || 0);
              peerTotalBytesRef.current.set(conn.peer, peerTotalBytesRef.current.get(conn.peer) || (sessionMetadata.totalSize || 0));
              peerSyncStartAtRef.current.delete(conn.peer);
              peerSyncBaseBytesRef.current.delete(conn.peer);
              updateConnectionStatusUI();
              
              updateConnectionStats(conn);
              const pc = conn.peerConnection;
              if (pc) {
                collectIceRouteWithRetry(pc).then((route) => {
                  attachIceRouteToSession(shareTelemetryRef.current, route);
                });
              }

              setState((prevState) =>
                prevState === TransferState.TRANSFERRING ? prevState : TransferState.PEER_CONNECTED
              );
          });
          
          conn.on('data', (data: any) => {
              const incoming = data as P2PMessage;
              if (incoming.type === 'ROUTE_PROBE') {
                  logDebug('info', '[route-probe]', createRouteProbeLogPayload({
                    receiverSessionId: incoming.payload.receiverSessionId,
                    attemptId: incoming.payload.attemptId,
                    attemptKind: incoming.payload.attemptKind,
                    openedAt: Date.now(),
                    peerId: conn.peer,
                  }));
              }
              const routeHandshakeHandler = createSenderRouteHandshakeHandler({
                  registry: receiverSessionRegistryRef.current,
                  commitGate: routeCommitGateRef.current,
                  getConnectionId: getOrCreateConnectionId,
                  metadata: sessionMetadata,
                  deviceName: localDeviceNameRef.current,
                  onRouteCommitted: ({
                    conn: committedConn,
                    receiverSessionId,
                    selectedKind,
                    replacedConnectionId,
                  }) => {
                    const replacedConn = replacedConnectionId
                      ? findConnectionById(replacedConnectionId)
                      : null;

                    bindReceiverSessionToPeer(
                      receiverSessionId,
                      committedConn.peer,
                      replacedConn?.peer ?? null
                    );

                    if (replacedConn && replacedConn !== committedConn) {
                      try {
                        if (replacedConn.open) {
                          replacedConn.close();
                        }
                      } catch {}
                    }

                    void logCommittedRouteSelection(committedConn as DataConnection, receiverSessionId, selectedKind);
                  },
              });
              if (routeHandshakeHandler.handleMessage(conn, incoming)) {
                  return;
              }

              const msg = normalizeTransferMessage(incoming, TRANSFER_CONFIG.CHUNK_SIZE_WAN);
              const connectionId = connectionIdsRef.current.get(conn) ?? null;
              if (isCommittedTransferMessageType(msg.type)) {
                  const disposition = getCommittedTransferDisposition({
                    connectionId,
                    peerId: conn.peer,
                    peerSessionIds: peerSessionIdsRef.current,
                    commitGate: routeCommitGateRef.current,
                  });

                  if (disposition === 'reject') {
                    console.warn('[route-protocol-misuse]', {
                      role: 'sender',
                       peerId: conn.peer,
                       connectionId: connectionId || undefined,
                       receiverSessionId: peerSessionIdsRef.current.get(conn.peer) || undefined,
                       messageType: msg.type,
                       reason: 'non_committed_connection_sent_transfer_control',
                     });
                    try {
                      if (conn.open) {
                        conn.close();
                      }
                    } catch {}
                    return;
                  }
              }
              if (msg.type === 'DEVICE_INFO') {
                  const remoteName = typeof msg.payload?.deviceName === 'string' ? msg.payload.deviceName : '';
                  updatePeerName(conn.peer, remoteName);

                  const remoteSessionId = typeof msg.payload?.sessionId === 'string' ? msg.payload.sessionId : '';
                  if (remoteSessionId) {
                      const existingPeerId = sessionToPeerRef.current.get(remoteSessionId);
                      if (existingPeerId && existingPeerId !== conn.peer) {
                          const oldConn = Array.from(activeConnections.current).find(c => c.peer === existingPeerId);
                          if (oldConn) {
                              oldConn.close();
                          }
                      }
                      bindReceiverSessionToPeer(remoteSessionId, conn.peer, existingPeerId ?? null);
                  }
              } else if (msg.type === 'ACCEPT_TRANSFER') {
                  try {
                    initializeReceiveCredit(
                      conn,
                      msg.payload.persistedOverallBytes,
                      msg.payload.receiveWindowBytes,
                    );
                    const position = getPositionForOverallOffset(msg.payload.persistedOverallBytes);
                    setState(TransferState.TRANSFERRING);
                    scheduleSendFileSequence(conn, position.fileIndex, position.byteOffset);
                  } catch (error) {
                    rejectInvalidFlowControl(conn, error);
                  }
              } else if (msg.type === 'FILE_REQUEST') {
                  const payload = msg.payload;
                  try {
                    const persistedOverallBytes = getResumeOffset(payload.fileIndex, payload.byteOffset);
                    initializeReceiveCredit(conn, persistedOverallBytes, payload.receiveWindowBytes);
                  } catch (error) {
                    rejectInvalidFlowControl(conn, error);
                    return;
                  }
                  if (peerAwaitingFinalizeAckRef.current.delete(conn.peer)) {
                    activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
                  }
                  if (!payload.silent) {
                    onNotification(`检测到断点，正在从第 ${payload.fileIndex + 1} 个文件恢复...`, 'info');
                  }
                  setState(TransferState.TRANSFERRING);
                  scheduleSendFileSequence(conn, payload.fileIndex, payload.byteOffset);
              } else if (msg.type === 'TRANSFER_CANCELLED') {
                  const remoteName = peerNamesRef.current[conn.peer] || `设备 ${conn.peer.slice(0, 5)}...`;
                  onNotification(`${remoteName} 取消了下载`, 'info');
                  // Receiver explicitly cancelled; close immediately so sender UI exits "transferring" state without delay.
                  try {
                    if (conn.open) conn.close();
                  } catch {}
                  cleanupConnectionState(conn);
              } else if (msg.type === 'TRANSFER_PROGRESS') {
                  const payload = msg.payload;
                  const credit = peerReceiveCreditRef.current.get(conn.peer);
                  if (
                    !credit ||
                    peerReceiveCreditOwnerRef.current.get(conn.peer) !== getOrCreateConnectionId(conn)
                  ) {
                    rejectInvalidFlowControl(conn, new Error('TRANSFER_PROGRESS received before transfer initialization'));
                    return;
                  }
                  try {
                    credit.update(
                      payload.overallTransferredBytes,
                      payload.receiveWindowBytes,
                      payload.overallTotalBytes,
                    );
                  } catch (error) {
                    rejectInvalidFlowControl(conn, error);
                    return;
                  }
                  const totalBytes = payload.overallTotalBytes;
                  const safeTransferredBytes = payload.overallTransferredBytes;
                  const rawProgress = totalBytes > 0
                    ? Math.floor((safeTransferredBytes / totalBytes) * 100)
                    : 0;
                  const waitingFinalizeAck = peerAwaitingFinalizeAckRef.current.has(conn.peer);
                  const syncProgress = waitingFinalizeAck
                    ? Math.min(rawProgress, 99)
                    : Math.max(0, Math.min(100, rawProgress));
                  const speedBytes = Number.isFinite(payload.speedBytes) ? Math.max(0, payload.speedBytes) : 0;
                  const now = Date.now();
                  const hasSyncStarted = peerSyncStartAtRef.current.has(conn.peer);
                  if (!hasSyncStarted) {
                    peerSyncStartAtRef.current.set(conn.peer, now);
                    peerSyncBaseBytesRef.current.set(conn.peer, safeTransferredBytes);
                  }
                  const syncStartAt = peerSyncStartAtRef.current.get(conn.peer) || now;
                  const syncBaseBytes = peerSyncBaseBytesRef.current.get(conn.peer) || 0;
                  const elapsedSec = Math.max(0.001, (now - syncStartAt) / 1000);
                  const avgSpeedFromSync = Math.max(0, safeTransferredBytes - syncBaseBytes) / elapsedSec;

                  peerHasProgressSyncRef.current.add(conn.peer);
                  peerTransferredBytesRef.current.set(conn.peer, safeTransferredBytes);
                  peerTotalBytesRef.current.set(conn.peer, totalBytes);
                  peerProgress.current.set(conn.peer, syncProgress);
                  peerRealtimeSpeed.current.set(conn.peer, speedBytes);
                  peerAverageSpeed.current.set(conn.peer, avgSpeedFromSync);
              } else if (msg.type === 'ALL_FILES_RECEIVED') {
                  if (peerAwaitingFinalizeAckRef.current.delete(conn.peer)) {
                    activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
                  }
                  const finalTotalBytes = peerTotalBytesRef.current.get(conn.peer) || metadata?.totalSize || 0;
                  peerTransferredBytesRef.current.set(conn.peer, finalTotalBytes);
                  peerTotalBytesRef.current.set(conn.peer, finalTotalBytes);
                  peerProgress.current.set(conn.peer, 100);
                  peerRealtimeSpeed.current.set(conn.peer, 0);
                  if (activeTransfersCount.current === 0) {
                    setTotalProgress(100);
                    setCurrentFileIndex(0);
                    onNotification("文件发送完成！", 'success');
                  }
              } else if (msg.type === 'HEARTBEAT') {
                  peerHeartbeatAtRef.current.set(conn.peer, Date.now());
              }
          });
          
          conn.on('close', () => {
              cleanupConnectionState(conn);
          });
          
          conn.on('error', (err) => {
              if (!shouldSuppressNoisyPeerError({
                errorType: err?.type,
                transferState: state,
                activeConnections: activeConnections.current.size,
              })) {
                logDebug('warn', 'Connection error', err);
              }
          });
      });
  };

  const sendFileSequence = async (conn: DataConnection, startFileIndex: number = 0, startByteOffset: number = 0, peerEpoch: number = 0) => {
    const files = fileListRef.current;
    if (!files.length) return;

    // If a newer sequence was already scheduled for this peer, bail out.
    if (peerTransferEpochRef.current.get(conn.peer) !== peerEpoch) return;

    // Wait for any previous sequence to finish exiting (it will detect the
    // epoch bump and return soon).  Re-check our own epoch each iteration so
    // we also bail if yet another sequence is scheduled while we wait.
    let waitAttempts = 0;
    while (activeSendingPeersRef.current.has(conn.peer)) {
        await new Promise(r => setTimeout(r, 50));
        waitAttempts++;
        if (waitAttempts > 120) {
            // 旧序列卡在死连接的 await 上时不会自己退出。若它持有的连接已经不可用，
            // 直接接管：旧序列的 conn 已关闭，无法再写入，不会污染新的数据流。
            const staleConn = activeSendConnRef.current.get(conn.peer);
            if (!staleConn || !staleConn.open) {
                logDebug('warn', 'resume sequence released a stale send loop', { peerId: conn.peer });
                // 只释放活动集合，不要取消信用闸门：此刻地图里已经是本次新序列的闸门。
                activeSendingPeersRef.current.delete(conn.peer);
                activeSendConnRef.current.delete(conn.peer);
                break;
            }
            // Safety cap — clean up pending since this attempt failed.
            logDebug('warn', 'send sequence gave up waiting for a live previous loop', { peerId: conn.peer });
            pendingSendPeersRef.current.delete(conn.peer);
            return;
        }
        if (peerTransferEpochRef.current.get(conn.peer) !== peerEpoch) return;
        // ^ Newer epoch scheduled — that sequence owns the pending entry.
        if (!conn.open) {
            // Connection dead — clean up pending.
            pendingSendPeersRef.current.delete(conn.peer);
            return;
        }
    }

    // Transition from pending → active now that the previous sequence exited.
    pendingSendPeersRef.current.delete(conn.peer);
    activeSendingPeersRef.current.add(conn.peer);
    activeSendConnRef.current.set(conn.peer, conn);

    const currentSessionId = transferSessionId.current;
    activeTransfersCount.current += 1;

    // Start with WAN profile, then auto-adapt by live RTT/loss/bitrate stats.
    const defaultFlow: AdaptiveFlowProfile = {
      ...deriveAdaptiveFlow(
        { isLan: false, isRelay: false, protocol: 'udp' },
        { rttMs: null, lossPct: null, availableOutgoingBitrate: null },
        conn.peerConnection.sctp?.maxMessageSize,
      ),
      lastUpdatedAt: Date.now(),
      metrics: { rttMs: null, lossPct: null, availableOutgoingBitrate: null },
    };
    peerAdaptiveFlowRef.current.set(conn.peer, defaultFlow);
    const READ_BUFFER_SIZE = TRANSFER_CONFIG.READ_BUFFER_SIZE;
    updateConnectionStats(conn, { updateUi: false }).catch(() => {});

    let totalBytesSent = 0;
    let sendCompleted = false;
    let lastBufferedAmount = 0;
    let lastUpdateTime = Date.now();
    let bytesInLastPeriod = 0;
    const startTime = Date.now();

    const peerId = conn.peer;
    peerHasProgressSyncRef.current.delete(peerId);
    peerSyncStartAtRef.current.delete(peerId);
    peerSyncBaseBytesRef.current.delete(peerId);
    peerProgress.current.set(peerId, 0);
    peerTransferredBytesRef.current.set(peerId, 0);

    for(let i = 0; i < startFileIndex; i++) {
        totalBytesSent += files[i].size;
    }
    if (startByteOffset > 0) {
        totalBytesSent += startByteOffset;
    }

    const totalSize = getTotalFileBytes();

    const dataChannel = conn.dataChannel ?? undefined;
    const receiveCredit = peerReceiveCreditRef.current.get(peerId);
    const fileHasher = createCrc32Hasher(`sender-${peerId}`);
    const adaptiveTimer = window.setInterval(() => {
      if (transferSessionId.current !== currentSessionId || !conn.open) {
        window.clearInterval(adaptiveTimer);
        return;
      }
      updateConnectionStats(conn, { updateUi: false }).catch(() => {});
    }, 2000);

    try {
        if (!receiveCredit) {
          throw new Error('Receive credit was not initialized');
        }
        if (receiveCredit.snapshot().sentOverallBytes !== totalBytesSent) {
          throw new Error('Resume offset does not match initialized receive credit');
        }
        let fileStartByteOffset = startByteOffset;
        const isCurrentSequence = () => isSendSequenceCurrent(
          transferSessionId.current,
          currentSessionId,
          peerTransferEpochRef.current.get(peerId),
          peerEpoch,
          conn.open,
        );

        for (let i = startFileIndex; i < files.length; i++) {
            if (transferSessionId.current !== currentSessionId || peerTransferEpochRef.current.get(peerId) !== peerEpoch) return;
            if (!conn.open) throw new Error("Connection closed");

            if (activeConnections.current.size === 1) {
                setCurrentFileIndex(i);
            }

            const file = files[i];
            const fName = file.fullPath || (file as any).webkitRelativePath || file.name;

            let fileOffset = i === startFileIndex ? Math.min(Math.max(0, fileStartByteOffset), file.size) : 0;
            fileStartByteOffset = 0;

            // 续传时把已落盘前缀的 CRC 一起发过去，接收端才能验证磁盘上的旧数据没被截断。
            const startPayload: FileStartPayload = {
                fileIndex: i,
                fileName: decodeFileName(fName),
                fileSize: file.size,
                fileType: file.type
            };
            if (fileOffset > 0) {
                startPayload.resumeOffset = fileOffset;
                if (fileOffset <= DEFAULT_MAX_PREFIX_CRC_BYTES) {
                    startPayload.prefixCrc32 = await computePrefixCrc32(file, fileOffset);
                }
            }
            try {
                conn.send({ type: 'FILE_START', payload: startPayload });
            } catch(e) { throw new Error("Failed to send FILE_START"); }
            const hashStartOffset = fileOffset;
            await fileHasher.reset();
            if (!isCurrentSequence()) return;
            let hashedBytes = 0;
            const chunkReader = new StreamingFileChunkReader(file, READ_BUFFER_SIZE, fileOffset);

            while (fileOffset < file.size) {
                if (transferSessionId.current !== currentSessionId || peerTransferEpochRef.current.get(peerId) !== peerEpoch) return;
                if (!conn.open) throw new Error("Connection closed during transfer");

                const flow = peerAdaptiveFlowRef.current.get(peerId) || defaultFlow;
                const maxChunkSize = resolveDataChannelChunkSize(
                  flow.chunkSize,
                  conn.peerConnection.sctp?.maxMessageSize,
                );
                if (dataChannel) {
                    await waitForDataChannelDrain(conn, dataChannel, {
                        highWaterMark: flow.highWaterMark,
                        lowWaterMark: flow.lowWaterMark,
                    });
                    if (!isCurrentSequence()) return;
                }

                const availableCredit = await receiveCredit.waitForAvailable(
                  Math.min(maxChunkSize, file.size - fileOffset),
                );
                if (!isCurrentSequence()) return;
                const nextChunk = await chunkReader.readNextChunk(availableCredit);
                if (!isCurrentSequence()) return;
                const chunkView = nextChunk.chunk;
                if (!chunkView) {
                    break;
                }

                try {
                    if (!isCurrentSequence()) return;
                    conn.send(chunkView);
                } catch (e) {
                    if (!conn.open) throw new Error("Connection closed during send");
                    if (isDataChannelMessageTooLargeError(e)) {
                      throw new Error(
                        `Negotiated data-channel message limit rejected ${chunkView.byteLength} bytes`,
                        { cause: e },
                      );
                    }
                    throw e;
                }

                const currentChunkSize = chunkView.byteLength;
                receiveCredit.recordSent(currentChunkSize);
                fileHasher.update(chunkView);
                hashedBytes += currentChunkSize;
                totalBytesSent += currentChunkSize;
                bytesInLastPeriod += currentChunkSize;
                fileOffset = nextChunk.fileOffset + currentChunkSize;

                const now = Date.now();
                if (now - lastUpdateTime >= 500) {
                    const duration = (now - lastUpdateTime) / 1000;
                    const currentBuffered = dataChannel?.bufferedAmount || 0;

                    const actualBytesTransferred = bytesInLastPeriod - (currentBuffered - lastBufferedAmount);

                    if (duration > 0) {
                        const effectiveSpeed = Math.max(0, actualBytesTransferred) / duration;
                        const totalDuration = (now - startTime) / 1000;
                        const realTotal = Math.max(0, totalBytesSent - currentBuffered);

                        const hasProgressSync = peerHasProgressSyncRef.current.has(peerId);
                        if (!hasProgressSync) {
                            peerRealtimeSpeed.current.set(peerId, effectiveSpeed);
                            peerAverageSpeed.current.set(peerId, realTotal / totalDuration);
                            if (totalSize > 0) {
                                const p = Math.min(99, Math.floor((realTotal / totalSize) * 100));
                                peerProgress.current.set(peerId, p);
                            }
                            peerTotalBytesRef.current.set(peerId, totalSize);
                            peerTransferredBytesRef.current.set(peerId, Math.max(0, Math.min(totalSize, realTotal)));
                        }
                    }

                    lastUpdateTime = now;
                    lastBufferedAmount = currentBuffered;
                    bytesInLastPeriod = 0;
                }
            }

            const fileHash = await fileHasher.finalizeHex();
            if (!isCurrentSequence()) return;
            const completePayload: FileCompletePayload = {
                fileIndex: i,
                hashAlgorithm: 'crc32',
                fileHash,
                hashStartOffset,
                hashedBytes,
            };
            try { conn.send({ type: 'FILE_COMPLETE', payload: completePayload }); } catch(e) {}
        }

        try { conn.send({ type: 'ALL_FILES_COMPLETE' }); } catch(e) {}
        
        sendCompleted = true;
        peerAwaitingFinalizeAckRef.current.add(peerId);
        peerProgress.current.set(peerId, 99);
        peerRealtimeSpeed.current.set(peerId, 0);

    } catch (err) {
        if (
          transferSessionId.current === currentSessionId &&
          peerTransferEpochRef.current.get(peerId) === peerEpoch
        ) {
            console.warn(`Transfer to ${peerId} interrupted/failed:`, err);
            const remoteName = peerNamesRef.current[conn.peer] || `设备 ...${conn.peer.slice(-4)}`;
            onNotification(`${remoteName} 传输中断，等待重连后可继续`, 'error');

            if (conn.open) {
                conn.close();
            }
        }
    } finally {
        fileHasher.terminate();
        window.clearInterval(adaptiveTimer);
        // Always remove — the new sequence adds itself only after this
        // sequence has exited, so there is no ownership conflict.
        activeSendingPeersRef.current.delete(peerId);
        if (activeSendConnRef.current.get(peerId) === conn) {
            activeSendConnRef.current.delete(peerId);
        }
        if (transferSessionId.current === currentSessionId) {
            if (!sendCompleted) {
                activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
            }
        }
    }
  };

  const stopSharing = () => {
    if (shareRenewalTimerRef.current !== null) {
      window.clearInterval(shareRenewalTimerRef.current);
      shareRenewalTimerRef.current = null;
    }
    const registration = shareRegistrationRef.current;
    shareRegistrationRef.current = null;
    if (registration) {
      // 注销失败不影响本地停止分享（码会在 TTL 后自然过期）。
      void revokeShareSession(registration).catch(() => {});
    }
    isDestroyingRef.current = true;
    shareActivityTrackerRef.current.begin();
    if (signalingOpenTimeoutRef.current !== null) {
      window.clearTimeout(signalingOpenTimeoutRef.current);
      signalingOpenTimeoutRef.current = null;
    }
    transferSessionId.current += 1; 
    peerReceiveCreditRef.current.forEach((credit) => credit.cancel('Transfer cancelled'));
    peerReceiveCreditRef.current.clear();
    peerReceiveCreditOwnerRef.current.clear();
    
    activeConnections.current.forEach(conn => {
        if (conn.open) {
            try { conn.send({ type: 'TRANSFER_CANCELLED' }); } catch(e) { logDebug('warn', 'Failed to send transfer cancellation', e); }
            conn.close();
        }
    });
    activeConnections.current.clear();
    activeSendingPeersRef.current.clear();
    pendingSendPeersRef.current.clear();
    peerAwaitingFinalizeAckRef.current.clear();
    peerHasProgressSyncRef.current.clear();
    peerTransferredBytesRef.current.clear();
    peerTotalBytesRef.current.clear();
    peerSyncStartAtRef.current.clear();
    peerSyncBaseBytesRef.current.clear();
    peerTransferEpochRef.current.clear();
    peerSessionIdsRef.current.clear();
    sessionToPeerRef.current.clear();
    preservedSessionStateRef.current.clear();
    resetCommittedRouteState();
    ghostCandidateSinceRef.current.clear();
    peerConnectionTypeRef.current.clear();
    peerHeartbeatAtRef.current.clear();
    peerAdaptiveFlowRef.current.clear();
    committedRouteLogSignatureRef.current.clear();
    const peerToDestroy = peerRef.current;
    peerRef.current = null;

    setTimeout(() => {
        if (peerToDestroy && !peerToDestroy.destroyed) {
          peerToDestroy.destroy();
        }
    }, 100);
    
    activeTransfersCount.current = 0;
    
    peerProgress.current.clear();
    peerRealtimeSpeed.current.clear();
    peerAverageSpeed.current.clear();
    setIndividualStats([]);
    setPeerNames({});

    setConnectionStatus('');
    setPreparingStage('fetching_ice');
    setState(TransferState.IDLE);
    setFileList([]);
    setMetadata(null);
    setTransferCode('');
    setCustomCodeInput('');
    setTotalProgress(0);
    setCurrentSpeed('0 KB/s');
    setAvgSpeed('0 KB/s');
    setCurrentSpeedBytes(0);
    setAvgSpeedBytes(0);
    fileListRef.current = [];
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const handleCopyCode = async () => {
      if (!transferCode) return;
      try {
          await navigator.clipboard.writeText(transferCode);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          onNotification('口令已复制', 'success');
      } catch (err) {
          logDebug('warn', 'Clipboard write failed:', err);
          onNotification('复制失败，请手动复制', 'error');
      }
  };

  const shareLink = `${window.location.origin}${window.location.pathname}?code=${transferCode}`;
  const selectedFiles = useMemo(
    () =>
      (metadata?.files ?? []).map((file) => ({
        ...file,
        fileType: resolveFileType({
          fileName: file.name,
          mimeType: file.type,
        }),
      })),
    [metadata?.files]
  );

  const formatEta = (seconds: number): string => {
      if (!Number.isFinite(seconds) || seconds <= 0) return '--';
      if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
      if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
      return `${Math.ceil(seconds / 3600)} 小时`;
  };
  const perDeviceTotalBytes = metadata?.totalSize ?? 0;
  const activeTransferStats = individualStats.filter((s) => s.status !== 'waiting');
  const transferTargetCount = activeTransferStats.length;
  const totalBytes = activeTransferStats.reduce((acc, s) => {
    const peerTotal = peerTotalBytesRef.current.get(s.peerId);
    return acc + (typeof peerTotal === 'number' && peerTotal > 0 ? peerTotal : perDeviceTotalBytes);
  }, 0);
  const transferredBytes = activeTransferStats.reduce((acc, s) => {
    const peerTotal = peerTotalBytesRef.current.get(s.peerId);
    const fallbackTotal = typeof peerTotal === 'number' && peerTotal > 0 ? peerTotal : perDeviceTotalBytes;
    const peerDone = peerTransferredBytesRef.current.get(s.peerId);
    if (typeof peerDone === 'number') {
      return acc + Math.max(0, Math.min(fallbackTotal, peerDone));
    }
    return acc + Math.floor((Math.max(0, Math.min(100, s.progress)) / 100) * fallbackTotal);
  }, 0);
  const remainingBytes = Math.max(0, totalBytes - transferredBytes);
  const etaSpeedBytes = currentSpeedBytes > 0 ? currentSpeedBytes : avgSpeedBytes;
  const overallEta = etaSpeedBytes > 0 ? formatEta(remainingBytes / etaSpeedBytes) : '--';

  const handleCopyLink = async () => {
      try {
          await navigator.clipboard.writeText(shareLink);
          setLinkCopied(true);
          setTimeout(() => setLinkCopied(false), 2000);
          onNotification('链接已复制', 'success');
      } catch (err) {
          logDebug('warn', 'Clipboard write failed:', err);
          onNotification('复制失败，请手动复制', 'error');
      }
  };

  return (
    <SenderUI
      state={state}
      isDragOver={isDragOver}
      handleFileSelect={handleFileSelect}
      handleFolderSelect={handleFolderSelect}
      metadata={metadata}
      showFileList={showFileList}
      onToggleFileList={() => setShowFileList((prev) => !prev)}
      stopSharing={stopSharing}
      selectedFiles={selectedFiles}
      expiryOption={expiryOption}
      setExpiryOption={setExpiryOption}
      customCodeInput={customCodeInput}
      setCustomCodeInput={setCustomCodeInput}
      errorMsg={errorMsg}
      startSharing={startSharing}
      preparingStage={preparingStage}
      handleCopyCode={handleCopyCode}
      copied={copied}
      transferCode={transferCode}
      linkCopied={linkCopied}
      shareLink={shareLink}
      handleCopyLink={handleCopyLink}
      remainingTime={remainingTime}
      connectionStatus={connectionStatus}
      individualStats={individualStats}
      totalProgress={totalProgress}
      activeTransfersCount={activeTransfersCount.current}
      currentFileIndex={currentFileIndex}
      fileList={fileList}
      totalBytes={totalBytes}
      transferredBytes={transferredBytes}
      overallEta={overallEta}
      activeConnectionsCount={getVisibleConnections().length}
      currentSpeed={currentSpeed}
      avgSpeed={avgSpeed}
    />
  );
};






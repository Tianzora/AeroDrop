import React, { useState, useEffect, useRef } from 'react';

import streamSaver from 'streamsaver';
streamSaver.mitm = '/mitm.html';
import {
  TransferState,
  FileMetadata,
  P2PMessage,
  P2P_PROTOCOL_VERSION,
  type MetadataChunkPayload,
  type RouteAttemptKind,
} from '../types';
import { formatFileSize } from '../services/fileUtils';
import { createCrc32Hasher, Crc32Hasher } from '../services/crc32WorkerClient';
import { loadPeerRuntime, type Peer, type DataConnection } from '../services/peerRuntime';
import { createHappyEyeballsPlan } from '../services/connectionPolicy';
import {
  getReceiverDisconnectedMessage,
  getReceiverPreTransferFailureMessage,
  NO_TURN_WARNING_MESSAGE,
  RATE_LIMITED_CONNECTION_MESSAGE,
} from '../services/connectionGuidance';
import { getIceConfig } from '../services/stunService';
import { CONNECTION_TIMINGS, RECEIVE_STORAGE, TRANSFER_CONFIG } from '../constants/transfer';
import {
  attachIceRouteToSession,
  collectIceRouteWithRetry,
  ConnectionSession,
  createConnectionSession,
  markConnectionFailure,
  markConnectionRetry,
  markConnectionSuccess,
  markIceConfigFetched,
  markSignalingOpen,
  markSessionEvent,
  startConnectionAttempt,
} from '../services/connectionTelemetry';
import { getBrowserNetworkProfile } from '../services/networkProfile';
import { createReceivePersistenceAdapter, type ReceivePersistenceAdapter } from '../services/receive/persistenceAdapter';
import { createReceiveRecoveryCoordinator, type ReceiveRecoveryCoordinator } from '../services/receive/recoveryCoordinator';
import { createReceivePersistenceOrchestrator, type ReceivePersistenceOrchestrator } from '../services/receive/persistenceOrchestrator';
import { createReceiveRouteArbiter } from '../services/receive/routeArbiter';
import {
  getCommittedSessionReconnectDelayMs,
  shouldAutoReconnectCommittedSession,
  shouldReconnectStalledCommittedTransfer,
} from '../services/receive/committedReconnectPolicy';
import {
  shouldAutoResumeCommittedReconnect,
  shouldPreserveCommittedReconnectResumeIntent,
} from '../services/receive/committedReconnectResume';
import {
  getNonWinningRouteMessageDisposition,
  isRouteAttemptTransferControlMessage,
} from '../services/receive/routeAttemptMessagePolicy';
import { createRouteProbeLogPayload } from '../services/routeProbeLog';
import { createReceiveSessionCoordinator, type ReceiveSessionCoordinator } from '../services/receive/sessionCoordinator';
import {
  createReceiveStreamingWriter,
  type ReceiveStreamingTarget,
  type ReceiveStreamingWriter,
} from '../services/receive/streamingWriter';
import { createDirectorySaveSession } from '../services/receive/directorySaveSession';
import { createPersistedDirectoryHandleStore } from '../services/receive/persistedDirectoryHandle';
import { verifyPersistedPrefix } from '../services/receive/prefixIntegrity';
import { resolveDirectoryHandleForResume } from '../services/receive/resumeDirectoryHandle';
import {
  createResumeMetadataFingerprint,
  clearResumeCheckpoint,
  loadResumeCheckpoint,
  saveResumeCheckpoint,
  type ResumeCheckpoint,
} from '../services/receive/resumeCheckpoint';
import { restoreCompletedFilesForResume } from '../services/receive/completedFileRestore';
import { createReceivedFileManifest } from '../services/receive/receivedFileManifest';
import { createArchiveExportSession } from '../services/receive/archiveExportSession';
import {
  resolveMultiFileSaveMode,
  type ReceiveSaveMode,
} from '../services/receive/saveCapabilityResolver';
import { createSerialAsyncProcessor } from '../services/receive/serialAsyncProcessor';
import { isValidShareCode, lookupSharePeerId, normalizeShareCodeInput } from '../services/shareCodeSession';
import { createSessionDirectoryHandleCache } from '../services/receive/sessionDirectoryHandleCache';
import {
  getOrCreateReceiverRouteSessionId,
  rotateReceiverRouteSessionId,
} from '../services/receive/receiverRouteSessionId';
import { createSessionActivityTracker } from '../services/sessionActivityTracker';
import {
  getRouteSelectionDecision,
  getRouteSelectionTimings,
} from '../services/routeSelectionPolicy';
import { resolveFileType } from '../services/fileType';
import {
  shouldHandleReceiverActivity,
  shouldRunReceiverScheduledReconnect,
} from '../services/receiverActivityPolicy';
import { createTimeoutGroup } from '../services/timeoutGroup';
import { logDebug } from '../services/diagnostics';
import { ReceiverConnectingStage, ReceiverUI } from './receiver/ReceiverUI';

const sanitizeFileName = (name: string): string => {
  const basename = name.replace(/\\/g, '/').split('/').pop() || `file_${Date.now()}`;
  const cleaned = basename.replace(/[\x00-\x1f]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return `file_${Date.now()}`;
  }
  return cleaned;
};

const sanitizeRelativeReceivePath = (name: string): string => {
  const normalized = name.replace(/\\/g, '/');
  const parts = normalized
    .split('/')
    .map((part) => part.replace(/[\x00-\x1f]/g, '_').trim())
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');

  if (parts.length === 0) {
    return `file_${Date.now()}`;
  }

  return parts.join('/');
};

interface ReceiverProps {
  initialCode?: string;
  onNotification?: (msg: string, type: 'success' | 'info' | 'error') => void;
  deviceName: string;
}

type RouteAttemptRecord = {
  attemptId: string;
  attemptKind: RouteAttemptKind;
  conn: DataConnection;
};

// 分片 METADATA 的接收缓冲：按 transferId 分组、按 index 回填。
type MetadataChunkBuffer = {
  transferId: string;
  total: number;
  received: number;
  chunks: Map<number, string>;
};

export const Receiver: React.FC<ReceiverProps> = ({ initialCode, onNotification, deviceName }) => {
  const STREAMSAVER_PATH_PREFIX = '/__aerodrop_streamsaver__/';
  const {
    RECEIVER_INITIAL_CONNECT_MS: INITIAL_TIMEOUT_MS,
    RECEIVER_RELAY_CONNECT_MS: RELAY_TIMEOUT_MS,
    RECEIVER_FAST_RETRY_BASE_MS: FAST_RETRY_BASE_MS,
    RECEIVER_FAST_RETRY_MAX_MS: FAST_RETRY_MAX_MS,
    RECEIVER_MAX_CONNECT_RETRY: MAX_CONNECT_RETRY,
    RECEIVER_MAX_COMMITTED_RECONNECT_RETRY: MAX_COMMITTED_RECONNECT_RETRY,
    RECEIVER_MAX_AUTO_REPAIR_RETRIES_PER_FILE: MAX_AUTO_REPAIR_RETRIES_PER_FILE,
  } = CONNECTION_TIMINGS;
  const {
    IOS_MEMORY_WARN_BYTES,
    IOS_IDB_BUFFER_THRESHOLD_BYTES,
    IOS_IDB_STALE_SESSION_TTL_MS,
    IOS_IDB_PRUNE_LOCK_TTL_MS,
  } = RECEIVE_STORAGE;
  const IOS_IDB_DB_NAME = 'aerodrop-receiver-buffer-v1';
  const IOS_IDB_STORE = 'fileChunks';
  const IOS_IDB_PRUNE_LOCK_KEY = 'aerodrop_idb_prune_lock_v1';

  const RECEIVER_SESSION_KEY = 'aerodrop_receiver_session_id';
  const getReceiverSessionId = (): string => {
    try {
      return getOrCreateReceiverRouteSessionId({
        storageKey: RECEIVER_SESSION_KEY,
        read: (key) => sessionStorage.getItem(key),
        write: (key, value) => sessionStorage.setItem(key, value),
      });
    } catch {
      return `rcv-fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  };

  const rotateSessionId = () => {
    try {
      receiverSessionIdRef.current = rotateReceiverRouteSessionId({
        storageKey: RECEIVER_SESSION_KEY,
        write: (key, value) => sessionStorage.setItem(key, value),
      });
    } catch {
      receiverSessionIdRef.current = `rcv-fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  };

  const [state, _setState] = useState<TransferState>(TransferState.IDLE);
  const setState = (newState: TransferState) => {
    stateRef.current = newState;
    _setState(newState);
  };
  const [code, setCode] = useState<string>('');
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [canResume, setCanResume] = useState(false);
  
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0);
  const [totalFiles, setTotalFiles] = useState<number>(0);

  const [downloadSpeed, setDownloadSpeed] = useState<string>('0 KB/s');
  const [downloadSpeedBytes, setDownloadSpeedBytes] = useState(0);
  const [eta, setEta] = useState<string>('--');
  const [senderDeviceName, setSenderDeviceName] = useState<string>('');
  const [connectingStage, setConnectingStage] = useState<ReceiverConnectingStage>('');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [showFileList, setShowFileList] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const retryCountRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const committedReconnectTimerRef = useRef<number | null>(null);
  const stateRef = useRef<TransferState>(TransferState.IDLE);
  const peerDebugLevel = import.meta.env.DEV ? 1 : 0;
  const localDeviceNameRef = useRef<string>(deviceName);
  const receiverSessionIdRef = useRef<string>(getReceiverSessionId());
  const connectTelemetryRef = useRef<ConnectionSession | null>(null);
  const hasTurnRef = useRef(false);
  const preferredIcePolicyRef = useRef<RTCIceTransportPolicy>('all');
  const relayPeerRef = useRef<Peer | null>(null);
  const relayConnRef = useRef<DataConnection | null>(null);
  const happyEyeballsWonRef = useRef(false);
  const p2pTimeoutRetryCountRef = useRef(0);
  const allAttemptProgressedRef = useRef(false);
  const selectedRouteLogSignatureRef = useRef('');
  const routeAttemptCounterRef = useRef(0);
  const routeAttemptsRef = useRef<Map<string, RouteAttemptRecord>>(new Map());
  const intentionalConnectionCloseRef = useRef(new WeakSet<DataConnection>());
  const committedReconnectAttemptsRef = useRef(0);
  const pendingCommittedReconnectResumeRef = useRef(false);
  const forceRelayOnCommittedReconnectRef = useRef(false);
  const pendingRouteMessagesRef = useRef<Map<string, P2PMessage[]>>(new Map());
  const routeSelectionDecisionRef = useRef<ReturnType<typeof getRouteSelectionDecision> | null>(null);
  const latestRouteAttemptIdsRef = useRef<Record<RouteAttemptKind, string | null>>({
    all: null,
    relay: null,
  });
  const receiveRouteArbiterRef = useRef<ReturnType<typeof createReceiveRouteArbiter> | null>(null);
  const receiverActivityTrackerRef = useRef(createSessionActivityTracker());
  const backgroundTimeoutGroupRef = useRef(createTimeoutGroup());

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isMobileDevice = /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const metadataRef = useRef<FileMetadata | null>(null);
  const metadataChunkBufferRef = useRef<MetadataChunkBuffer | null>(null);
  const acceptingRef = useRef<boolean>(false);
  const currentFileIndexRef = useRef<number>(0); 
  const currentFileNameRef = useRef<string>('');
  const completedFileIndicesRef = useRef<Set<number>>(new Set());
  const isTransferActiveRef = useRef<boolean>(false);

  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedChunksCountRef = useRef<number>(0);
  const receivedSizeRef = useRef<number>(0);
  const currentFileSizeRef = useRef<number>(0);
  const fileHasherRef = useRef<Crc32Hasher | null>(null);
  const hashedBytesRef = useRef<number>(0);
  
  const isStreamingRef = useRef<boolean>(false);
  const nativeFileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const preparedNativeWriterFileIndexRef = useRef<number | null>(null);

  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const BUFFER_FLUSH_THRESHOLD = TRANSFER_CONFIG.WRITE_BUFFER_FLUSH_THRESHOLD;
  const isIndexedDbBufferingRef = useRef<boolean>(false);
  const indexedDbOpenPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const indexedDbBatchRef = useRef<ArrayBuffer[]>([]);
  const indexedDbBatchBytesRef = useRef<number>(0);
  const indexedDbChunkSeqRef = useRef<number>(0);
  const indexedDbBufferedBytesRef = useRef<number>(0);
  const indexedDbBufferedFileIndexRef = useRef<number | null>(null);
  const indexedDbNotifiedRef = useRef<boolean>(false);
  const indexedDbCleanupStartedRef = useRef<boolean>(false);
  const indexedDbCleanupLockIdRef = useRef<string>(
    `idb-prune-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );

  const lastSpeedUpdateRef = useRef<number>(0);
  const lastSpeedBytesRef = useRef<number>(0);
  const lastReportedSpeedBytesRef = useRef<number>(0);
  const lastProgressAckBytesRef = useRef<number>(0);
  const progressAckTimerRef = useRef<number | null>(null);
  const lastDurableProgressAtRef = useRef<number>(0);
  const lastDurableProgressBytesRef = useRef<number>(0);
  const stalledReconnectAttemptsRef = useRef<number>(0);
  const stallRecoveryBaselineBytesRef = useRef<number>(0);
  const receivePersistenceAdapterRef = useRef<ReceivePersistenceAdapter | null>(null);
  const receiveRecoveryCoordinatorRef = useRef<ReceiveRecoveryCoordinator | null>(null);
  const receivePersistenceOrchestratorRef = useRef<ReceivePersistenceOrchestrator | null>(null);
  const receiveSessionCoordinatorRef = useRef<ReceiveSessionCoordinator | null>(null);
  const receiveStreamingWriterRef = useRef<ReceiveStreamingWriter | null>(null);
  const directorySaveSessionRef = useRef(createDirectorySaveSession());
  const persistedDirectoryHandleRef = useRef(createPersistedDirectoryHandleStore());
  const resolvedSenderPeerIdRef = useRef<string>('');
  const metadataResumeFingerprintRef = useRef<string | null>(null);
  const resumeCheckpointRef = useRef<ResumeCheckpoint | null>(null);
  const lastCheckpointWriteRef = useRef<{ bytes: number; at: number }>({ bytes: 0, at: 0 });
  const receivedFileManifestRef = useRef(createReceivedFileManifest());
  const archiveExportSessionRef = useRef(createArchiveExportSession());
  const multiFileSaveModeRef = useRef<ReceiveSaveMode>('per-file-save-queue');
  const incomingDataProcessorRef = useRef(createSerialAsyncProcessor());
  const sessionDirectoryHandleCacheRef = useRef(createSessionDirectoryHandleCache());

  if (!receiveStreamingWriterRef.current) {
    receiveStreamingWriterRef.current = createReceiveStreamingWriter({
      flushThresholdBytes: BUFFER_FLUSH_THRESHOLD,
      maxPendingBytes: TRANSFER_CONFIG.MAX_PENDING_WRITE_BYTES,
    });
  }
  const receiveStreamingWriter = receiveStreamingWriterRef.current;

  const codeRef = useRef<string>('');
  const isMountedRef = useRef(true);
  useEffect(() => { codeRef.current = code; }, [code]);
  useEffect(() => { localDeviceNameRef.current = deviceName; }, [deviceName]);

  useEffect(() => { if (initialCode) setCode(initialCode); }, [initialCode]);

  const clearConnectionTimeout = () => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const clearProgressAckTimer = () => {
    if (progressAckTimerRef.current !== null) {
      clearTimeout(progressAckTimerRef.current);
      progressAckTimerRef.current = null;
    }
  };

  const clearCommittedReconnectTimer = () => {
    if (committedReconnectTimerRef.current !== null) {
      clearTimeout(committedReconnectTimerRef.current);
      committedReconnectTimerRef.current = null;
    }
  };

  const markIntentionalConnectionClose = (conn: DataConnection | null) => {
    if (!conn) return;
    intentionalConnectionCloseRef.current.add(conn);
  };

  const getNextRouteAttemptId = (attemptKind: RouteAttemptKind) => {
    routeAttemptCounterRef.current += 1;
    return `${attemptKind}-${Date.now().toString(36)}-${routeAttemptCounterRef.current.toString(36)}`;
  };

  const registerRouteAttempt = (record: RouteAttemptRecord) => {
    routeAttemptsRef.current.set(record.attemptId, record);
    pendingRouteMessagesRef.current.set(record.attemptId, []);
    latestRouteAttemptIdsRef.current = {
      ...latestRouteAttemptIdsRef.current,
      [record.attemptKind]: record.attemptId,
    };
  };

  const unregisterRouteAttempt = (attemptId: string) => {
    const existing = routeAttemptsRef.current.get(attemptId);
    if (!existing) {
      return;
    }

    routeAttemptsRef.current.delete(attemptId);

    if (latestRouteAttemptIdsRef.current[existing.attemptKind] === attemptId) {
      const latestForKind = Array.from(routeAttemptsRef.current.values())
        .reverse()
        .find((record) => record.attemptKind === existing.attemptKind)?.attemptId ?? null;

      latestRouteAttemptIdsRef.current = {
        ...latestRouteAttemptIdsRef.current,
        [existing.attemptKind]: latestForKind,
      };
    }

    if (relayConnRef.current === existing.conn) {
      relayConnRef.current = null;
    }

    pendingRouteMessagesRef.current.delete(attemptId);
  };

  const bufferRouteMessage = (attemptId: string, msg: P2PMessage) => {
    const existing = pendingRouteMessagesRef.current.get(attemptId) ?? [];
    pendingRouteMessagesRef.current.set(attemptId, [...existing, msg]);
  };

  const takePendingRouteMessages = (attemptId: string) => {
    const queued = pendingRouteMessagesRef.current.get(attemptId) ?? [];
    pendingRouteMessagesRef.current.delete(attemptId);
    return queued;
  };

  const closeRouteAttempt = (
    attemptId: string,
    reason: 'lost_race' | 'session_closed' | 'winner_selected'
  ) => {
    const existing = routeAttemptsRef.current.get(attemptId);
    if (!existing) {
      return;
    }

    if (existing.conn.open) {
      try {
        existing.conn.send({
          type: 'ROUTE_ABORT',
          payload: {
            receiverSessionId: receiverSessionIdRef.current,
            attemptId,
            reason,
          },
        });
      } catch {
        // Best-effort abort signal before closing the losing route.
      }
    }

    try {
      existing.conn.close();
    } catch {
      // Ignore close errors while tearing down non-winning attempts.
    }

    unregisterRouteAttempt(attemptId);
  };

  const closeNonWinningRouteAttempts = (winnerAttemptId: string) => {
    const losingAttemptIds = Array.from(routeAttemptsRef.current.keys()).filter(
      (attemptId) => attemptId !== winnerAttemptId
    );

    for (const losingAttemptId of losingAttemptIds) {
      closeRouteAttempt(losingAttemptId, 'winner_selected');
    }
  };

  const resetRouteAttemptState = () => {
    const activeAttemptIds = Array.from(routeAttemptsRef.current.keys());
    for (const attemptId of activeAttemptIds) {
      closeRouteAttempt(attemptId, 'session_closed');
    }
    routeAttemptsRef.current.clear();
    pendingRouteMessagesRef.current.clear();
    latestRouteAttemptIdsRef.current = {
      all: null,
      relay: null,
    };
    selectedRouteLogSignatureRef.current = '';
    receiveRouteArbiterRef.current = null;
  };

  const startWinnerHeartbeat = (conn: DataConnection) => {
    clearHeartbeatTimer();
    heartbeatTimerRef.current = window.setInterval(() => {
      if (!conn.open) return;
      try {
        conn.send({ type: 'HEARTBEAT', payload: { t: Date.now() } });
      } catch {
        // Ignore heartbeat failures; close/error path handles reconnect.
      }
    }, 2500);
  };

  const collectSelectedRoute = (conn: DataConnection) => {
    const pc = conn.peerConnection;
    if (!pc) {
      return;
    }

    collectIceRouteWithRetry(pc).then((route) => {
      attachIceRouteToSession(connectTelemetryRef.current, route);
      if (!route) return;
      const selectedKind = preferredIcePolicyRef.current === 'relay' ? 'relay' : 'all';
      const selectionReason =
        route.pathType === 'LAN' &&
        route.localCandidateType !== 'relay' &&
        route.remoteCandidateType !== 'relay'
          ? 'lan_direct'
          : route.localCandidateType !== 'relay' && route.remoteCandidateType !== 'relay'
            ? 'p2p_direct'
            : 'relay_fallback';
      const routeSignature = [
        receiverSessionIdRef.current,
        selectedKind,
        route.protocol || '',
        route.localCandidateType || '',
        route.remoteCandidateType || '',
        route.localUrl || '',
        route.remoteUrl || '',
        route.relayProtocol || '',
        route.pathType || '',
      ].join('|');
      if (selectedRouteLogSignatureRef.current !== routeSignature) {
        selectedRouteLogSignatureRef.current = routeSignature;
        const turnUrl = route.localUrl?.startsWith('turn')
          ? route.localUrl
          : route.remoteUrl?.startsWith('turn')
            ? route.remoteUrl
            : '';
        logDebug('info', '[route-selected]', {
          role: 'receiver',
          receiverSessionId: receiverSessionIdRef.current,
          selectedKind,
          peerId: conn.peer,
          protocol: route.protocol,
          localCandidateType: route.localCandidateType,
          remoteCandidateType: route.remoteCandidateType,
          localNetworkType: route.localNetworkType,
          remoteNetworkType: route.remoteNetworkType,
          relayProtocol: route.relayProtocol,
          turnUrlType: turnUrl ? (turnUrl.startsWith('turns:') ? 'turns' : 'turn') : 'none',
          turnUrl: turnUrl || undefined,
          pathType: route.pathType,
          rttMs: route.rttMs,
          selectionReason,
          routePolicyClass: routeSelectionDecisionRef.current?.policyClass,
          routePolicyReasons: routeSelectionDecisionRef.current?.reasons,
          routePolicyStartRelayDelayMs: routeSelectionDecisionRef.current?.startRelayDelayMs,
          routePolicyP2pGraceWindowMs: routeSelectionDecisionRef.current?.p2pGraceWindowMs,
        });
      }
    });
  };

  const handleConnectRef = useRef<(options?: {
    preserveCommittedReconnectAttempts?: boolean;
    forceRelay?: boolean;
  }) => void>(() => {});
  useEffect(() => {
    handleConnectRef.current = handleConnect;
  });

  useEffect(() => {
    if (state !== TransferState.IDLE) return;
    if (isValidShareCode(code)) {
      handleConnectRef.current();
    }
  }, [code, state]);


  useEffect(() => {
    isMountedRef.current = true;
    pruneStaleIndexedDbSessions().catch(() => {});
    return () => {
      isMountedRef.current = false;
      clearConnectionTimeout();
      clearHeartbeatTimer();
      clearProgressAckTimer();
      clearCommittedReconnectTimer();
      backgroundTimeoutGroupRef.current.clearAll();
      resetRouteAttemptState();
      if (connRef.current) {
        markIntentionalConnectionClose(connRef.current);
        connRef.current.close();
      }
      if (peerRef.current) peerRef.current.destroy();
      if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} }
      // 卸载（切 tab / 刷新）不等于取消：保留本会话的 IndexedDB 分块以便续传，陈旧数据交给 24h prune。
      abortStreams();
      fileHasherRef.current?.terminate();
      fileHasherRef.current = null;
    };
  }, []);

  const getFileHasher = (): Crc32Hasher => {
    if (!fileHasherRef.current) {
      fileHasherRef.current = createCrc32Hasher('receiver');
    }
    return fileHasherRef.current;
  };

  const isIndexedDbSupported = () => typeof window !== 'undefined' && 'indexedDB' in window;

  const resetIndexedDbBufferRuntime = () => {
    indexedDbBatchRef.current = [];
    indexedDbBatchBytesRef.current = 0;
  };

  const resetIndexedDbFileState = () => {
    isIndexedDbBufferingRef.current = false;
    indexedDbChunkSeqRef.current = 0;
    indexedDbBufferedBytesRef.current = 0;
    indexedDbBufferedFileIndexRef.current = null;
    resetIndexedDbBufferRuntime();
  };

  const openIndexedDb = async (): Promise<IDBDatabase> => {
    if (!isIndexedDbSupported()) {
      throw new Error('INDEXED_DB_UNSUPPORTED');
    }
    if (!indexedDbOpenPromiseRef.current) {
      indexedDbOpenPromiseRef.current = new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(IOS_IDB_DB_NAME, 1);
        request.onerror = () => reject(request.error || new Error('INDEXED_DB_OPEN_FAILED'));
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(IOS_IDB_STORE)) {
            const store = db.createObjectStore(IOS_IDB_STORE, { keyPath: ['sessionId', 'fileIndex', 'seq'] });
            store.createIndex('bySessionFile', ['sessionId', 'fileIndex'], { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
      });
    }
    return indexedDbOpenPromiseRef.current;
  };

  const acquireIndexedDbPruneLock = (): boolean => {
    try {
      const now = Date.now();
      const owner = indexedDbCleanupLockIdRef.current;
      const currentRaw = window.localStorage.getItem(IOS_IDB_PRUNE_LOCK_KEY);
      if (currentRaw) {
        const current = JSON.parse(currentRaw) as { owner?: string; expiresAt?: number };
        const currentOwner = typeof current?.owner === 'string' ? current.owner : '';
        const expiresAt = typeof current?.expiresAt === 'number' ? current.expiresAt : 0;
        if (currentOwner && currentOwner !== owner && expiresAt > now) {
          return false;
        }
      }

      const next = { owner, expiresAt: now + IOS_IDB_PRUNE_LOCK_TTL_MS };
      window.localStorage.setItem(IOS_IDB_PRUNE_LOCK_KEY, JSON.stringify(next));
      const confirmRaw = window.localStorage.getItem(IOS_IDB_PRUNE_LOCK_KEY);
      if (!confirmRaw) return false;
      const confirm = JSON.parse(confirmRaw) as { owner?: string };
      return confirm.owner === owner;
    } catch {
      // If localStorage is unavailable (privacy mode), fall back to single-tab guard.
      return true;
    }
  };

  const releaseIndexedDbPruneLock = () => {
    try {
      const owner = indexedDbCleanupLockIdRef.current;
      const currentRaw = window.localStorage.getItem(IOS_IDB_PRUNE_LOCK_KEY);
      if (!currentRaw) return;
      const current = JSON.parse(currentRaw) as { owner?: string };
      if (current?.owner === owner) {
        window.localStorage.removeItem(IOS_IDB_PRUNE_LOCK_KEY);
      }
    } catch {
      // Ignore lock release errors.
    }
  };

  const pruneStaleIndexedDbSessions = async (): Promise<void> => {
    if (!isIndexedDbSupported()) return;
    if (indexedDbCleanupStartedRef.current) return;
    if (!acquireIndexedDbPruneLock()) return;
    indexedDbCleanupStartedRef.current = true;

    try {
      const db = await openIndexedDb();
      const currentSessionId = receiverSessionIdRef.current;
      const cutoff = Date.now() - IOS_IDB_STALE_SESSION_TTL_MS;
      const sessionLastSeen = new Map<string, number>();

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IOS_IDB_STORE, 'readonly');
        const store = tx.objectStore(IOS_IDB_STORE);
        const req = store.openCursor();
        req.onerror = () => reject(req.error || new Error('INDEXED_DB_PRUNE_SCAN_FAILED'));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const record = cursor.value as { sessionId?: string; createdAt?: number } | null;
          const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
          if (sessionId) {
            const createdAt = typeof record?.createdAt === 'number' && Number.isFinite(record.createdAt)
              ? record.createdAt
              : 0;
            const prev = sessionLastSeen.get(sessionId) || 0;
            if (createdAt > prev) {
              sessionLastSeen.set(sessionId, createdAt);
            }
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_SCAN_TX_FAILED'));
        tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_SCAN_TX_ABORTED'));
      });

      const staleSessions = Array.from(sessionLastSeen.entries())
        .filter(([sessionId, lastSeen]) => sessionId !== currentSessionId && lastSeen < cutoff)
        .map(([sessionId]) => sessionId);

      if (staleSessions.length === 0) return;
      const staleSet = new Set(staleSessions);

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
        const store = tx.objectStore(IOS_IDB_STORE);
        const req = store.openCursor();
        req.onerror = () => reject(req.error || new Error('INDEXED_DB_PRUNE_DELETE_FAILED'));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const record = cursor.value as { sessionId?: string } | null;
          const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
          if (sessionId && staleSet.has(sessionId)) {
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_DELETE_TX_FAILED'));
        tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_DELETE_TX_ABORTED'));
      });
    } catch (err) {
      logDebug('warn', 'IndexedDB stale session cleanup failed:', err);
    } finally {
      releaseIndexedDbPruneLock();
    }
  };

  const deleteIndexedDbChunksForFile = async (fileIndex: number): Promise<void> => {
    if (!isIndexedDbSupported()) return;
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(IOS_IDB_STORE);
      const index = store.index('bySessionFile');
      const req = index.openCursor(IDBKeyRange.only([sessionId, fileIndex]));
      req.onerror = () => reject(req.error || new Error('INDEXED_DB_CURSOR_FAILED'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_DELETE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_DELETE_ABORTED'));
    });
  };

  const deleteIndexedDbChunksForSession = async (sessionId = receiverSessionIdRef.current): Promise<void> => {
    if (!isIndexedDbSupported()) return;
    const db = await openIndexedDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(IOS_IDB_STORE);
      const index = store.index('bySessionFile');
      const req = index.openCursor(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
      req.onerror = () => reject(req.error || new Error('INDEXED_DB_SESSION_CURSOR_FAILED'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_SESSION_DELETE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_SESSION_DELETE_ABORTED'));
    });
  };

  const appendIndexedDbChunkBlob = async (fileIndex: number, blob: Blob, size: number): Promise<void> => {
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    const seq = indexedDbChunkSeqRef.current++;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(IOS_IDB_STORE);
      store.put({
        sessionId,
        fileIndex,
        seq,
        blob,
        size,
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_APPEND_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_APPEND_ABORTED'));
    });
    indexedDbBufferedBytesRef.current += size;
  };

  const readIndexedDbBlobsForFile = async (fileIndex: number): Promise<Blob[]> => {
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    return new Promise<Blob[]>((resolve, reject) => {
      const blobs: Blob[] = [];
      const tx = db.transaction(IOS_IDB_STORE, 'readonly');
      const store = tx.objectStore(IOS_IDB_STORE);
      const range = IDBKeyRange.bound([sessionId, fileIndex, 0], [sessionId, fileIndex, Number.MAX_SAFE_INTEGER]);
      const req = store.openCursor(range);
      req.onerror = () => reject(req.error || new Error('INDEXED_DB_READ_CURSOR_FAILED'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const record = cursor.value as { blob?: Blob };
        if (record?.blob) blobs.push(record.blob);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(blobs);
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_READ_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_READ_ABORTED'));
    });
  };

  const flushIndexedDbBatch = async (fileIndex: number, batch: ArrayBuffer[], totalLen: number) => {
    try {
      const blob = new Blob(batch, { type: 'application/octet-stream' });
      await appendIndexedDbChunkBlob(fileIndex, blob, totalLen);
      indexedDbBufferedFileIndexRef.current = fileIndex;
    } catch (err) {
      console.error('IndexedDB write error:', err);
      failTransferPersistence('iOS 大文件缓冲写入失败，请释放存储空间后重试。');
    }
  };

  useEffect(() => {
    const notifyClosing = () => {
      const conn = connRef.current;
      if (!conn || !conn.open) return;
      try {
        conn.send({ type: 'TRANSFER_CANCELLED' });
      } catch {
        // Ignore; sender side heartbeat timeout will clean up.
      }
    };

    window.addEventListener('pagehide', notifyClosing);
    window.addEventListener('beforeunload', notifyClosing);
    return () => {
      window.removeEventListener('pagehide', notifyClosing);
      window.removeEventListener('beforeunload', notifyClosing);
    };
  }, []);

  const createNativeStreamingTarget = (
    handle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream
  ): ReceiveStreamingTarget => ({
    kind: 'native-fs',
    write: async (chunk) => {
      await writable.write(chunk);
    },
    close: async () => {
      await writable.close();
    },
    truncate: async (size) => {
      await writable.truncate(size);
    },
    verifyCommittedBytes: async (expectedBytes) => {
      const file = await handle.getFile();
      return file.size === expectedBytes;
    },
  });

  const createStreamSaverTarget = (
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): ReceiveStreamingTarget => ({
    kind: 'stream-saver',
    write: async (chunk) => {
      await writer.write(chunk);
    },
    close: async () => {
      await writer.close();
    },
    abort: async () => {
      await writer.abort();
    },
  });

  const handleStreamingWriteFailure = async (error: unknown) => {
    if (stateRef.current === TransferState.ERROR) {
      return;
    }

    console.error('Write Error:', error);
    const closeOk = await receiveStreamingWriter.closeCurrentTarget({
      abortStreamSaver: true,
      preserveCommittedBytes: true,
    });

    if (!closeOk) {
      logDebug('warn', 'Streaming target close after write failure was not clean; preserving partial file state.');
    }

    isStreamingRef.current = receiveStreamingWriter.isStreaming();
    failTransferPersistence("写入文件失败，磁盘可能已满或权限不足。");
  };

  const abortStreams = async () => {
      const ok = await receiveStreamingWriter.closeCurrentTarget({
        abortStreamSaver: true,
        preserveCommittedBytes: true,
      });
      if (!ok) {
        logDebug('warn', 'Stream abort warning: failed to close active target cleanly');
      }
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      resetIndexedDbBufferRuntime();
  };

  const closeStreams = async (options?: {
      truncateNativeBeforeClose?: boolean;
      abortStreamSaver?: boolean;
  }): Promise<boolean> => {
      const ok = await receiveStreamingWriter.closeCurrentTarget({
        truncateNativeBeforeClose: options?.truncateNativeBeforeClose === true,
        abortStreamSaver: options?.abortStreamSaver === true,
        preserveCommittedBytes: false,
      });
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      return ok;
  };

  const flushPendingStreamWrites = async (): Promise<boolean> => {
      if (!receiveStreamingWriter.isStreaming()) {
          await receiveStreamingWriter.awaitIdle();
          return true;
      }

      try {
        await receiveStreamingWriter.flushPending();
        await receiveStreamingWriter.awaitIdle();
        return stateRef.current !== TransferState.ERROR;
      } catch (error) {
        await handleStreamingWriteFailure(error);
        return false;
      }
  };

  const markCurrentFilePersisted = (fileName: string) => {
      completedFileIndicesRef.current.add(currentFileIndexRef.current);
      receiveRecoveryCoordinatorRef.current?.clearRepairStateForFile(currentFileIndexRef.current);
      sendTransferProgress(lastReportedSpeedBytesRef.current);
      if (multiFileSaveModeRef.current === 'directory-direct') {
        receivedFileManifestRef.current.markSavedDirect(currentFileIndexRef.current, {
          rootDirectoryName: directorySaveSessionRef.current.getRootDirectoryName(),
          resolvedPath: fileName,
          committedBytes: currentFileSizeRef.current,
        });
      }
      if (onNotification) {
          const message =
            multiFileSaveModeRef.current === 'archive-export'
              ? `文件 ${fileName} 已接收，等待打包导出`
              : `文件 ${fileName} 已保存`;
          onNotification(message, 'success');
      }
  };

  const enqueueWrite = (task: () => Promise<void>): Promise<void> => {
      writeQueueRef.current = writeQueueRef.current.then(task);
      return writeQueueRef.current;
  };

  const resetIndexedDbPersistedFileState = () => {
      indexedDbBufferedBytesRef.current = 0;
      indexedDbChunkSeqRef.current = 0;
      indexedDbBufferedFileIndexRef.current = null;
      resetIndexedDbBufferRuntime();
  };

  const resetMemoryFileState = () => {
      chunksRef.current = [];
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
  };

  const resetFileBuffersForRepair = (fileIndex: number) => {
      chunksRef.current = [];
      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      resetIndexedDbBufferRuntime();
      indexedDbChunkSeqRef.current = 0;
      indexedDbBufferedBytesRef.current = 0;
      indexedDbBufferedFileIndexRef.current = fileIndex;
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
  };

  const resetHasherForRepair = async (): Promise<boolean> => {
      try {
        await getFileHasher().reset();
        hashedBytesRef.current = 0;
        return true;
      } catch {
        return false;
      }
  };

  const reopenNativeWriterForResume = async (targetFileIndex: number, byteOffset: number): Promise<boolean> => {
    // 续传后本次会话的接收计数从「已落盘偏移」继续，否则进度快照会回退到 0，
    // 被单调钳制冻结在断点值，发送端的信用窗口永远等不到新进度。
    receivedSizeRef.current = Math.max(receivedSizeRef.current, byteOffset);
    const reopenStreamingTarget = async (
      factory: (resumeOffset: number) => Promise<ReceiveStreamingTarget>
    ): Promise<boolean> => {
      try {
        const reopened = await receiveStreamingWriter.reopenForResume(factory, byteOffset);
        isStreamingRef.current = receiveStreamingWriter.isStreaming();
        preparedNativeWriterFileIndexRef.current = reopened ? targetFileIndex : null;
        return reopened;
      } catch (error) {
        logDebug('warn', 'Failed to reopen writer for resume:', error);
        receiveStreamingWriter.reset();
        isStreamingRef.current = false;
        return false;
      }
    };

    if (multiFileSaveModeRef.current === 'directory-direct') {
      const relativePath =
        currentFileIndexRef.current === targetFileIndex
          ? currentFileNameRef.current
          : sanitizeRelativeReceivePath(
              metadataRef.current?.files?.[targetFileIndex]?.name || `file_${Date.now()}`
            );
      if (!relativePath) return false;

      return reopenStreamingTarget((resumeOffset) =>
        directorySaveSessionRef.current.createStreamingTarget(relativePath, {
          keepExistingData: true,
          startOffset: resumeOffset,
        })
      );
    }

    const handle = nativeFileHandleRef.current;
    if (!handle) return false;
    const meta = metadataRef.current;
    if (!meta || meta.files.length !== 1 || targetFileIndex !== 0) return false;

    return reopenStreamingTarget(async (resumeOffset) => {
        const writable = await handle.createWritable({ keepExistingData: true });
        await writable.seek(resumeOffset);
        return createNativeStreamingTarget(handle, writable);
      });
  };

  const hasRetainedCurrentFileData = (fileIndex: number): boolean => {
    const hasIndexedDbBufferedData =
      indexedDbBufferedFileIndexRef.current === fileIndex &&
      (indexedDbBufferedBytesRef.current > 0 || indexedDbBatchBytesRef.current > 0);
    const hasStreamingTarget =
      currentFileIndexRef.current === fileIndex &&
      receivedSizeRef.current > 0 &&
      receiveStreamingWriter.hasRetainedData();

    return (
      currentFileIndexRef.current === fileIndex &&
      (
        chunksRef.current.length > 0 ||
        hasIndexedDbBufferedData ||
        hasStreamingTarget
      )
    );
  };

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
    };
    const handleVisibilityChange = () => { if (document.visibilityState === 'visible' && state === TransferState.TRANSFERRING) requestWakeLock(); };
    if (state === TransferState.TRANSFERRING) { requestWakeLock(); document.addEventListener('visibilitychange', handleVisibilityChange); }
    return () => { if (wakeLock) wakeLock.release().catch(() => {}); document.removeEventListener('visibilitychange', handleVisibilityChange); };
  }, [state]);

  useEffect(() => {
    let interval: number;
    if (state === TransferState.TRANSFERRING) {
        interval = window.setInterval(() => {
            if (!currentFileSizeRef.current) return;
            const now = Date.now();
            const received = receivedSizeRef.current;
            const total = currentFileSizeRef.current;
            const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
            setProgress(pct);
            
            const timeDiff = now - lastSpeedUpdateRef.current;
            let latestSpeedBytes = lastReportedSpeedBytesRef.current;
            if (timeDiff >= 1000) {
                const bytesDiff = received - lastSpeedBytesRef.current;
                const speed = (bytesDiff / timeDiff) * 1000;
                const safeSpeed = Math.max(0, speed);
                latestSpeedBytes = safeSpeed;
                setDownloadSpeed(formatFileSize(safeSpeed) + '/s');
                setDownloadSpeedBytes(safeSpeed);
                if (safeSpeed > 0 && total > received) {
                    const remainingBytes = total - received;
                    const seconds = remainingBytes / safeSpeed;
                    if (seconds > 60) setEta(`${Math.ceil(seconds / 60)} 分钟`); else setEta(`${Math.ceil(seconds)} 秒`);
                } else if (received >= total) { setEta('完成'); } else { setEta('--'); }
                lastSpeedUpdateRef.current = now;
                lastSpeedBytesRef.current = received;
                lastReportedSpeedBytesRef.current = safeSpeed;
            }
            sendTransferProgress(latestSpeedBytes);
        }, 1000);
    }
    return () => clearInterval(interval);
  }, [state]);

  const getOverallTransferSnapshot = () => {
    const meta = metadataRef.current;
    if (!meta) {
      return { overallTransferredBytes: 0, overallTotalBytes: 0 };
    }
    const files = meta.files || [];
    const overallTotalBytes = Math.max(0, meta.totalSize || files.reduce((acc, file) => acc + file.size, 0));
    const completedBytes = files.reduce((acc, file, idx) => {
      return acc + (completedFileIndicesRef.current.has(idx) ? file.size : 0);
    }, 0);
    const currentIndex = currentFileIndexRef.current;
    const currentFileBytes = (
      currentIndex >= 0 &&
      currentIndex < files.length &&
      !completedFileIndicesRef.current.has(currentIndex)
    )
      ? Math.min(
          receiveStreamingWriter.isStreaming()
            ? receiveStreamingWriter.getCommittedBytes()
            : isIndexedDbBufferingRef.current
              ? indexedDbBufferedBytesRef.current
              : receivedSizeRef.current,
          files[currentIndex].size
        )
      : 0;
    const overallTransferredBytes = Math.min(overallTotalBytes, completedBytes + currentFileBytes);
    return { overallTransferredBytes, overallTotalBytes };
  };

  // 检查点：刷新/崩溃后靠它恢复「第几个文件、已落盘多少字节」。写入节流 ≥1 MiB 或 2 s。
  const maybeSaveResumeCheckpoint = () => {
    const meta = metadataRef.current;
    const fingerprint = metadataResumeFingerprintRef.current;
    if (!meta || !fingerprint) return;
    const fileIndex = currentFileIndexRef.current;
    const file = meta.files?.[fileIndex];
    if (!file || completedFileIndicesRef.current.has(fileIndex)) return;
    // 只有「刷新后还能重新打开成文件前缀」的字节才配写进检查点：
    // 内存 blob / StreamSaver 模式在刷新后就没了；IndexedDB 缓冲虽然数据还在，
    // 但刷新后既恢复不了 chunk 序号也重开不了写入器，续传同样会停住。
    const recoverable = receiveStreamingWriter.isStreaming();
    if (!recoverable) {
      if (lastCheckpointWriteRef.current.bytes !== 0) {
        lastCheckpointWriteRef.current = { bytes: 0, at: 0 };
        clearResumeCheckpoint(receiverSessionIdRef.current);
      }
      return;
    }
    const committedBytes = receiveStreamingWriter.isStreaming()
      ? receiveStreamingWriter.getCommittedBytes()
      : indexedDbBufferedBytesRef.current;
    if (committedBytes <= 0) return;
    const previous = lastCheckpointWriteRef.current;
    if (committedBytes - previous.bytes < 1024 * 1024 && Date.now() - previous.at < 2000) return;
    lastCheckpointWriteRef.current = { bytes: committedBytes, at: Date.now() };
    saveResumeCheckpoint({
      sessionId: receiverSessionIdRef.current,
      metadataFingerprint: fingerprint,
      fileIndex,
      committedBytes,
      totalSize: file.size,
    });
  };

  const sendTransferProgress = (speedBytes: number) => {
    maybeSaveResumeCheckpoint();
    const conn = connRef.current;
    if (!conn || !conn.open) return;
    const snapshot = getOverallTransferSnapshot();
    // 续传 / 自动修复会让快照回退；对发送端只上报高水位，避免进度倒退。
    const overallTransferredBytes = Math.max(
      lastProgressAckBytesRef.current,
      snapshot.overallTransferredBytes
    );
    const overallTotalBytes = snapshot.overallTotalBytes;
    if (overallTransferredBytes > lastDurableProgressBytesRef.current) {
      lastDurableProgressBytesRef.current = overallTransferredBytes;
      lastDurableProgressAtRef.current = Date.now();
      if (
        stalledReconnectAttemptsRef.current > 0 &&
        overallTransferredBytes - stallRecoveryBaselineBytesRef.current >= TRANSFER_CONFIG.WRITE_BATCH_BYTES
      ) {
        stalledReconnectAttemptsRef.current = 0;
        stallRecoveryBaselineBytesRef.current = overallTransferredBytes;
      }
    }
    clearProgressAckTimer();
    try {
      conn.send({
        type: 'TRANSFER_PROGRESS',
        payload: {
          overallTransferredBytes,
          overallTotalBytes,
          speedBytes: Math.max(0, speedBytes),
          receiveWindowBytes: TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES,
        }
      });
      lastProgressAckBytesRef.current = overallTransferredBytes;
    } catch {
      // Ignore transient progress sync failures; next tick will retry.
    }
  };

  const scheduleCommittedProgress = () => {
    const { overallTransferredBytes } = getOverallTransferSnapshot();
    if (overallTransferredBytes <= lastProgressAckBytesRef.current) return;
    if (
      overallTransferredBytes - lastProgressAckBytesRef.current >=
      TRANSFER_CONFIG.WRITE_BATCH_BYTES
    ) {
      sendTransferProgress(lastReportedSpeedBytesRef.current);
      return;
    }
    if (progressAckTimerRef.current !== null) return;
    progressAckTimerRef.current = window.setTimeout(() => {
      progressAckTimerRef.current = null;
      sendTransferProgress(lastReportedSpeedBytesRef.current);
    }, 50);
  };

  useEffect(() => {
    if (state !== TransferState.TRANSFERRING) return;

    const { overallTransferredBytes } = getOverallTransferSnapshot();
    if (overallTransferredBytes > lastDurableProgressBytesRef.current) {
      lastDurableProgressBytesRef.current = overallTransferredBytes;
    }
    lastDurableProgressAtRef.current = Date.now();

    const resetVisibleProgressBaseline = () => {
      if (document.visibilityState === 'visible') {
        lastDurableProgressAtRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', resetVisibleProgressBaseline);

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        lastDurableProgressAtRef.current = Date.now();
        return;
      }

      const conn = connRef.current;
      const now = Date.now();
      if (!shouldReconnectStalledCommittedTransfer({
        currentState: stateRef.current,
        transferActive: isTransferActiveRef.current,
        connectionOpen: conn?.open === true,
        lastProgressAtMs: lastDurableProgressAtRef.current,
        nowMs: now,
        timeoutMs: TRANSFER_CONFIG.PROGRESS_STALL_TIMEOUT_MS,
      })) {
        return;
      }

      window.clearInterval(timer);
      const stalledForMs = now - lastDurableProgressAtRef.current;
      if (stalledReconnectAttemptsRef.current >= TRANSFER_CONFIG.MAX_STALL_RECONNECTS) {
        const message = '连接持续无落盘进度，已停止自动重连。请切换网络后继续传输。';
        markSessionEvent(connectTelemetryRef.current, 'transfer_stall_retry_exhausted', {
          stalledForMs,
          persistedOverallBytes: lastDurableProgressBytesRef.current,
        });
        isTransferActiveRef.current = false;
        pendingCommittedReconnectResumeRef.current = false;
        forceRelayOnCommittedReconnectRef.current = false;
        setErrorMsg(message);
        setState(TransferState.ERROR);
        markIntentionalConnectionClose(conn);
        try { conn?.close(); } catch {}
        if (onNotification) onNotification(message, 'error');
        return;
      }

      if (stalledReconnectAttemptsRef.current === 0) {
        stallRecoveryBaselineBytesRef.current = lastDurableProgressBytesRef.current;
      }
      stalledReconnectAttemptsRef.current += 1;
      pendingCommittedReconnectResumeRef.current = true;
      forceRelayOnCommittedReconnectRef.current = true;
      markSessionEvent(connectTelemetryRef.current, 'transfer_stall_reconnect', {
        attempt: stalledReconnectAttemptsRef.current,
        stalledForMs,
        persistedOverallBytes: lastDurableProgressBytesRef.current,
      });
      if (onNotification) {
        onNotification('检测到传输无进度，正在从已保存位置重连...', 'info');
      }
      try { conn?.close(); } catch {}
    }, TRANSFER_CONFIG.PROGRESS_STALL_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resetVisibleProgressBaseline);
    };
  }, [state]);

  const flushSpecificBatch = async (batch: Uint8Array[], totalLen: number) => {
      void batch;
      void totalLen;
  };

  const failTransferPersistence = (message: string) => {
      isTransferActiveRef.current = false;
      clearProgressAckTimer();
      receiveRecoveryCoordinatorRef.current?.reset();
      setErrorMsg(message);
      setState(TransferState.ERROR);
      abortStreams().catch(() => {});
      if (connRef.current?.open) {
        markIntentionalConnectionClose(connRef.current);
        try { connRef.current.send({ type: 'TRANSFER_CANCELLED', payload: { reason: message } }); } catch {}
        try { connRef.current.close(); } catch {}
      }
  };

  const applyMetadataPayload = (meta: FileMetadata, conn: DataConnection) => {
      if (!meta || !Array.isArray(meta.files)) {
        setErrorMsg('收到的文件元数据无效，请重试。');
        setState(TransferState.ERROR);
        return;
      }
      const remoteProtocolVersion = typeof meta.protocolVersion === 'number' ? meta.protocolVersion : 1;
      if (remoteProtocolVersion !== P2P_PROTOCOL_VERSION) {
          setErrorMsg(`发送方协议版本(${remoteProtocolVersion})与当前版本(${P2P_PROTOCOL_VERSION})不兼容，请升级两端后重试。`);
          setState(TransferState.ERROR);
          conn.close();
          return;
      }
      const previousMeta = metadataRef.current;
      let isResumable = false;
      if (previousMeta &&
          previousMeta.totalSize === meta.totalSize &&
          previousMeta.files.length === meta.files.length) {
          isResumable = meta.files.every((file, idx) => {
              const prev = previousMeta.files[idx];
              if (file.fingerprint && prev.fingerprint) {
                  return file.fingerprint === prev.fingerprint;
              }
              return file.name === prev.name && file.size === prev.size;
          });
      } else {
          resetStateForNewTransfer();
      }

      setMetadata(meta);
      metadataRef.current = meta;
      try {
        receivedFileManifestRef.current.seedFromMetadata(meta.files || []);
      } catch (error) {
        // 文件路径不合法（.. / 绝对路径 / 控制字符）说明发送端不可信，不能静默停在已连接态。
        logDebug('warn', 'rejected invalid metadata paths:', error);
        setErrorMsg('收到的文件元数据无效（文件名或路径不合法），请让对方重新发起传输。');
        setState(TransferState.ERROR);
        conn.close();
        return;
      }
      multiFileSaveModeRef.current = resolveMultiFileSaveMode({
        fileCount: meta.files?.length ?? 0,
        isIOS,
        isSafari,
        supportsDirectoryPicker: typeof window.showDirectoryPicker === 'function',
        supportsArchiveExport: (meta.files?.length ?? 0) > 1,
      }).mode;
      setTotalFiles(meta.files?.length || 0);
      setState(TransferState.PEER_CONNECTED);
      setReconnectAttempt(0);
      // 刷新/重连后内存里的 previousMeta 可能已经丢了，用本地检查点把「可续传」补回来。
      const fingerprint = createResumeMetadataFingerprint(meta.files ?? []);
      metadataResumeFingerprintRef.current = fingerprint;
      const checkpoint = loadResumeCheckpoint({
        sessionId: receiverSessionIdRef.current,
        metadataFingerprint: fingerprint,
      });
      resumeCheckpointRef.current = checkpoint;
      lastCheckpointWriteRef.current = { bytes: 0, at: 0 };
      setCanResume(isResumable || checkpoint !== null);
      committedReconnectAttemptsRef.current = 0;
      isTransferActiveRef.current = false;

      const shouldAutoResume = shouldAutoResumeCommittedReconnect({
        pendingReconnectResume: pendingCommittedReconnectResumeRef.current,
        isResumable,
      });
      pendingCommittedReconnectResumeRef.current = false;

      if (isResumable && onNotification) onNotification("发现上次未完成的传输", 'info');
      if ((isIOS || isSafari) && meta.totalSize >= IOS_MEMORY_WARN_BYTES && onNotification) {
          onNotification('检测到超大文件：将优先尝试使用 IndexedDB 分块缓冲，减少内存占用。', 'info');
      }
      if (shouldAutoResume) {
          if (onNotification) onNotification("连接已恢复，正在继续下载...", 'info');
          void receiveRecoveryCoordinator.resumeTransfer();
      }
  };

  // 分片 METADATA：按 transferId 重置缓冲、按 index 回填，收齐后 join + JSON.parse。
  const handleMetadataChunkMessage = (conn: DataConnection, payload: MetadataChunkPayload) => {
    const transferId = typeof payload?.transferId === 'string' ? payload.transferId : '';
    const index = Number.isInteger(payload?.index) ? payload.index : -1;
    const total = Number.isInteger(payload?.total) ? payload.total : -1;
    const data = typeof payload?.data === 'string' ? payload.data : null;

    if (!transferId || total <= 0 || index < 0 || index >= total || data === null) {
      setErrorMsg('文件元数据分片格式不正确，请重试。');
      setState(TransferState.ERROR);
      return;
    }

    const existing = metadataChunkBufferRef.current;
    if (!existing || existing.transferId !== transferId || existing.total !== total) {
      metadataChunkBufferRef.current = {
        transferId,
        total,
        received: 0,
        chunks: new Map<number, string>(),
      };
    }

    const buffer = metadataChunkBufferRef.current!;
    if (!buffer.chunks.has(index)) {
      buffer.chunks.set(index, data);
      buffer.received += 1;
    }

    if (buffer.received < buffer.total) {
      return;
    }

    metadataChunkBufferRef.current = null;

    const parts: string[] = [];
    for (let chunkIndex = 0; chunkIndex < buffer.total; chunkIndex += 1) {
      const part = buffer.chunks.get(chunkIndex);
      if (typeof part !== 'string') {
        setErrorMsg('文件元数据分片不完整，请重试。');
        setState(TransferState.ERROR);
        return;
      }
      parts.push(part);
    }

    let parsed: FileMetadata;
    try {
      parsed = JSON.parse(parts.join('')) as FileMetadata;
    } catch {
      setErrorMsg('文件元数据解析失败，请重试。');
      setState(TransferState.ERROR);
      return;
    }

    applyMetadataPayload(parsed, conn);
  };

  // 读取磁盘上已落盘文件的区间（用于续传前缀 CRC 校验）。
  const readPersistedFileRange = async (
    relativePath: string,
    offset: number,
    end: number
  ): Promise<Uint8Array | null> => {
    try {
      let fileHandle: FileSystemFileHandle | null = nativeFileHandleRef.current;
      if (!fileHandle && multiFileSaveModeRef.current === 'directory-direct') {
        const resolved = await directorySaveSessionRef.current.resolveFile(relativePath);
        fileHandle = (resolved?.fileHandle as unknown as FileSystemFileHandle | undefined) ?? null;
      }
      if (!fileHandle) return null;
      const file = await fileHandle.getFile();
      if (file.size < end) return null;
      return new Uint8Array(await file.slice(offset, end).arrayBuffer());
    } catch {
      return null;
    }
  };

  const handleIncomingMessage = async (conn: DataConnection, msg: P2PMessage) => {
    if (msg.type === 'DEVICE_INFO') {
      const remoteName = typeof msg.payload?.deviceName === 'string' ? msg.payload.deviceName.trim().slice(0, 24) : '';
      setSenderDeviceName(remoteName || '发送设备');
    }
    else if (msg.type === 'METADATA_CHUNK') {
      handleMetadataChunkMessage(conn, msg.payload);
    }
    else if (msg.type === 'METADATA') {
      applyMetadataPayload(msg.payload as FileMetadata, conn);
    }
    else if (msg.type === 'FILE_START') {
      const normalizedPath = sanitizeRelativeReceivePath(msg.payload.fileName || `file_${Date.now()}`);
      const resumeOffset = typeof msg.payload.resumeOffset === 'number' ? msg.payload.resumeOffset : 0;
      if (resumeOffset > 0 && msg.payload.prefixCrc32) {
        // 先用 manifest 解析出真正会落盘的路径（同名冲突会被去重成 `xxx (2).ext`），
        // 否则校验读到的是前一个文件的字节。
        const manifestEntry = receivedFileManifestRef.current.markReceiving(
          msg.payload.fileIndex,
          normalizedPath,
          msg.payload.fileSize,
          msg.payload.fileType,
        );
        const persistedRelativePath = manifestEntry?.relativePath ?? normalizedPath;
        // 续传前先验证磁盘上已有的前缀，避免把新数据接在损坏/截断的旧数据后面。
        // 读不到（句柄失效 / 文件不存在）同样按「前不可信」处理：宁可整文件重收，
        // 也不能把缺失前缀当作已通过校验后继续写。
        const verdict = await verifyPersistedPrefix({
          prefixLength: resumeOffset,
          expectedCrc32: msg.payload.prefixCrc32,
          readRange: (start, end) => readPersistedFileRange(persistedRelativePath, start, end),
        }).catch(() => 'unreadable' as const);
        if (verdict === 'unreadable') {
          logDebug('warn', 'resume prefix cannot be verified, restarting the file', { fileIndex: msg.payload.fileIndex });
        }
        if (verdict === 'mismatch' || verdict === 'unreadable') {
          markSessionEvent(connectTelemetryRef.current, 'resume_prefix_mismatch', {
            fileIndex: msg.payload.fileIndex,
            reason: verdict,
          });
          if (onNotification) {
            onNotification('已落盘数据校验不一致，将从头重新接收该文件。', 'info');
          }
          // 丢掉本地保留的写入状态：否则下一次 FILE_START 会被当成「同一文件续写」，
          // 沿用旧的 committedBytes，坏掉的旧前缀永远不会被覆盖。
          try {
            await abortStreams();
          } catch {}
          receivedSizeRef.current = 0;
          isStreamingRef.current = false;
          // 进度网关同样要归零：否则单调钳制会把上报值钉在旧值上，发送端信用窗口打不开。
          lastProgressAckBytesRef.current = 0;
          lastDurableProgressBytesRef.current = 0;
          stallRecoveryBaselineBytesRef.current = 0;
          lastDurableProgressAtRef.current = Date.now();
          try {
            resetFileBuffersForRepair(msg.payload.fileIndex);
            resetHasherForRepair();
          } catch {}
          try {
            conn.send({
              type: 'RESUME_REQUEST',
              payload: {
                fileIndex: msg.payload.fileIndex,
                byteOffset: 0,
                receiveWindowBytes: TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES,
              },
            });
          } catch {}
          return;
        }
      }
      try {
        // The manifest de-duplicates colliding relative paths; use its resolved
        // path so directory-direct writes cannot overwrite a same-named file.
        const manifestEntry = receivedFileManifestRef.current.markReceiving(
          msg.payload.fileIndex,
          normalizedPath,
          msg.payload.fileSize,
          msg.payload.fileType
        );
        await receiveSessionCoordinator.handleFileStart({
          ...msg.payload,
          fileName: manifestEntry?.relativePath ?? normalizedPath,
        });
      } catch (error) {
        logDebug('warn', 'rejected invalid file start:', error);
        setErrorMsg('收到的文件名不合法，传输已中止。请让对方重新发起传输。');
        setState(TransferState.ERROR);
        conn.close();
      }
    }
    else if (msg.type === 'FILE_COMPLETE') {
       await receiveSessionCoordinator.handleFileComplete(msg.payload);
    }
    else if (msg.type === 'ALL_FILES_COMPLETE') {
       await receiveSessionCoordinator.handleAllFilesComplete();
       clearResumeCheckpoint(receiverSessionIdRef.current);
       resumeCheckpointRef.current = null;
       metadataResumeFingerprintRef.current = null;
    }
    else if (msg.type === 'REJECT_TRANSFER') {
       markConnectionFailure(connectTelemetryRef.current, 'rejected_by_sender', { reason: msg.payload?.reason });
       setErrorMsg(msg.payload?.reason || "发送方拒绝了请求。");
       setState(TransferState.ERROR);
       markIntentionalConnectionClose(conn);
       conn.close();
    }
    else if (msg.type === 'TRANSFER_CANCELLED') {
       setErrorMsg("发送方已停止分享。");
       setState(TransferState.ERROR);
       markIntentionalConnectionClose(conn);
       conn.close();
    }
  };

  const setupConnListeners = (
    conn: DataConnection,
    attemptKind: RouteAttemptKind,
    attemptId: string,
    activityToken: number
  ) => {
    let reconnectScheduled = false;
    registerRouteAttempt({ attemptId, attemptKind, conn });

    const isCurrentActivity = () =>
      shouldHandleReceiverActivity({
        activityToken,
        currentActivityToken: receiverActivityTrackerRef.current.current(),
      });

    const scheduleFastReconnect = () => {
      if (reconnectScheduled) return true;
      if (attemptKind !== 'all') return false;
      if (happyEyeballsWonRef.current) return false;
      if (stateRef.current !== TransferState.WAITING_FOR_PEER) return false;
      if (retryCountRef.current >= MAX_CONNECT_RETRY) return false;
      if (!peerRef.current || peerRef.current.destroyed) return false;

      reconnectScheduled = true;
      retryCountRef.current += 1;
      const delay = Math.min(FAST_RETRY_BASE_MS * Math.pow(2, retryCountRef.current - 1), FAST_RETRY_MAX_MS);
      markConnectionRetry(connectTelemetryRef.current, 'data_channel_close_or_error');
      backgroundTimeoutGroupRef.current.schedule(() => {
        const activePeer = peerRef.current;
        if (
          !shouldRunReceiverScheduledReconnect({
            activityToken,
            currentActivityToken: receiverActivityTrackerRef.current.current(),
            state: stateRef.current,
            hasPeer: activePeer !== null,
            peerDestroyed: activePeer?.destroyed === true,
          })
        ) {
          return;
        }
        if (!activePeer) {
          return;
        }
        startConnectionAttempt(connectTelemetryRef.current, 'fast_retry');
        const fastRetryTarget = resolvedSenderPeerIdRef.current;
        if (!fastRetryTarget) return false;
        const nextConn = activePeer.connect(fastRetryTarget, { serialization: 'binary' });
        const nextAttemptId = getNextRouteAttemptId('all');
        setupConnListeners(nextConn, 'all', nextAttemptId, activityToken);
      }, delay);
      return true;
    };

    conn.on('open', () => {
      if (!isCurrentActivity()) {
        unregisterRouteAttempt(attemptId);
        markIntentionalConnectionClose(conn);
        try { conn.close(); } catch {}
        return;
      }
      clearConnectionTimeout();
      retryCountRef.current = 0;

      if (happyEyeballsWonRef.current) {
        closeRouteAttempt(attemptId, 'winner_selected');
        return;
      }

      if (attemptKind === 'all') {
        allAttemptProgressedRef.current = true;
      }

      logDebug('info', '[route-probe]', createRouteProbeLogPayload({
        receiverSessionId: receiverSessionIdRef.current,
        attemptId,
        attemptKind,
        openedAt: Date.now(),
        peerId: conn.peer,
      }));

      try {
        conn.send({
          type: 'ROUTE_PROBE',
          payload: {
            receiverSessionId: receiverSessionIdRef.current,
            attemptId,
            attemptKind,
            deviceName: localDeviceNameRef.current,
          },
        });
      } catch {
        if (scheduleFastReconnect()) {
          return;
        }
        markConnectionFailure(connectTelemetryRef.current, 'route_probe_failed');
        setErrorMsg('连接初始化失败，请重试');
        setState(TransferState.ERROR);
        try { conn.close(); } catch {}
      }
    });

    const handleRouteReady = (msg: P2PMessage) => {
      if (msg.type !== 'ROUTE_READY') return;
      if (msg.payload.receiverSessionId !== receiverSessionIdRef.current) return;
      if (msg.payload.attemptId !== attemptId) return;
      if (latestRouteAttemptIdsRef.current[attemptKind] !== attemptId) return;

      const registeredAttempt = routeAttemptsRef.current.get(attemptId);
      if (!registeredAttempt || registeredAttempt.conn !== conn) return;

      receiveRouteArbiterRef.current?.markAttemptReady(
        attemptId,
        attemptKind,
      );
    };

    conn.on('data', (data: any) => {
      const isBinaryData = data instanceof ArrayBuffer ||
        (data?.constructor && data.constructor.name === 'ArrayBuffer') ||
        ArrayBuffer.isView(data);
      if (!isBinaryData && (data as P2PMessage | null)?.type === 'ROUTE_READY') {
        if (isCurrentActivity()) {
          handleRouteReady(data as P2PMessage);
        }
        return;
      }

      void incomingDataProcessorRef.current.enqueue(async () => {
        if (!isCurrentActivity()) {
          return;
        }
        if (data == null) return;

        const currentState = stateRef.current;
        if (!isTransferActiveRef.current && currentState !== TransferState.IDLE && currentState !== TransferState.WAITING_FOR_PEER && currentState !== TransferState.PEER_CONNECTED) {
            return;
        }

        const isBinary = data instanceof ArrayBuffer || (data.constructor && data.constructor.name === 'ArrayBuffer') || ArrayBuffer.isView(data);

        if (isBinary) {
           if (connRef.current !== conn) {
             return;
           }
           if (!await receivePersistenceOrchestrator.awaitPendingFileFinalize('binary_chunk')) return;
           if (!isTransferActiveRef.current) return;
   
           const chunkData = ((): ArrayBuffer => {
                if (ArrayBuffer.isView(data)) {
                    const view = data as ArrayBufferView;
                   return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
               }
               return data as ArrayBuffer;
           })();
           const byteLength = chunkData.byteLength;

            if (byteLength > 0) {
                receivedChunksCountRef.current++;
                receivedSizeRef.current += byteLength;
                try {
                  getFileHasher().update(new Uint8Array(chunkData));
                } catch {
                  failTransferPersistence("文件校验计算失败，请重试传输。");
                  return;
                }
               hashedBytesRef.current += byteLength;
               
               if (isStreamingRef.current) {
                   try {
                     await receiveStreamingWriter.enqueueChunk(new Uint8Array(chunkData));
                   } catch (error) {
                     await handleStreamingWriteFailure(error);
                     return;
                   }
                   scheduleCommittedProgress();
               } else if (isIndexedDbBufferingRef.current) {
                   indexedDbBatchRef.current.push(chunkData);
                   indexedDbBatchBytesRef.current += byteLength;

                   if (indexedDbBatchBytesRef.current >= BUFFER_FLUSH_THRESHOLD) {
                       const fileIndexForBatch = currentFileIndexRef.current;
                       const batch = indexedDbBatchRef.current;
                       const batchSize = indexedDbBatchBytesRef.current;

                       indexedDbBatchRef.current = [];
                       indexedDbBatchBytesRef.current = 0;

                       await enqueueWrite(() => flushIndexedDbBatch(fileIndexForBatch, batch, batchSize));
                       if (stateRef.current === TransferState.ERROR) return;
                       scheduleCommittedProgress();
                   }
                } else {
                    chunksRef.current.push(chunkData);
                    scheduleCommittedProgress();
                }
            }
            return;
        }

        const msg = data as P2PMessage;

        if (connRef.current !== conn) {
          if (isRouteAttemptTransferControlMessage(msg.type)) {
            const disposition = getNonWinningRouteMessageDisposition({
              winnerCommitted: happyEyeballsWonRef.current,
              messageType: msg.type,
            });

            if (disposition === 'buffer') {
              bufferRouteMessage(attemptId, msg);
            } else {
              console.warn('[route-protocol-misuse]', {
                role: 'receiver',
                receiverSessionId: receiverSessionIdRef.current,
                attemptId,
                attemptKind,
                peerId: conn.peer,
                messageType: msg.type,
                reason: 'losing_route_received_transfer_control',
              });
              closeRouteAttempt(attemptId, 'lost_race');
            }
          }
          return;
        }

        await handleIncomingMessage(conn, msg);
      }).catch((error) => {
        console.warn('Receive message processing failed:', error);
      });
    });

    conn.on('close', () => {
       if (!isCurrentActivity()) {
        unregisterRouteAttempt(attemptId);
        intentionalConnectionCloseRef.current.delete(conn);
        return;
       }
       if (connRef.current !== conn) {
        unregisterRouteAttempt(attemptId);
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current === TransferState.WAITING_FOR_PEER) {
          scheduleFastReconnect();
        }
        return;
       }

       unregisterRouteAttempt(attemptId);
       connRef.current = null;
       clearHeartbeatTimer();
       clearProgressAckTimer();
       const currentState = stateRef.current;
       const intentionalClose = intentionalConnectionCloseRef.current.delete(conn);
       if (currentState === TransferState.WAITING_FOR_PEER && scheduleFastReconnect()) {
          return;
       }
       if (intentionalClose) {
         return;
       }
       if (
        shouldAutoReconnectCommittedSession({
          currentState,
          hasCode: isValidShareCode(codeRef.current),
          intentionalClose,
        })
       ) {
        pendingCommittedReconnectResumeRef.current = shouldPreserveCommittedReconnectResumeIntent({
          currentState,
          transferActive: isTransferActiveRef.current,
        });
        if (committedReconnectTimerRef.current !== null) {
          return;
        }
        if (committedReconnectAttemptsRef.current >= MAX_COMMITTED_RECONNECT_RETRY) {
          setErrorMsg(getReceiverDisconnectedMessage(hasTurnRef.current, false));
          setState(TransferState.ERROR);
          return;
        }

        committedReconnectAttemptsRef.current += 1;
        const reconnectAttempt = committedReconnectAttemptsRef.current;
        const reconnectDelayMs = getCommittedSessionReconnectDelayMs(reconnectAttempt);
        setReconnectAttempt(reconnectAttempt);
        setErrorMsg('连接中断，正在尝试恢复...');
        setConnectingStage('reconnecting');
        setState(TransferState.WAITING_FOR_PEER);
        if (onNotification) {
          onNotification(`连接中断，正在尝试第 ${reconnectAttempt} 次重连...`, 'info');
        }
        const forceRelay = forceRelayOnCommittedReconnectRef.current;
        forceRelayOnCommittedReconnectRef.current = false;
        committedReconnectTimerRef.current = window.setTimeout(() => {
          committedReconnectTimerRef.current = null;
          if (!isCurrentActivity()) return;
          if (!isValidShareCode(codeRef.current)) return;
          void handleConnectRef.current({
            preserveCommittedReconnectAttempts: true,
            forceRelay,
          });
        }, reconnectDelayMs);
        return;
       }
       clearConnectionTimeout();
       if (currentState !== TransferState.COMPLETED) {
         markConnectionFailure(connectTelemetryRef.current, 'connection_closed', { state: currentState });
       }
      if (
        currentState === TransferState.TRANSFERRING ||
        currentState === TransferState.WAITING_FOR_PEER ||
        currentState === TransferState.PEER_CONNECTED
      ) {
        setErrorMsg(
          getReceiverDisconnectedMessage(
            hasTurnRef.current,
            currentState === TransferState.WAITING_FOR_PEER
          )
        );
        setState(TransferState.ERROR);
      }
    });

    conn.on('error', () => {
      if (!isCurrentActivity()) {
        unregisterRouteAttempt(attemptId);
        intentionalConnectionCloseRef.current.delete(conn);
        return;
      }
      if (connRef.current !== conn) {
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current === TransferState.WAITING_FOR_PEER) {
          scheduleFastReconnect();
        }
        return;
      }
      clearHeartbeatTimer();
      clearProgressAckTimer();
      if (scheduleFastReconnect()) {
        return;
      }
      if (
        shouldAutoReconnectCommittedSession({
          currentState: stateRef.current,
          hasCode: isValidShareCode(codeRef.current),
          intentionalClose: intentionalConnectionCloseRef.current.has(conn),
        })
      ) {
        pendingCommittedReconnectResumeRef.current = shouldPreserveCommittedReconnectResumeIntent({
          currentState: stateRef.current,
          transferActive: isTransferActiveRef.current,
        });
        try { conn.close(); } catch {}
        return;
      }
      markConnectionFailure(connectTelemetryRef.current, 'data_channel_error');
    });
  };

  const cleanupLosingPeer = (winningConn: DataConnection) => {
    // Destroy the relay peer if the P2P peer won, or vice-versa.
    const winningPeer = winningConn.provider;
    if (relayPeerRef.current && relayPeerRef.current !== winningPeer) {
      try { relayPeerRef.current.destroy(); } catch {}
      relayPeerRef.current = null;
      relayConnRef.current = null;
    }
    if (peerRef.current && peerRef.current !== winningPeer) {
      try { peerRef.current.destroy(); } catch {}
    }
    peerRef.current = winningPeer;
  };

  const resetStateForNewTransfer = () => {
      chunksRef.current = [];
      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      resetIndexedDbFileState();
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
      hashedBytesRef.current = 0;
      completedFileIndicesRef.current.clear();
      currentFileIndexRef.current = 0;
      currentFileNameRef.current = '';
      setDownloadSpeed('0 KB/s');
      setDownloadSpeedBytes(0);
      lastReportedSpeedBytesRef.current = 0;
      lastProgressAckBytesRef.current = 0;
      clearProgressAckTimer();
      receiveRecoveryCoordinator.reset();
      setEta('--');
      preparedNativeWriterFileIndexRef.current = null;
      directorySaveSessionRef.current = createDirectorySaveSession();
      receivedFileManifestRef.current.reset();
      multiFileSaveModeRef.current = 'per-file-save-queue';
      metadataChunkBufferRef.current = null;
      incomingDataProcessorRef.current.reset();
      receivePersistenceAdapter.reset();
      receivePersistenceOrchestrator.reset();
      writeQueueRef.current = Promise.resolve();
  };

  const prepareFilePersistenceTarget = async ({
    fileIndex,
    fileName,
    fileSize,
    persistenceStrategy,
    usePreparedNativeWriter,
    directSaveMode,
  }: {
    fileIndex: number;
    fileName: string;
    fileSize: number;
    persistenceStrategy: 'native-fs' | 'stream-saver' | 'indexeddb-buffer' | 'memory-blob';
    usePreparedNativeWriter: boolean;
    directSaveMode: 'native-fs' | 'directory-direct' | 'none';
  }) => {
    if (usePreparedNativeWriter) {
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      preparedNativeWriterFileIndexRef.current = null;
      return;
    }

    if (persistenceStrategy === 'native-fs' && directSaveMode === 'directory-direct') {
      try {
        receiveStreamingWriter.attachTarget(
          await directorySaveSessionRef.current.createStreamingTarget(fileName),
          { committedBytes: 0 }
        );
        isStreamingRef.current = receiveStreamingWriter.isStreaming();
        return;
      } catch (error) {
        logDebug('warn', 'Directory direct save setup failed:', error);
        receiveStreamingWriter.reset();
        isStreamingRef.current = false;
      }
    }

    if (persistenceStrategy === 'native-fs' && nativeFileHandleRef.current) {
      try {
        const writable = await nativeFileHandleRef.current.createWritable({ keepExistingData: false });
        receiveStreamingWriter.attachTarget(createNativeStreamingTarget(nativeFileHandleRef.current, writable), {
          committedBytes: 0,
        });
        isStreamingRef.current = receiveStreamingWriter.isStreaming();
        return;
      } catch {
        receiveStreamingWriter.reset();
        isStreamingRef.current = false;
      }
    }

    if (!receiveStreamingWriter.isStreaming()) {
      if (persistenceStrategy === 'indexeddb-buffer' || persistenceStrategy === 'memory-blob') {
        receiveStreamingWriter.reset();
        isStreamingRef.current = false;
        return;
      }

      if (persistenceStrategy === 'stream-saver') {
        try {
          const streamPathname =
            `${STREAMSAVER_PATH_PREFIX}${Date.now().toString(36)}-` +
            `${Math.random().toString(36).slice(2, 8)}/${encodeURIComponent(fileName)}`;
          const fileStream = streamSaver.createWriteStream(fileName, {
            size: fileSize,
            pathname: streamPathname,
          });
          receiveStreamingWriter.attachTarget(createStreamSaverTarget(fileStream.getWriter()), {
            committedBytes: 0,
          });
          isStreamingRef.current = receiveStreamingWriter.isStreaming();
          return;
        } catch {
          receiveStreamingWriter.reset();
          isStreamingRef.current = false;
          return;
        }
      }

      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      return;
    }

    isStreamingRef.current = receiveStreamingWriter.isStreaming();
  };

  const setCurrentFileTransferState = ({
    fileIndex,
    fileName,
    fileSize,
  }: {
    fileIndex: number;
    fileName: string;
    fileSize: number;
  }) => {
    currentFileSizeRef.current = fileSize;
    currentFileIndexRef.current = fileIndex;
    currentFileNameRef.current = fileName;
    lastSpeedUpdateRef.current = Date.now();
    lastSpeedBytesRef.current = receivedSizeRef.current;
    lastReportedSpeedBytesRef.current = 0;
    setCurrentFileName(fileName);
    setCurrentFileIndex(fileIndex + 1);
    setProgress(fileSize > 0 ? Math.min(100, Math.floor((receivedSizeRef.current / fileSize) * 100)) : 0);
    setEta('计算中...');
    setDownloadSpeed('0 KB/s');
  };

  const markReceiveSessionCompleted = () => {
    setState(TransferState.COMPLETED);
    setReconnectAttempt(0);
    if (onNotification) onNotification("所有文件接收完毕", 'success');
    resetStateForNewTransfer();
    isTransferActiveRef.current = false;
  };

  if (!receiveRecoveryCoordinatorRef.current) {
    receiveRecoveryCoordinatorRef.current = createReceiveRecoveryCoordinator({
      maxAutoRepairRetries: MAX_AUTO_REPAIR_RETRIES_PER_FILE,
      getConnection: () => connRef.current,
      setTransferActive: (active) => {
        isTransferActiveRef.current = active;
      },
      getCurrentFileIndex: () => currentFileIndexRef.current,
      getReceivedSize: () => receivedSizeRef.current,
      getCommittedStreamBytes: () => receiveStreamingWriter.getCommittedBytes(),
      getCurrentFileSize: () =>
        currentFileSizeRef.current ||
        (metadataRef.current?.files?.[currentFileIndexRef.current]?.size ?? 0),
      getResumeCheckpoint: () => resumeCheckpointRef.current,
      requestReselectReceiveTarget: async ({ fileIndex, byteOffset }) => {
        // 刷新后原来的写入目标已经失效，需要用户重新授权一次保存位置才能按偏移续写。
        currentFileIndexRef.current = fileIndex;
        try {
          if (multiFileSaveModeRef.current === 'directory-direct') {
            const resolution = await resolveDirectoryHandleForResume({
              getCachedHandle: () => sessionDirectoryHandleCacheRef.current.getReusableHandle(),
              loadPersistedHandle: () => persistedDirectoryHandleRef.current.load(),
              ensureWritePermission: async (handle) => {
                const permissionApi = handle as FileSystemDirectoryHandle & {
                  requestPermission?: (options?: { mode?: 'read' | 'write' | 'readwrite' }) => Promise<PermissionState>;
                };
                if (typeof permissionApi.requestPermission !== 'function') return true;
                const state = await permissionApi.requestPermission({ mode: 'readwrite' });
                return state === 'granted';
              },
              pickDirectory: async () =>
                typeof window.showDirectoryPicker === 'function'
                  ? window.showDirectoryPicker({ mode: 'readwrite' })
                  : null,
            });
            if (!resolution) return false;
            directorySaveSessionRef.current = createDirectorySaveSession({ rootDirectoryHandle: resolution.handle });
            sessionDirectoryHandleCacheRef.current.remember(resolution.handle);
            void persistedDirectoryHandleRef.current.save(resolution.handle);
            return await reopenNativeWriterForResume(fileIndex, byteOffset);
          }

          if (typeof window.showSaveFilePicker !== 'function') return false;
          const suggestedName = sanitizeFileName(
            metadataRef.current?.files?.[fileIndex]?.name || `file_${Date.now()}.bin`
          );
          const fileHandle = await window.showSaveFilePicker({ suggestedName });
          if (!fileHandle) return false;
          nativeFileHandleRef.current = fileHandle;
          preparedNativeWriterFileIndexRef.current = null;
          return await reopenNativeWriterForResume(fileIndex, byteOffset);
        } catch {
          return false;
        }
      },
      isFileCompleted: (fileIndex) => completedFileIndicesRef.current.has(fileIndex),
      hasRetainedCurrentFileData,
      flushPendingStreamWrites,
      reopenNativeWriterForResume,
      resetFileBuffersForRepair,
      resetHasherForRepair,
      abortStreams,
      awaitWriteQueue: () => writeQueueRef.current,
      deleteIndexedDbChunksForFile,
      setProgress,
      setDownloadSpeed,
      setDownloadSpeedBytes,
      setEta,
      setTransferState: setState,
      setError: setErrorMsg,
      notify: onNotification,
      failTransferPersistence,
    });
  }
  const receiveRecoveryCoordinator = receiveRecoveryCoordinatorRef.current!;

  if (!receivePersistenceAdapterRef.current) {
    receivePersistenceAdapterRef.current = createReceivePersistenceAdapter({
      isIOS,
      isSafari,
      isTransferActive: () => isTransferActiveRef.current,
      getReceivedSize: () => receivedSizeRef.current,
      getCurrentFileSize: () =>
        currentFileSizeRef.current ||
        (metadataRef.current?.files?.[currentFileIndexRef.current]?.size ?? 0),
      getCurrentFileIndex: () => currentFileIndexRef.current,
      getCurrentFileInfo: () => {
        const file = metadataRef.current?.files?.[currentFileIndexRef.current];
        return file ? { name: file.name, type: file.type } : null;
      },
      isIndexedDbBuffering: () => isIndexedDbBufferingRef.current,
      getMemoryChunks: () => chunksRef.current,
      readIndexedDbBlobsForFile,
      deleteIndexedDbChunksForFile,
      resetIndexedDbFileState: resetIndexedDbPersistedFileState,
      resetMemoryFileState,
      failTransferPersistence,
      getArchiveEntries: () =>
        receivedFileManifestRef.current.getStagedEntries().map((entry) => ({
          relativePath: entry.relativePath,
          fileName: entry.fileName,
          blob: entry.stagedBlob!,
        })),
      stageCurrentFileForArchive: (entry) => {
        receivedFileManifestRef.current.markStaged(entry.fileIndex, {
          storageKind: entry.storageKind,
          blob: entry.blob,
        });
      },
      exportArchiveBlob: async (entries) => archiveExportSessionRef.current.exportZip(entries),
    });
  }
  const receivePersistenceAdapter = receivePersistenceAdapterRef.current!;

  if (!receivePersistenceOrchestratorRef.current) {
    receivePersistenceOrchestratorRef.current = createReceivePersistenceOrchestrator({
      getState: () => stateRef.current,
      isTransferActive: () => isTransferActiveRef.current,
      getCurrentFileIndex: () => currentFileIndexRef.current,
      isIndexedDbBuffering: () => isIndexedDbBufferingRef.current,
      isStreaming: () => receiveStreamingWriter.isStreaming(),
      finalizeStreamingWriter: async () => {
        const finalized = await receiveStreamingWriter.finalize();
        isStreamingRef.current = receiveStreamingWriter.isStreaming();
        return finalized;
      },
      takeIndexedDbBatch: () => {
        const batch = indexedDbBatchRef.current;
        const size = indexedDbBatchBytesRef.current;
        indexedDbBatchRef.current = [];
        indexedDbBatchBytesRef.current = 0;
        return { batch, size };
      },
      flushIndexedDbBatch,
      takeStreamBatch: () => ({ batch: [], size: 0 }),
      flushSpecificBatch,
      enqueueWrite,
      closeStreams: () => closeStreams(),
      saveCurrentFile: () => receivePersistenceAdapter.saveCurrentFile(),
      markCurrentFilePersisted,
      failTransferPersistence,
    });
  }
  const receivePersistenceOrchestrator = receivePersistenceOrchestratorRef.current!;

  if (!receiveSessionCoordinatorRef.current) {
    receiveSessionCoordinatorRef.current = createReceiveSessionCoordinator({
      awaitPendingFileFinalize: (reason) => receivePersistenceOrchestrator.awaitPendingFileFinalize(reason),
      isIOS,
      isSafari,
      preferBrowserDownload: false,
      supportsStreamSaver: !!streamSaver,
      indexedDbThresholdBytes: IOS_IDB_BUFFER_THRESHOLD_BYTES,
      getMetadataFileCount: () => metadataRef.current?.files?.length ?? 0,
      getFileStartPersistenceCapabilities: (fileIndex) => {
        const usePreparedNativeWriter = false;
        const isMultiFile = (metadataRef.current?.files?.length ?? 0) > 1;
        const directoryDirectActive =
          isMultiFile && multiFileSaveModeRef.current === 'directory-direct';
        const canUseNativeFs =
          directoryDirectActive ||
          (
            !isIOS &&
            !isSafari &&
            !!window.showSaveFilePicker &&
            (metadataRef.current?.files?.length ?? 0) === 1 &&
            !!nativeFileHandleRef.current
          );
        return {
          canUseNativeFs,
          usePreparedNativeWriter,
          directSaveMode: directoryDirectActive ? 'directory-direct' : canUseNativeFs ? 'native-fs' : 'none',
        };
      },
      supportsIndexedDb: isIndexedDbSupported,
      setTransferActive: (active) => {
        isTransferActiveRef.current = active;
      },
      isTransferActive: () => isTransferActiveRef.current,
      isStreaming: () => receiveStreamingWriter.isStreaming(),
      isIndexedDbBuffering: () => isIndexedDbBufferingRef.current,
      setIndexedDbBuffering: (enabled) => {
        isIndexedDbBufferingRef.current = enabled;
      },
      notifyIndexedDbBufferingEnabled: () => {
        if (isIndexedDbBufferingRef.current && !indexedDbNotifiedRef.current && onNotification) {
          indexedDbNotifiedRef.current = true;
          onNotification('iOS 大文件已启用 IndexedDB 缓冲模式', 'info');
        }
      },
      hasRetainedCurrentFileData,
      abortStreams,
      resetIncomingFileBuffers: resetFileBuffersForRepair,
      awaitWriteQueue: async () => {
        await writeQueueRef.current;
        await receiveStreamingWriter.awaitIdle();
      },
      deleteIndexedDbChunksForFile,
      prepareFilePersistenceTarget,
      setCurrentFileState: setCurrentFileTransferState,
      resetFileHasher: resetHasherForRepair,
      shouldStageFilesForArchive: () => multiFileSaveModeRef.current === 'archive-export',
      stageCurrentFileForArchive: async () => {
        if (isIndexedDbBufferingRef.current && indexedDbBatchBytesRef.current > 0) {
          const batch = indexedDbBatchRef.current;
          const size = indexedDbBatchBytesRef.current;
          const fileIndex = currentFileIndexRef.current;
          indexedDbBatchRef.current = [];
          indexedDbBatchBytesRef.current = 0;
          await enqueueWrite(async () => {
            if (size > 0) {
              await flushIndexedDbBatch(fileIndex, batch, size);
            }
          });
        }

        return receivePersistenceAdapter.stageCurrentFileForArchive();
      },
      finalizeArchiveDownload: async () => {
        const result = await receivePersistenceAdapter.saveReceivedFiles({
          archiveName: `aerodrop-${Date.now().toString(36)}`,
          files: receivedFileManifestRef.current.getStagedEntries().map((entry) => ({
            relativePath: entry.relativePath,
            downloadName: entry.fileName,
            open: async () => entry.stagedBlob!,
          })),
        });

        return result.mode === 'archive-export' || result.mode === 'per-file-save-queue';
      },
      getCurrentFileIndex: () => currentFileIndexRef.current,
      getCurrentFileName: () => currentFileNameRef.current,
      getCurrentFileSize: () =>
        currentFileSizeRef.current ||
        (metadataRef.current?.files?.[currentFileIndexRef.current]?.size ?? 0),
      getReceivedSize: () => receivedSizeRef.current,
      getHashedBytes: () => hashedBytesRef.current,
      finalizeHasher: () => getFileHasher().finalizeHex(),
      requestAutoRepair: (fileIndex, reason) => receiveRecoveryCoordinator.requestAutoRepair(fileIndex, reason),
      clearPendingAutoRepairFile: (fileIndex) => receiveRecoveryCoordinator.clearPendingAutoRepairFile(fileIndex),
      getPendingAutoRepairFile: () => receiveRecoveryCoordinator.getPendingAutoRepairFile(),
      hasPendingAutoRepair: () => receiveRecoveryCoordinator.hasPendingAutoRepair(),
      finalizeCurrentFilePersistence: (fileName) => receivePersistenceOrchestrator.finalizeCurrentFile(fileName),
      saveCurrentFile: () => receivePersistenceAdapter.saveCurrentFile(),
      markCurrentFilePersisted,
      getExpectedFiles: () => metadataRef.current?.files?.length ?? 0,
      getSavedFiles: () => completedFileIndicesRef.current.size,
      sendTransferProgress,
      sendAllFilesReceived: () => {
        const conn = connRef.current;
        if (!conn) return;
        try {
          conn.send({ type: 'ALL_FILES_RECEIVED' });
        } catch {
          // Ignore ack send failures; sender has heartbeat/close fallback.
        }
      },
      markCompleted: markReceiveSessionCompleted,
      failTransferPersistence,
    });
  }
  const receiveSessionCoordinator = receiveSessionCoordinatorRef.current!;

  const resolveSenderPeerId = async (targetCode: string): Promise<string | null> => {
    if (!isValidShareCode(targetCode)) return null;
    return lookupSharePeerId(targetCode);
  };

  const handleConnect = async (options?: {
    preserveCommittedReconnectAttempts?: boolean;
    forceRelay?: boolean;
  }) => {
    if (!isValidShareCode(code)) return;
    const receiverActivityToken = receiverActivityTrackerRef.current.begin();
    clearCommittedReconnectTimer();
    backgroundTimeoutGroupRef.current.clearAll();
    if (!options?.preserveCommittedReconnectAttempts) {
      committedReconnectAttemptsRef.current = 0;
      pendingCommittedReconnectResumeRef.current = false;
      setReconnectAttempt(0);
    }
    const resolvedPeerId = await resolveSenderPeerId(code);
    if (!resolvedPeerId) {
      if (receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
        setErrorMsg('口令不存在或已过期，请确认后重试。');
        setState(TransferState.ERROR);
      }
      return;
    }
    resolvedSenderPeerIdRef.current = resolvedPeerId;
    connectTelemetryRef.current = createConnectionSession('receiver', { code });
    setState(TransferState.WAITING_FOR_PEER);
    setConnectingStage('fetching_ice');
    setErrorMsg('');
    retryCountRef.current = 0;
    happyEyeballsWonRef.current = false;
    allAttemptProgressedRef.current = false;
    resetRouteAttemptState();
    connRef.current = null;
    relayConnRef.current = null;
    startConnectionAttempt(connectTelemetryRef.current, 'initial_connect');

    if (peerRef.current) peerRef.current.destroy();
    if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }

    const iceConfig = await getIceConfig();
    if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
      return;
    }
    const networkProfile = getBrowserNetworkProfile();
    const connectionPlan = createHappyEyeballsPlan(iceConfig, networkProfile, {
      defaultInitialTimeoutMs: INITIAL_TIMEOUT_MS,
      relayInitialTimeoutMs: RELAY_TIMEOUT_MS,
      forceRelay: options?.forceRelay,
    });
    const routeSelectionContext = {
      isMobileDevice: networkProfile.isMobileDevice,
      isConstrained: networkProfile.isConstrained,
      relayRecommended: iceConfig.relayRecommended,
      fetchLatencyMs: iceConfig.fetchLatencyMs,
    };
    const routeSelectionTimings = getRouteSelectionTimings(routeSelectionContext);
    const routeSelectionDecision = getRouteSelectionDecision(routeSelectionContext);
    const effectiveP2pGraceWindowMs = connectionPlan.reason === 'stalled_transfer'
      ? 0
      : routeSelectionTimings.p2pGraceWindowMs;
    routeSelectionDecisionRef.current = {
      ...routeSelectionDecision,
      p2pGraceWindowMs: effectiveP2pGraceWindowMs,
      reasons: connectionPlan.reason === 'stalled_transfer'
        ? [...routeSelectionDecision.reasons, 'stalled_transfer']
        : routeSelectionDecision.reasons,
    };
    markIceConfigFetched(connectTelemetryRef.current);
    setConnectingStage('connecting_signaling');
    hasTurnRef.current = iceConfig.hasTurn;
    preferredIcePolicyRef.current = connectionPlan.initialPolicy;
    p2pTimeoutRetryCountRef.current = 0;
    receiveRouteArbiterRef.current = createReceiveRouteArbiter({
      p2pGraceWindowMs: effectiveP2pGraceWindowMs,
      onCommit: ({ kind: winningKind, attemptId: winnerAttemptId }) => {
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) {
          return;
        }

        const winner = routeAttemptsRef.current.get(winnerAttemptId);
        if (!winner || !winner.conn.open) {
          return;
        }

        clearConnectionTimeout();
        connRef.current = winner.conn;
        happyEyeballsWonRef.current = true;
        preferredIcePolicyRef.current = winningKind;
        closeNonWinningRouteAttempts(winnerAttemptId);
        cleanupLosingPeer(winner.conn);
        markConnectionSuccess(connectTelemetryRef.current, { peerId: winner.conn.peer });
        setConnectingStage('waiting_response');

        try {
          winner.conn.send({
            type: 'ROUTE_COMMIT',
            payload: {
              receiverSessionId: receiverSessionIdRef.current,
              attemptId: winnerAttemptId,
              selectedKind: winningKind,
            },
          });
          winner.conn.send({
            type: 'DEVICE_INFO',
            payload: {
              deviceName: localDeviceNameRef.current,
              sessionId: receiverSessionIdRef.current,
            },
          });
        } catch {
          markConnectionFailure(connectTelemetryRef.current, 'route_commit_failed');
          setErrorMsg('建立路由失败，请重试');
          setState(TransferState.ERROR);
          try { winner.conn.close(); } catch {}
          return;
        }

        startWinnerHeartbeat(winner.conn);
        collectSelectedRoute(winner.conn);
        const pendingMessages = takePendingRouteMessages(winnerAttemptId);
        void pendingMessages.reduce(
          (chain, message) => chain.then(() => handleIncomingMessage(winner.conn, message)),
          Promise.resolve()
        );
      },
      schedule: (ms, fn) => window.setTimeout(fn, ms),
      clearScheduled: (id) => window.clearTimeout(id),
    });

    if (
      iceConfig.hasTurn &&
      (connectionPlan.reason === 'mobile_network' ||
        connectionPlan.reason === 'constrained_network' ||
        connectionPlan.reason === 'relay_recommended') &&
      onNotification
    ) {
      if (connectionPlan.initialPolicy === 'relay') {
        onNotification('检测到移动或高延迟网络，已优先尝试中继连接以提升成功率。', 'info');
      } else {
        onNotification('检测到当前网络可能受限，将优先尝试直连，并在需要时快速回退到中继。', 'info');
      }
    } else if (!iceConfig.hasTurn && onNotification) {
      onNotification(NO_TURN_WARNING_MESSAGE, 'info');
    }

    const applyConnectTimeout = (timeoutMs: number) => {
      clearConnectionTimeout();
      connectionTimeoutRef.current = setTimeout(() => {
        connectionTimeoutRef.current = null;
        if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
          return;
        }

        // If happy-eyeballs already connected, ignore the timeout.
        if (happyEyeballsWonRef.current) return;

        if (hasTurnRef.current && preferredIcePolicyRef.current === 'all') {
          if (p2pTimeoutRetryCountRef.current < 1) {
            p2pTimeoutRetryCountRef.current += 1;
            markSessionEvent(connectTelemetryRef.current, 'p2p_timeout_retry');
            markConnectionRetry(connectTelemetryRef.current, 'timeout_retry_p2p_all');
            startConnectionAttempt(connectTelemetryRef.current, 'p2p_retry_all');
            createAndConnectPeer('all', INITIAL_TIMEOUT_MS);
            return;
          }
        }

        // Final timeout — tear down everything.
        resetRouteAttemptState();
        if (peerRef.current) peerRef.current.destroy();
        if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }
        markConnectionFailure(connectTelemetryRef.current, 'connect_timeout', { timeoutMs });
        setErrorMsg(getReceiverPreTransferFailureMessage(hasTurnRef.current));
        setState(TransferState.ERROR);
      }, timeoutMs);
    };

    const createAndConnectPeer = async (policy: RTCIceTransportPolicy, timeoutMs: number) => {
      if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
        return;
      }
      // For relay fallback via happy-eyeballs, keep the P2P peer alive.
      if (policy !== 'relay' && peerRef.current && !peerRef.current.destroyed) {
        peerRef.current.destroy();
      }

      let peer: Peer;
      try {
        const { default: PeerRuntime } = await loadPeerRuntime();
        peer = new PeerRuntime({
          debug: peerDebugLevel,
          pingInterval: 5000,
          config: {
            iceServers: iceConfig.iceServers,
            iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
            iceTransportPolicy: policy,
          }
        });
      } catch {
        if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
          return;
        }
        clearConnectionTimeout();
        setErrorMsg('加载连接模块失败，请重试');
        setState(TransferState.ERROR);
        return;
      }

      if (
        !receiverActivityTrackerRef.current.isCurrent(receiverActivityToken) ||
        stateRef.current !== TransferState.WAITING_FOR_PEER
      ) {
        try { peer.destroy(); } catch {}
        return;
      }

      peer.on('open', () => {
        if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
          peer.destroy();
          return;
        }
        if (happyEyeballsWonRef.current) { peer.destroy(); return; }
        markSignalingOpen(connectTelemetryRef.current);
        setConnectingStage('connecting_peer');
        markSessionEvent(connectTelemetryRef.current, 'peer_open', { iceTransportPolicy: policy });
        const senderPeerId = resolvedSenderPeerIdRef.current;
        if (!senderPeerId) {
          setErrorMsg('口令不存在或已过期，请确认后重试。');
          setState(TransferState.ERROR);
          return;
        }
        const conn = peer.connect(senderPeerId, { serialization: 'binary' });
        const attemptKind: RouteAttemptKind = policy === 'relay' ? 'relay' : 'all';
        const attemptId = getNextRouteAttemptId(attemptKind);
        if (policy === 'relay') {
          relayConnRef.current = conn;
        }
        setupConnListeners(conn, attemptKind, attemptId, receiverActivityToken);
      });

      peer.on('error', (err) => {
        if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) {
          return;
        }
        if (happyEyeballsWonRef.current) return;
        if (err.type === 'rate-limited') {
          clearConnectionTimeout();
          markConnectionFailure(connectTelemetryRef.current, 'rate_limited');
          setErrorMsg(RATE_LIMITED_CONNECTION_MESSAGE);
          setState(TransferState.ERROR);
        } else if (err.type === 'peer-unavailable' && retryCountRef.current < MAX_CONNECT_RETRY) {
          // Skip peer-unavailable retries for the background relay attempt
          // to avoid burning the shared retry budget and routing through the wrong peer.
          if (policy === 'relay') return;
          retryCountRef.current++;
          const delay = Math.min(FAST_RETRY_BASE_MS * Math.pow(2, retryCountRef.current - 1), FAST_RETRY_MAX_MS);
          markConnectionRetry(connectTelemetryRef.current, 'peer_unavailable');
          backgroundTimeoutGroupRef.current.schedule(() => {
            if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) return;
            if (happyEyeballsWonRef.current) return;
            if (peer && !peer.destroyed) {
              startConnectionAttempt(connectTelemetryRef.current, 'peer_unavailable_retry');
              const senderPeerId = resolvedSenderPeerIdRef.current;
        if (!senderPeerId) {
          setErrorMsg('口令不存在或已过期，请确认后重试。');
          setState(TransferState.ERROR);
          return;
        }
        const conn = peer.connect(senderPeerId, { serialization: 'binary' });
              const attemptId = getNextRouteAttemptId('all');
              setupConnListeners(conn, 'all', attemptId, receiverActivityToken);
            }
          }, delay);
        } else {
          // Only fail if this is the primary peer (not a background relay attempt).
          if (policy === 'relay' && peerRef.current && !peerRef.current.destroyed) return;
          clearConnectionTimeout();
          markConnectionFailure(connectTelemetryRef.current, `peer_error:${err.type}`);
          setErrorMsg(`连接错误: ${err.type}`);
          setState(TransferState.ERROR);
        }
      });

      if (policy === 'relay') {
        relayPeerRef.current = peer;
      } else {
        peerRef.current = peer;
      }
      applyConnectTimeout(timeoutMs);
      };

    const initialPolicy = connectionPlan.initialPolicy;
    const backgroundPolicy = connectionPlan.backgroundPolicy;
    const initialTimeoutMs = connectionPlan.initialTimeoutMs;
    const backgroundDelayMs = connectionPlan.backgroundDelayMs;
    const backgroundTimeoutMs = connectionPlan.backgroundTimeoutMs;
    const primaryProbeWindowMs = routeSelectionTimings.primaryProbeWindowMs ?? null;

    markSessionEvent(connectTelemetryRef.current, 'ice_strategy_selected', {
      initialPolicy,
      backgroundPolicy,
      relayRecommended: iceConfig.relayRecommended,
      relayReason: iceConfig.relayReason,
      fetchLatencyMs: iceConfig.fetchLatencyMs,
      strategyReason: connectionPlan.reason,
      networkType: networkProfile.connectionType,
      effectiveType: networkProfile.effectiveType,
      isLikelyMobileNetwork: networkProfile.isLikelyMobileNetwork,
      isConstrained: networkProfile.isConstrained,
    });
    void createAndConnectPeer(initialPolicy, initialTimeoutMs);

    if (
      iceConfig.hasTurn &&
      backgroundPolicy &&
      backgroundPolicy !== initialPolicy &&
      backgroundDelayMs !== null &&
      backgroundTimeoutMs !== null
    ) {
      backgroundTimeoutGroupRef.current.schedule(() => {
        if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) return;
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) return;
        markSessionEvent(
          connectTelemetryRef.current,
          backgroundPolicy === 'relay' ? 'happy_eyeballs_relay_start' : 'happy_eyeballs_p2p_backfill_start'
        );
        startConnectionAttempt(
          connectTelemetryRef.current,
          backgroundPolicy === 'relay' ? 'relay_parallel' : 'p2p_backfill_parallel'
        );
        void createAndConnectPeer(backgroundPolicy, backgroundTimeoutMs);
      }, backgroundDelayMs);
    }

    if (
      iceConfig.hasTurn &&
      initialPolicy === 'all' &&
      backgroundPolicy === null &&
      primaryProbeWindowMs !== null
    ) {
      backgroundTimeoutGroupRef.current.schedule(() => {
        if (!receiverActivityTrackerRef.current.isCurrent(receiverActivityToken)) return;
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) return;
        if (allAttemptProgressedRef.current) return;
        markSessionEvent(connectTelemetryRef.current, 'happy_eyeballs_probe_window_relay_start', {
          primaryProbeWindowMs,
        });
        startConnectionAttempt(connectTelemetryRef.current, 'relay_probe_window_fallback');
        void createAndConnectPeer('relay', RELAY_TIMEOUT_MS);
      }, primaryProbeWindowMs);
    }
  };

  const acceptTransfer = async () => {
    if (acceptingRef.current) {
      return;
    }

    const initialConn = connRef.current;
    if (!initialConn || !initialConn.open) {
      setErrorMsg("连接已断开，请重新连接发送方。");
      setState(TransferState.ERROR);
      if (onNotification) onNotification("连接已断开，请重试", 'error');
      return;
    }

    acceptingRef.current = true;

    // 保存对话框（目录 / 文件）可能停留几十秒，期间连接可能已断开或组件已卸载。
    const getLiveConnection = (): DataConnection | null => {
      const activeConn = connRef.current;
      if (!isMountedRef.current || !activeConn || !activeConn.open) {
        return null;
      }
      return activeConn;
    };

    const abortAcceptedTransfer = () => {
      isTransferActiveRef.current = false;
      setErrorMsg("连接已断开，请重新连接发送方。");
      setState(TransferState.ERROR);
      if (onNotification) onNotification("连接已断开，请重试", 'error');
    };

    try {
      resetStateForNewTransfer();
      if (metadataRef.current?.files) {
        receivedFileManifestRef.current.seedFromMetadata(metadataRef.current.files);
      }
      isTransferActiveRef.current = true;
      preparedNativeWriterFileIndexRef.current = null;
      nativeFileHandleRef.current = null;
      const multiFileResolution = resolveMultiFileSaveMode({
        fileCount: metadataRef.current?.files?.length ?? 0,
        isIOS,
        isSafari,
        supportsDirectoryPicker: typeof window.showDirectoryPicker === 'function',
        supportsArchiveExport: (metadataRef.current?.files?.length ?? 0) > 1,
      });
      multiFileSaveModeRef.current = multiFileResolution.mode;

      if (multiFileResolution.shouldPromptForDirectory && window.showDirectoryPicker) {
        const rememberedHandle = await sessionDirectoryHandleCacheRef.current.getReusableHandle();
        if (!getLiveConnection()) {
          abortAcceptedTransfer();
          return;
        }

        if (rememberedHandle) {
          directorySaveSessionRef.current.attachRootDirectory(rememberedHandle);
          multiFileSaveModeRef.current = 'directory-direct';
          if (onNotification) {
            onNotification('继续使用当前会话已授权的保存目录。', 'info');
          }
        } else {
          try {
            const directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            sessionDirectoryHandleCacheRef.current.remember(directoryHandle);
            void persistedDirectoryHandleRef.current.save(directoryHandle);
            directorySaveSessionRef.current.attachRootDirectory(directoryHandle);
            multiFileSaveModeRef.current = 'directory-direct';
            if (onNotification) {
              onNotification('已选择保存目录，将按原始目录结构直接写入。', 'success');
            }
          } catch {
            multiFileSaveModeRef.current = multiFileResolution.supportsArchiveExport
              ? 'archive-export'
              : 'per-file-save-queue';
            if (onNotification) {
              onNotification('未授予目录保存权限，将回退到浏览器导出模式。', 'info');
            }
          }

          if (!getLiveConnection()) {
            abortAcceptedTransfer();
            return;
          }
        }
      }

      if (
        !isIOS &&
        !isSafari &&
        !!window.showSaveFilePicker &&
        (metadataRef.current?.files?.length ?? 0) === 1
      ) {
        const suggestedName = sanitizeFileName(
          metadataRef.current?.files?.[0]?.name || `file_${Date.now()}.bin`
        );
        try {
          nativeFileHandleRef.current = await window.showSaveFilePicker({
            suggestedName,
          });
          if (onNotification) {
            onNotification("已启用原生流式写入模式。", 'info');
          }
        } catch {
          nativeFileHandleRef.current = null;
          if (onNotification) {
            onNotification("未授予本地保存权限，将回退到备用保存模式。", 'info');
          }
        }

        if (!getLiveConnection()) {
          abortAcceptedTransfer();
          return;
        }
      } else if (isIOS || isSafari) {
          isStreamingRef.current = false;
          if (onNotification) onNotification("iOS 模式：文件将在传输完成后导出保存", 'info');
      } else if (onNotification) {
          if ((metadataRef.current?.files?.length ?? 0) > 1 && multiFileSaveModeRef.current === 'archive-export') {
            onNotification("当前浏览器将先稳定接收，再自动打包导出。", 'info');
          } else {
            onNotification("当前将优先尝试流式写入备用模式；若不可用则回退到浏览器保存。", 'info');
          }
      }

      const liveConn = getLiveConnection();
      if (!liveConn) {
        abortAcceptedTransfer();
        return;
      }

      const { overallTransferredBytes } = getOverallTransferSnapshot();
      lastDurableProgressBytesRef.current = overallTransferredBytes;
      lastDurableProgressAtRef.current = Date.now();
      stalledReconnectAttemptsRef.current = 0;
      stallRecoveryBaselineBytesRef.current = overallTransferredBytes;
      const checkpointResume = resumeCheckpointRef.current;
      // 多文件的检查点只在「目录直写」下可信：刷新后已完成的文件仍以真实文件形式存在。
      // 归档 / 逐个保存模式下这些字节只存在于内存，续传等于承诺一个不存在的前缀，
      // 此时宁可整批重新下载（文件索引 0 不受影响）。
      const canResumeFromCheckpoint = Boolean(
        checkpointResume &&
          (checkpointResume.fileIndex === 0 || multiFileSaveModeRef.current === 'directory-direct'),
      );
      if (
        checkpointResume &&
        canResumeFromCheckpoint &&
        checkpointResume.metadataFingerprint === metadataResumeFingerprintRef.current
      ) {
        // 刷新/重新进入后的续传：不发 ACCEPT_TRANSFER，改由协调器按检查点偏移发 RESUME_REQUEST。
        // 刷新发生在多文件传输的后续文件时，前面那些文件已经落盘完成，但内存里的
        // 完成集合是空的：不补回来，发送端的信用基线（前面文件大小 + 本文件偏移）
        // 会远高于我们上报的进度，信用窗口补不满、传输卡死，最终落盘数也校验不过。
        restoreCompletedFilesForResume(
          {
            checkpointFileIndex: checkpointResume.fileIndex,
            files: metadataRef.current?.files ?? [],
            markCompleted: (fileIndex, fileSize, directSaved) => {
              completedFileIndicesRef.current.add(fileIndex);
              receivedFileManifestRef.current.markCompleted({
                fileIndex,
                bytesReceived: fileSize,
                bytesPersisted: fileSize,
                ...(directSaved ? { saveState: 'direct-saved' as const } : {}),
              });
            },
          },
          { directSaved: multiFileSaveModeRef.current === 'directory-direct' },
        );
        currentFileIndexRef.current = checkpointResume.fileIndex;
        setState(TransferState.TRANSFERRING);
        setReconnectAttempt(0);
        resumeTransfer();
        return;
      }

      try {
        liveConn.send({
          type: 'ACCEPT_TRANSFER',
          payload: {
            persistedOverallBytes: overallTransferredBytes,
            receiveWindowBytes: TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES,
          },
        });
      } catch {
        abortAcceptedTransfer();
        return;
      }
      lastProgressAckBytesRef.current = overallTransferredBytes;
      setState(TransferState.TRANSFERRING);
      setReconnectAttempt(0);
    } finally {
      acceptingRef.current = false;
    }
  };

  const resumeTransfer = () => {
      const { overallTransferredBytes } = getOverallTransferSnapshot();
      lastDurableProgressBytesRef.current = overallTransferredBytes;
      lastDurableProgressAtRef.current = Date.now();
      stalledReconnectAttemptsRef.current = 0;
      stallRecoveryBaselineBytesRef.current = overallTransferredBytes;
      void receiveRecoveryCoordinator.resumeTransfer();
  };

  const reset = () => {
    const resetActivityToken = receiverActivityTrackerRef.current.begin();
    isStreamingRef.current = false;
    isTransferActiveRef.current = false;
    happyEyeballsWonRef.current = false;
    clearConnectionTimeout();
    clearHeartbeatTimer();
    clearProgressAckTimer();
    clearCommittedReconnectTimer();
    backgroundTimeoutGroupRef.current.clearAll();
    resetRouteAttemptState();
    pendingCommittedReconnectResumeRef.current = false;
    forceRelayOnCommittedReconnectRef.current = false;
    lastDurableProgressAtRef.current = 0;
    lastDurableProgressBytesRef.current = 0;
    stalledReconnectAttemptsRef.current = 0;
    stallRecoveryBaselineBytesRef.current = 0;
    const previousSessionId = receiverSessionIdRef.current;
    const closingConn = connRef.current;
    const closingPeer = peerRef.current;
    const closingRelayPeer = relayPeerRef.current;
    connRef.current = null;
    peerRef.current = null;
    relayPeerRef.current = null;
    
    abortStreams().then(() => {
        deleteIndexedDbChunksForSession(previousSessionId).catch(() => {});
        if (closingConn) {
          markIntentionalConnectionClose(closingConn);
          closingConn.close();
        }
        if (closingPeer) closingPeer.destroy();
        if (closingRelayPeer) {
          try { closingRelayPeer.destroy(); } catch {}
        }
        if (!receiverActivityTrackerRef.current.isCurrent(resetActivityToken)) {
          return;
        }
        setMetadata(null);
        setCode('');
        setState(TransferState.IDLE);
        setErrorMsg('');
        setConnectingStage('');
        setReconnectAttempt(0);
        setProgress(0);
        setDownloadSpeedBytes(0);
        setSenderDeviceName('');
        indexedDbNotifiedRef.current = false;
        nativeFileHandleRef.current = null;
        committedReconnectAttemptsRef.current = 0;
        rotateSessionId();
        resetStateForNewTransfer();
        metadataChunkBufferRef.current = null;
    });
  };

  
  const handleRetry = () => { if (isValidShareCode(code)) handleConnect(); else reset(); };
  const handleDigitClick = (digit: string) => { if (code.length < 6) setCode(prev => prev + digit); };
  const handleBackspace = () => { setCode(prev => prev.slice(0, -1)); };
  const handleClear = () => { setCode(''); };
  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (/^\d{4}$/.test(text)) {
        setCode(text);
        return;
      }
      const match = text.match(/[?&]code=(\d{4})(?:&|$)/);
      if (match) {
        setCode(match[1]);
        return;
      }
      if (onNotification) onNotification("剪贴板中未找到 6 位口令", 'info');
    } catch {
      if (onNotification) onNotification("无法读取剪贴板，请手动输入口令", 'info');
    }
  };

  const primaryFile = metadata?.files?.[0];
  const isMultiFile = (metadata?.files?.length || 0) > 1;
  const selectedFiles = (metadata?.files ?? []).map((file) => ({
    name: file.name,
    size: file.size,
    fileType: resolveFileType({
      fileName: file.name,
      mimeType: file.type,
    }),
  }));
  const primaryFileType =
    !isMultiFile && primaryFile
      ? resolveFileType({
          fileName: primaryFile.name,
          mimeType: primaryFile.type,
        })
      : null;
  const formatEta = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--';
    if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
    return `${Math.ceil(seconds / 3600)} 小时`;
  };
  const totalBytes = metadata?.totalSize ?? 0;
  const completedBytes = metadata?.files.reduce((acc, file, idx) => {
    return acc + (completedFileIndicesRef.current.has(idx) ? file.size : 0);
  }, 0) ?? 0;
  const currentFileBytes = (() => {
    if (!metadata) return 0;
    const idx = currentFileIndexRef.current;
    if (idx < 0 || idx >= metadata.files.length) return 0;
    if (completedFileIndicesRef.current.has(idx)) return 0;
    return Math.min(receivedSizeRef.current, metadata.files[idx].size);
  })();
  const overallTransferredBytes = Math.min(totalBytes, completedBytes + currentFileBytes);
  const overallRemainingBytes = Math.max(0, totalBytes - overallTransferredBytes);
  const overallEta = downloadSpeedBytes > 0 ? formatEta(overallRemainingBytes / downloadSpeedBytes) : '--';


  return (
    <ReceiverUI
      state={state}
      code={code}
      inputRef={inputRef}
      isMobileDevice={isMobileDevice}
      onCodeChange={(value) => setCode(normalizeShareCodeInput(value))}
      onDigitClick={handleDigitClick}
      onPasteFromClipboard={handlePasteFromClipboard}
      onBackspace={handleBackspace}
      onClear={handleClear}
      connectingStage={connectingStage}
      reconnectAttempt={reconnectAttempt}
      onReset={reset}
      metadata={metadata}
      senderDeviceName={senderDeviceName}
      isMultiFile={isMultiFile}
      selectedFiles={selectedFiles}
      showFileList={showFileList}
      onToggleFileList={() => setShowFileList((prev) => !prev)}
      primaryFileName={primaryFile?.name}
      primaryFileType={primaryFileType}
      canResume={canResume}
      isStreaming={isStreamingRef.current}
      onResumeTransfer={resumeTransfer}
      onAcceptTransfer={acceptTransfer}
      progress={progress}
      downloadSpeed={downloadSpeed}
      eta={eta}
      overallTransferredBytes={overallTransferredBytes}
      totalBytes={totalBytes}
      overallEta={overallEta}
      errorMsg={errorMsg}
      onRetry={handleRetry}
    />
  );
};






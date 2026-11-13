import type { FileCompletePayload, FileStartPayload } from '../../types';
import { DEFAULT_MAX_PREFIX_CRC_BYTES, computePrefixCrc32 } from './prefixCrc';
import { TRANSFER_CONFIG } from '../../constants/transfer';
import type { DataConnection } from '../peerRuntime';
import { createCrc32Hasher } from '../crc32WorkerClient';
import {
  DataChannelDrainTimeoutError,
  isDataChannelMessageTooLargeError,
  resolveDataChannelChunkSize,
  resolveSharedBufferLimits,
  waitForDataChannelDrain,
} from '../transfer/DataChannelTransmitter';
import { StreamingFileChunkReader } from '../transfer/StreamingFileChunkReader';
import { deriveAdaptiveFlow, type AdaptiveFlowProfile } from '../transfer/adaptiveFlow';
import { isSendSequenceCurrent, ReceiveCreditGate, ReceiveCreditTimeoutError } from './receiveCredit';
import { logDebug } from '../diagnostics';
import { markSessionEvent, type ConnectionSession } from '../connectionTelemetry';
import { getTotalFileBytes } from './transferOffsets';

/**
 * 发送端按 peer 维护的传输状态。原来是 components/Sender.tsx 里的一组 ref，
 * 抽出来作为显式依赖交给传输循环，便于用假 conn / 假 peer 单测重试与取消路径。
 */
export interface SendSequenceState {
  peerTransferEpoch: Map<string, number>;
  activeSendingPeers: Set<string>;
  activeSendConn: Map<string, DataConnection>;
  pendingSendPeers: Set<string>;
  activeConnections: Set<DataConnection>;
  peerAdaptiveFlow: Map<string, AdaptiveFlowProfile>;
  peerNegotiatedChunkCap: Map<string, number>;
  peerReceiveCredit: Map<string, ReceiveCreditGate>;
  peerHasProgressSync: Set<string>;
  peerSyncStartAt: Map<string, number>;
  peerSyncBaseBytes: Map<string, number>;
  peerProgress: Map<string, number>;
  peerRealtimeSpeed: Map<string, number>;
  peerAverageSpeed: Map<string, number>;
  peerTransferredBytes: Map<string, number>;
  peerTotalBytes: Map<string, number>;
  peerAwaitingFinalizeAck: Set<string>;
}

export interface SendFileSequenceDeps {
  conn: DataConnection;
  files: ReadonlyArray<File>;
  startFileIndex?: number;
  startByteOffset?: number;
  peerEpoch?: number;
  /** 启动本序列时捕获的会话代号；会话换代后旧序列必须退出。 */
  sessionId: number;
  /** 读取当前会话代号（每次检查都要读最新值）。 */
  getSessionId: () => number;
  state: SendSequenceState;
  decodeFileName: (name: string) => string;
  notify: (message: string, type: 'success' | 'info' | 'error') => void;
  refreshConnectionStats: (conn: DataConnection) => void;
  setCurrentFileIndex: (index: number) => void;
  getTelemetry: () => ConnectionSession | null;
  getPeerName: (peerId: string) => string | undefined;
  incrementActiveTransfers: () => void;
  decrementActiveTransfers: () => void;
}

/**
 * 把 fileList 从 (startFileIndex, startByteOffset) 起发给单个接收端。
 *
 * 这里集中了传输的「路由/重试/连接生命周期」：
 * - 同 peer 的序列用 epoch 互相顶替，旧序列在每个检查点自行退出；
 * - 分片大小按自适应 flow 与真实协商上限取小，被拒后从同一偏移换小片重试；
 * - 信用等待超时只在连接确实停滞时才失败，ICE restart 期间持续重试；
 * - 退出时按本序列自己的归属守卫清理 active/sending 集合与进行中计数。
 */
export const runSendFileSequence = async (deps: SendFileSequenceDeps): Promise<void> => {
  const {
    conn,
    files,
    startFileIndex = 0,
    startByteOffset = 0,
    peerEpoch = 0,
    state,
    sessionId: currentSessionId,
  } = deps;

  if (!files.length) return;

  // If a newer sequence was already scheduled for this peer, bail out.
  if (state.peerTransferEpoch.get(conn.peer) !== peerEpoch) return;

  // Wait for any previous sequence to finish exiting (it will detect the
  // epoch bump and return soon).  Re-check our own epoch each iteration so
  // we also bail if yet another sequence is scheduled while we wait.
  let waitAttempts = 0;
  while (state.activeSendingPeers.has(conn.peer)) {
    await new Promise((r) => setTimeout(r, 50));
    waitAttempts++;
    // 旧序列持有的连接已经不可用：它剩下的写入/等待必然失败并很快退出，没必要再等
    // 满 6s。重连时旧连接几乎总是已经关闭，这能把每次重连的空窗从秒级压到毫秒级。
    const previousConn = state.activeSendConn.get(conn.peer);
    if (!previousConn || !previousConn.open) {
      logDebug('warn', 'send sequence took over a dead previous loop', {
        peerId: conn.peer,
        waitAttempts,
      });
      // 只释放活动集合，不要取消信用闸门：此刻地图里已经是本次新序列的闸门。
      state.activeSendingPeers.delete(conn.peer);
      state.activeSendConn.delete(conn.peer);
      break;
    }
    if (waitAttempts > 120) {
      // Safety cap — clean up pending since this attempt failed.
      logDebug('warn', 'send sequence gave up waiting for a live previous loop', { peerId: conn.peer });
      state.pendingSendPeers.delete(conn.peer);
      return;
    }
    if (state.peerTransferEpoch.get(conn.peer) !== peerEpoch) return;
    // ^ Newer epoch scheduled — that sequence owns the pending entry.
    if (!conn.open) {
      // Connection dead — clean up pending.
      state.pendingSendPeers.delete(conn.peer);
      return;
    }
  }

  // Transition from pending → active now that the previous sequence exited.
  state.pendingSendPeers.delete(conn.peer);
  state.activeSendingPeers.add(conn.peer);
  state.activeSendConn.set(conn.peer, conn);

  deps.incrementActiveTransfers();

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
  state.peerAdaptiveFlow.set(conn.peer, defaultFlow);
  const READ_BUFFER_SIZE = TRANSFER_CONFIG.READ_BUFFER_SIZE;
  deps.refreshConnectionStats(conn);

  let totalBytesSent = 0;
  let sendCompleted = false;
  let lastBufferedAmount = 0;
  let lastUpdateTime = Date.now();
  let bytesInLastPeriod = 0;
  const startTime = Date.now();

  const peerId = conn.peer;
  state.peerHasProgressSync.delete(peerId);
  state.peerSyncStartAt.delete(peerId);
  state.peerSyncBaseBytes.delete(peerId);
  state.peerProgress.set(peerId, 0);
  state.peerTransferredBytes.set(peerId, 0);

  for (let i = 0; i < startFileIndex; i++) {
    totalBytesSent += files[i].size;
  }
  if (startByteOffset > 0) {
    totalBytesSent += startByteOffset;
  }

  const totalSize = getTotalFileBytes(files);

  const dataChannel = conn.dataChannel ?? undefined;
  const receiveCredit = state.peerReceiveCredit.get(peerId);
  const fileHasher = createCrc32Hasher(`sender-${peerId}`);
  const adaptiveTimer = setInterval(() => {
    if (deps.getSessionId() !== currentSessionId || !conn.open) {
      clearInterval(adaptiveTimer);
      return;
    }
    deps.refreshConnectionStats(conn);
  }, 2000);

  try {
    if (!receiveCredit) {
      throw new Error('Receive credit was not initialized');
    }
    if (receiveCredit.snapshot().sentOverallBytes !== totalBytesSent) {
      throw new Error('Resume offset does not match initialized receive credit');
    }
    let fileStartByteOffset = startByteOffset;
    const isCurrentSequence = () =>
      isSendSequenceCurrent(
        deps.getSessionId(),
        currentSessionId,
        state.peerTransferEpoch.get(peerId),
        peerEpoch,
        conn.open,
      );

    for (let i = startFileIndex; i < files.length; i++) {
      if (deps.getSessionId() !== currentSessionId || state.peerTransferEpoch.get(peerId) !== peerEpoch) return;
      if (!conn.open) throw new Error('Connection closed');

      if (state.activeConnections.size === 1) {
        deps.setCurrentFileIndex(i);
      }

      const file = files[i];
      const fName = file.fullPath || (file as any).webkitRelativePath || file.name;

      let fileOffset = i === startFileIndex ? Math.min(Math.max(0, fileStartByteOffset), file.size) : 0;
      fileStartByteOffset = 0;

      // 续传时把已落盘前缀的 CRC 一起发过去，接收端才能验证磁盘上的旧数据没被截断。
      const startPayload: FileStartPayload = {
        fileIndex: i,
        fileName: deps.decodeFileName(fName),
        fileSize: file.size,
        fileType: file.type,
      };
      if (fileOffset > 0) {
        startPayload.resumeOffset = fileOffset;
        if (fileOffset <= DEFAULT_MAX_PREFIX_CRC_BYTES) {
          startPayload.prefixCrc32 = await computePrefixCrc32(file, fileOffset);
        }
      }
      try {
        conn.send({ type: 'FILE_START', payload: startPayload });
      } catch (e) {
        throw new Error('Failed to send FILE_START');
      }
      const hashStartOffset = fileOffset;
      await fileHasher.reset();
      if (!isCurrentSequence()) return;
      let hashedBytes = 0;
      let chunkReader = new StreamingFileChunkReader(file, READ_BUFFER_SIZE, fileOffset);

      while (fileOffset < file.size) {
        if (deps.getSessionId() !== currentSessionId || state.peerTransferEpoch.get(peerId) !== peerEpoch) return;
        if (!conn.open) throw new Error('Connection closed during transfer');

        const flow = state.peerAdaptiveFlow.get(peerId) || defaultFlow;
        const negotiatedCap = state.peerNegotiatedChunkCap.get(peerId);
        const maxChunkSize = Math.min(
          resolveDataChannelChunkSize(flow.chunkSize, conn.peerConnection.sctp?.maxMessageSize),
          negotiatedCap ?? Number.POSITIVE_INFINITY,
        );
        if (dataChannel) {
          // 多个接收端并发时共享一份在途预算，避免 N 条连接各自
          // 按满 HWM 排队把发送端上行缓冲推高到 N 倍。只统计真正在
          // 发数据的连接：竞速失败侧与空闲连接不应稀释预算。
          const bufferLimits = resolveSharedBufferLimits(flow, state.activeSendingPeers.size);
          await waitForDataChannelDrain(conn, dataChannel, bufferLimits);
          if (!isCurrentSequence()) return;
        }

        let availableCredit: number;
        for (;;) {
          try {
            availableCredit = await receiveCredit.waitForAvailable(
              Math.min(maxChunkSize, file.size - fileOffset),
              TRANSFER_CONFIG.PROGRESS_STALL_TIMEOUT_MS,
            );
            break;
          } catch (error) {
            if (!isCurrentSequence()) return;
            // ICE restart / 宽限期间接收端没有新信用是预期的：此时关连接会把
            // 一次可自愈的抖动报成“12 秒无响应”。连接已关闭或已恢复 connected
            // 时才说明真的停滞，交给外层处理。
            if (
              error instanceof ReceiveCreditTimeoutError &&
              conn.open &&
              conn.peerConnection.connectionState !== 'connected'
            ) {
              continue;
            }
            throw error;
          }
        }
        if (!isCurrentSequence()) return;
        let nextChunk = await chunkReader.readNextChunk(Math.min(availableCredit, maxChunkSize));
        if (!isCurrentSequence()) return;
        let chunkView = nextChunk.chunk;
        if (!chunkView) {
          break;
        }

        // 个别浏览器/中间设备会把协商上限报高。发送被拒时从同一偏移
        // 换小片重读，而不是把整条连接判死再走一遍注定失败的重连。
        let tooLargeRetries = 0;
        for (;;) {
          try {
            if (!isCurrentSequence()) return;
            conn.send(chunkView);
            break;
          } catch (e) {
            if (!conn.open) throw new Error('Connection closed during send');
            if (!isDataChannelMessageTooLargeError(e)) throw e;
            if (tooLargeRetries >= 3 || chunkView.byteLength <= TRANSFER_CONFIG.MIN_CHUNK_SIZE) {
              throw new Error(
                `Negotiated data-channel message limit rejected ${chunkView.byteLength} bytes at the 16 KiB fallback`,
                { cause: e },
              );
            }
            tooLargeRetries += 1;
            const retrySize = Math.max(TRANSFER_CONFIG.MIN_CHUNK_SIZE, Math.floor(chunkView.byteLength / 2));
            chunkReader = new StreamingFileChunkReader(
              file,
              Math.min(READ_BUFFER_SIZE, Math.max(retrySize * 2, TRANSFER_CONFIG.MIN_CHUNK_SIZE * 2)),
              nextChunk.fileOffset,
            );
            nextChunk = await chunkReader.readNextChunk(Math.min(retrySize, availableCredit));
            chunkView = nextChunk.chunk;
            if (!chunkView) break;
          }
        }
        if (!chunkView) break;

        const currentChunkSize = chunkView.byteLength;
        if (tooLargeRetries > 0) {
          // 记住这条连接实际接受的尺寸，后续 chunk 直接从该上限开始读。
          const knownCap = state.peerNegotiatedChunkCap.get(peerId);
          state.peerNegotiatedChunkCap.set(
            peerId,
            Math.min(knownCap ?? currentChunkSize, currentChunkSize),
          );
        }
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

            const hasProgressSync = state.peerHasProgressSync.has(peerId);
            if (!hasProgressSync) {
              state.peerRealtimeSpeed.set(peerId, effectiveSpeed);
              state.peerAverageSpeed.set(peerId, realTotal / totalDuration);
              if (totalSize > 0) {
                const p = Math.min(99, Math.floor((realTotal / totalSize) * 100));
                state.peerProgress.set(peerId, p);
              }
              state.peerTotalBytes.set(peerId, totalSize);
              state.peerTransferredBytes.set(peerId, Math.max(0, Math.min(totalSize, realTotal)));
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
      try {
        conn.send({ type: 'FILE_COMPLETE', payload: completePayload });
      } catch (e) {}
    }

    try {
      conn.send({ type: 'ALL_FILES_COMPLETE' });
    } catch (e) {}

    sendCompleted = true;
    state.peerAwaitingFinalizeAck.add(peerId);
    state.peerProgress.set(peerId, 99);
    state.peerRealtimeSpeed.set(peerId, 0);
  } catch (err) {
    if (deps.getSessionId() === currentSessionId && state.peerTransferEpoch.get(peerId) === peerEpoch) {
      console.warn(`Transfer to ${peerId} interrupted/failed:`, err);
      const remoteName = deps.getPeerName(conn.peer) || `设备 ...${conn.peer.slice(-4)}`;
      if (err instanceof ReceiveCreditTimeoutError || err instanceof DataChannelDrainTimeoutError) {
        // 接收端可能已冻结/被杀：它自己的重连计时器也停了，不能承诺“等待重连”。
        // 断开这条连接让发送端回到可重试状态，由用户决定重试或取消。
        markSessionEvent(deps.getTelemetry(), 'send_stalled_timeout', {
          peerId,
          timeoutMs: err.timeoutMs,
          stage: err instanceof ReceiveCreditTimeoutError ? 'credit' : 'drain',
        });
        deps.notify(
          `${remoteName} 超过 ${Math.round(err.timeoutMs / 1000)} 秒没有响应，已断开连接，可重试或取消`,
          'error',
        );
      } else {
        deps.notify(`${remoteName} 传输中断，等待重连后可继续`, 'error');
      }

      if (conn.open) {
        conn.close();
      }
    }
  } finally {
    fileHasher.terminate();
    clearInterval(adaptiveTimer);
    // 只清理本序列仍然拥有的标记：重连时新序列可能在旧循环退出前就接管（死连接不再
    // 等 6s），无条件删除会把新序列的所有权抹掉，随后一次 open 就会再起一个并发发送
    // 循环，接收端会看到重复分片与 hash 不匹配。
    if (state.activeSendConn.get(peerId) === conn) {
      state.activeSendingPeers.delete(peerId);
      state.activeSendConn.delete(peerId);
    }
    // 计数必须按本序列自己的 +1 归还，不能放进上面的归属守卫：接管分支会把地图换成
    // 新序列，旧序列退出时守卫为假，这次 +1 就永远还不回去（UI 停 100% 仍显示「正在
    // 发送…」，完成 toast 也被抑制）。
    if (deps.getSessionId() === currentSessionId && !sendCompleted) {
      deps.decrementActiveTransfers();
    }
  }
};

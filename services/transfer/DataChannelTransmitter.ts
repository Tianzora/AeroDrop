import type { DataConnection } from '../peerRuntime';
import { FLOW_CONTROL } from '../../constants/transfer';

type FlowControlConfig = {
  highWaterMark: number;
  lowWaterMark: number;
};

export const DEFAULT_SAFE_DATA_CHANNEL_MESSAGE_SIZE = 64 * 1024;

const BUFFER_DRAIN_TIMEOUT_MS = 30_000;
const BUFFER_DRAIN_MAX_TIMEOUT_MS = 90_000;
const BUFFER_DRAIN_PROGRESS_INTERVAL_MS = 5_000;
const BUFFER_DRAIN_POLL_INTERVAL_MS = 100;

export const resolveDataChannelChunkSize = (
  routeChunkCap: number,
  maxMessageSize?: number | null,
) => {
  const negotiatedLimit = maxMessageSize === Number.POSITIVE_INFINITY
    ? routeChunkCap
    : typeof maxMessageSize === 'number' && Number.isFinite(maxMessageSize) && maxMessageSize > 0
      ? Math.floor(maxMessageSize)
      : DEFAULT_SAFE_DATA_CHANNEL_MESSAGE_SIZE;

  return Math.max(1, Math.min(Math.floor(routeChunkCap), negotiatedLimit));
};

export const isDataChannelMessageTooLargeError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return error.name === 'TypeError'
    || /message.{0,20}(too large|size)|maxmessagesize|sctp/i.test(error.message);
};

/** 数据通道长时间排不空：对端冻结/主线程阻塞，或链路已不可用。 */
export class DataChannelDrainTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, detail: string) {
    super(`Backpressure drain timeout (${timeoutMs}ms): ${detail}`);
    this.name = 'DataChannelDrainTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const isTransportUnavailable = (
  conn: DataConnection,
  dataChannel: RTCDataChannel,
  peerConnection?: RTCPeerConnection,
) => {
  const pcState = peerConnection?.connectionState;
  return (
    !conn.open ||
    dataChannel.readyState !== 'open' ||
    pcState === 'closed' ||
    pcState === 'failed'
  );
};

/**
 * 每个接收端连接原本各自使用 route 级 HWM。N 个接收端同时拉取时，发送端
 * 的在途缓冲会变成 N 倍。这里按活跃连接数把共享预算均分，并保证 low < high。
 */
export const resolveSharedBufferLimits = (
  flow: FlowControlConfig,
  activeReceivers: number,
  chunkSize: number = DEFAULT_SAFE_DATA_CHANNEL_MESSAGE_SIZE,
): FlowControlConfig => {
  const receivers = Math.max(1, Math.floor(activeReceivers));
  const sharedHighWaterMark = Math.floor(FLOW_CONTROL.TOTAL_UPLINK_BUFFER_BYTES / receivers);
  // 连接数很大时均分会退化成停等式，至少保留 4 个 chunk 的在途窗口。
  const minimumHighWaterMark = Math.max(1, Math.floor(chunkSize) * 4);
  const highWaterMark = Math.max(
    minimumHighWaterMark,
    Math.min(flow.highWaterMark, sharedHighWaterMark),
  );
  const lowWaterMark = Math.min(flow.lowWaterMark, Math.floor(highWaterMark / 2));
  return { highWaterMark, lowWaterMark };
};

export const waitForDataChannelDrain = async (
  conn: DataConnection,
  dataChannel: RTCDataChannel,
  flow: FlowControlConfig,
) => {
  if (dataChannel.bufferedAmount <= flow.highWaterMark) {
    return;
  }

  dataChannel.bufferedAmountLowThreshold = flow.lowWaterMark;
  const peerConnection = conn.peerConnection;

  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const maxDeadline = startedAt + BUFFER_DRAIN_MAX_TIMEOUT_MS;
    let deadline = startedAt + BUFFER_DRAIN_TIMEOUT_MS;
    let lastBufferedAmount = dataChannel.bufferedAmount;
    let stalledWindows = 0;
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      dataChannel.removeEventListener('bufferedamountlow', onLow);
      dataChannel.removeEventListener('close', onClose);
      peerConnection?.removeEventListener('connectionstatechange', onConnectionStateChange);
    };

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const ensureDrainOrFail = () => {
      if (isTransportUnavailable(conn, dataChannel, peerConnection)) {
        finish(new Error(
          `Transport unavailable while waiting for buffer drain: dc=${dataChannel.readyState}, pc=${peerConnection?.connectionState ?? 'unknown'}`,
        ));
        return;
      }

      if (dataChannel.bufferedAmount <= flow.lowWaterMark) {
        finish();
      }
    };

    const checkProgressOrFail = () => {
      if (settled) {
        return;
      }
      ensureDrainOrFail();
      if (settled) {
        return;
      }

      const now = Date.now();
      const bufferedAmount = dataChannel.bufferedAmount;
      // 慢速链路只要还在排空就不算冻结：每个有进展的窗口都把截止时间顺延。
      if (bufferedAmount < lastBufferedAmount) {
        stalledWindows = 0;
        deadline = Math.min(maxDeadline, now + BUFFER_DRAIN_TIMEOUT_MS);
      } else {
        stalledWindows += 1;
      }
      lastBufferedAmount = bufferedAmount;

      if (bufferedAmount <= flow.lowWaterMark) {
        finish();
        return;
      }

      if (now >= deadline || stalledWindows >= 2) {
        finish(new DataChannelDrainTimeoutError(
          now - startedAt,
          `buffered=${bufferedAmount}, high=${flow.highWaterMark}, low=${flow.lowWaterMark}, dc=${dataChannel.readyState}, pc=${peerConnection?.connectionState ?? 'unknown'}`,
        ));
      }
    };

    const onLow = () => ensureDrainOrFail();
    const onClose = () => finish(new Error('Data channel closed while waiting for buffer drain'));
    const onConnectionStateChange = () => ensureDrainOrFail();

    dataChannel.addEventListener('bufferedamountlow', onLow);
    dataChannel.addEventListener('close', onClose);
    peerConnection?.addEventListener('connectionstatechange', onConnectionStateChange);
    pollTimer = setInterval(ensureDrainOrFail, BUFFER_DRAIN_POLL_INTERVAL_MS);
    progressTimer = setInterval(checkProgressOrFail, BUFFER_DRAIN_PROGRESS_INTERVAL_MS);

    ensureDrainOrFail();
  });
};

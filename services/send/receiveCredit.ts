import { TRANSFER_CONFIG } from '../../constants/transfer.ts';
import { logDebug } from '../diagnostics.ts';

export const shouldReleasePeerState = (
  closingConnectionId: string | undefined,
  currentOwnerId: string | undefined,
  hasReplacementConnection: boolean,
) => !hasReplacementConnection && (!currentOwnerId || currentOwnerId === closingConnectionId);

export const isSendSequenceCurrent = (
  currentSessionId: number,
  expectedSessionId: number,
  currentEpoch: number | undefined,
  expectedEpoch: number,
  connectionOpen: boolean,
) => connectionOpen && currentSessionId === expectedSessionId && currentEpoch === expectedEpoch;

type CreditWaiter = {
  maxBytes: number;
  resolve: (availableBytes: number) => void;
  reject: (error: Error) => void;
};

const assertOffset = (name: string, value: number, max: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
};

const assertWindow = (value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > TRANSFER_CONFIG.MAX_PENDING_WRITE_BYTES) {
    throw new Error(`receiveWindowBytes must be an integer between 1 and ${TRANSFER_CONFIG.MAX_PENDING_WRITE_BYTES}`);
  }
};

export class ReceiveCreditGate {
  private sentOverallBytes: number;
  private persistedOverallBytes: number;
  private receiveWindowBytes: number;
  private cancelledError: Error | null = null;
  private waiters: CreditWaiter[] = [];

  constructor(totalBytes: number, persistedOverallBytes: number, receiveWindowBytes: number) {
    assertOffset('totalBytes', totalBytes, Number.MAX_SAFE_INTEGER);
    assertOffset('persistedOverallBytes', persistedOverallBytes, totalBytes);
    assertWindow(receiveWindowBytes);
    this.totalBytes = totalBytes;
    this.sentOverallBytes = persistedOverallBytes;
    this.persistedOverallBytes = persistedOverallBytes;
    this.receiveWindowBytes = receiveWindowBytes;
  }

  readonly totalBytes: number;

  update(persistedOverallBytes: number, receiveWindowBytes: number, totalBytes: number) {
    if (totalBytes !== this.totalBytes) {
      throw new Error(`overallTotalBytes changed from ${this.totalBytes} to ${totalBytes}`);
    }
    assertOffset('persistedOverallBytes', persistedOverallBytes, this.sentOverallBytes);
    assertWindow(receiveWindowBytes);

    if (persistedOverallBytes < this.persistedOverallBytes) {
      // 接收端上报的是“已落盘字节”，口径会在文件 finalize 时从 committedBytes 切到 receivedSize，
      // 续传文件因此会短暂回退。这是统计口径问题，不是协议违规：抛错会让发送端直接关连接。
      // 这里 clamp 到已有值（信用只增不减），窗口仍按最新上报更新。
      logDebug('warn', '[receive-credit] persisted bytes regressed; keeping the higher value', {
        previous: this.persistedOverallBytes,
        reported: persistedOverallBytes,
      });
      this.receiveWindowBytes = receiveWindowBytes;
      this.releaseNextWaiter();
      return;
    }

    this.persistedOverallBytes = persistedOverallBytes;
    this.receiveWindowBytes = receiveWindowBytes;
    this.releaseNextWaiter();
  }

  waitForAvailable(maxBytes: number): Promise<number> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return Promise.reject(new Error('maxBytes must be a positive integer'));
    }
    if (this.cancelledError) {
      return Promise.reject(this.cancelledError);
    }

    const availableBytes = this.getAvailableBytes(maxBytes);
    if (availableBytes > 0) {
      return Promise.resolve(availableBytes);
    }

    return new Promise<number>((resolve, reject) => {
      this.waiters.push({ maxBytes, resolve, reject });
    });
  }

  recordSent(byteCount: number) {
    if (!Number.isSafeInteger(byteCount) || byteCount <= 0) {
      throw new Error('byteCount must be a positive integer');
    }
    const nextSentOverallBytes = this.sentOverallBytes + byteCount;
    if (nextSentOverallBytes > this.totalBytes) {
      throw new Error('sentOverallBytes exceeds totalBytes');
    }
    if (nextSentOverallBytes > this.persistedOverallBytes + this.receiveWindowBytes) {
      throw new Error('sentOverallBytes exceeds receive credit');
    }
    this.sentOverallBytes = nextSentOverallBytes;
  }

  cancel(reason: string | Error) {
    if (this.cancelledError) return;
    this.cancelledError = reason instanceof Error ? reason : new Error(reason);
    const waiters = this.waiters.splice(0);
    waiters.forEach((waiter) => waiter.reject(this.cancelledError!));
  }

  snapshot() {
    return {
      totalBytes: this.totalBytes,
      sentOverallBytes: this.sentOverallBytes,
      persistedOverallBytes: this.persistedOverallBytes,
      receiveWindowBytes: this.receiveWindowBytes,
    };
  }

  private getAvailableBytes(maxBytes: number) {
    return Math.max(0, Math.min(
      maxBytes,
      this.totalBytes - this.sentOverallBytes,
      this.persistedOverallBytes + this.receiveWindowBytes - this.sentOverallBytes,
    ));
  }

  private releaseNextWaiter() {
    const waiter = this.waiters[0];
    if (!waiter) return;
    const availableBytes = this.getAvailableBytes(waiter.maxBytes);
    if (availableBytes <= 0) return;
    this.waiters.shift();
    waiter.resolve(availableBytes);
  }
}

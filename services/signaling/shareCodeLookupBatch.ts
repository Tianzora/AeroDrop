import type { ShareCodeRecord } from '../shareCodeRegistry';

export type ShareCodeLookupKind = 'code' | 'peerId';

export type ShareCodeLookupRequest = {
  kind: ShareCodeLookupKind;
  value: string;
};

export type ShareCodeBatchRunner = (
  requests: readonly ShareCodeLookupRequest[]
) => Promise<readonly (ShareCodeRecord | null)[]>;

export type ShareCodeLookupBatcher = {
  /**
   * 排队一次口令查询。同一个窗口内的多次调用会被合并成一次批量请求，
   * 结果按调用顺序返回；批量请求失败时每个等待者都拿到同一个错误。
   */
  request(request: ShareCodeLookupRequest): Promise<ShareCodeRecord | null>;
  /** 还在等待窗口结束的请求数（测试与观测用）。 */
  pendingCount(): number;
};

export type CreateShareCodeLookupBatcherOptions = {
  run: ShareCodeBatchRunner;
  /**
   * 把「执行一次 flush」推迟到本轮事件之后。Worker 里用 `setTimeout(fn, 0)`，
   * 测试里可以手动收集回调，从而在没有真实定时器的前提下覆盖合并行为。
   */
  defer: (flush: () => void) => unknown;
  /** 单批上限：达到后立即 flush，避免在高峰期攒出一个超大请求。 */
  maxBatchSize?: number;
};

/** 单批上限；worker 侧校验请求数组长度时也用它，避免两端各写一个数字。 */
export const SHARE_CODE_LOOKUP_BATCH_LIMIT = 64;

/**
 * 把并发到达的口令查询合并成一次跨 DO 请求。
 *
 * 为什么需要：分片模式下每次注册都要回 shard 0 查一次口令表（观众注册也查，
 * 用来判断 peerId 是否被某个仍在生效的分享口令占用）。六个人同时点开同一个
 * 分享链接就是六次 RPC，而这些查询几乎总在同一毫秒内发生。合并后一次 RPC 就能
 * 答复整批，shard 0 的读放大从「每注册一次」降到「每批一次」。
 *
 * 语义仍然是 fail closed：批量请求失败时每个等待者都会收到 reject，调用方按
 * 「查不到」处理，绝不放宽身份校验。
 */
export const createShareCodeLookupBatcher = ({
  run,
  defer,
  maxBatchSize = SHARE_CODE_LOOKUP_BATCH_LIMIT,
}: CreateShareCodeLookupBatcherOptions): ShareCodeLookupBatcher => {
  const limit = Math.max(1, Math.floor(maxBatchSize) || SHARE_CODE_LOOKUP_BATCH_LIMIT);
  let pending: { request: ShareCodeLookupRequest; resolve: (record: ShareCodeRecord | null) => void; reject: (error: unknown) => void }[] =
    [];
  // 已经排队但还没执行的那次 flush 的令牌。提前 flush（满批）会把令牌置空，
  // 于是旧回调醒来时发现自己已作废，不会把下一批提前发出去。
  let queuedFlushToken: number | null = null;
  let nextFlushToken = 0;

  const flush = (): void => {
    queuedFlushToken = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    let outcome: Promise<readonly (ShareCodeRecord | null)[]>;
    try {
      outcome = Promise.resolve(run(batch.map((entry) => entry.request)));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (records) => {
        // 结果必须与请求一一对应；长度不符按协议错误处理，不能错位返回别人的记录。
        if (records.length !== batch.length) {
          const error = new Error(
            `share-code batch returned ${records.length} records for ${batch.length} requests`
          );
          batch.forEach((entry) => entry.reject(error));
          return;
        }
        batch.forEach((entry, index) => entry.resolve(records[index] ?? null));
      },
      (error: unknown) => batch.forEach((entry) => entry.reject(error))
    );
  };

  const scheduleFlush = (): void => {
    if (queuedFlushToken !== null) return;
    const token = ++nextFlushToken;
    queuedFlushToken = token;
    defer(() => {
      if (queuedFlushToken !== token) return;
      flush();
    });
  };

  return {
    request(request) {
      return new Promise<ShareCodeRecord | null>((resolve, reject) => {
        pending.push({ request, resolve, reject });
        if (pending.length >= limit) {
          flush();
          return;
        }
        scheduleFlush();
      });
    },
    pendingCount: () => pending.length,
  };
};

/**
 * 观众侧：peer 层错误该走哪条路。
 *
 * 旧实现只有「peer-unavailable 就重连」一条规则，两个真实场景都判错了：
 *
 * 1) 分享者已经停止共享（或房号已撤销）：链接就是死的，peer-unavailable 会重连
 *    5 次（2/4/6/8/10s），最后给一句「已达到最大重试次数，请手动重试」——而这个
 *    手动重试永远不可能成功，用户只会在死链上反复点。终态应该是「分享已结束」，
 *    并且顺手清掉持久化的 viewId，别让下次打开站点又自动连一次。
 * 2) 同一出口（CGNAT/公司/校园）观众多、offer 被信令层限流：连接压根没建起来。
 *    旧实现把它归进「没画面就被关 → 疑似人数已满」，用户按提示反复重试，实际
 *    要等限流窗口过去。限流必须优先于满员推断：限流是「等一下就好」，满员是
 *    「等人走」，两种行动完全相反。
 *
 * 3) 分享端重建 peer 时会复用同一个房号，那几秒里观众拿到 peer-unavailable，
 *    但恢复完成后旧链接仍然有效。所以 peer-unavailable 不再一次判死：先有限重试
 *    （次数与间隔来自 constants/transfer.ts），仍失败才进终态，且终态文案只说
 *    「暂时不可用」，不宣称链接失效。
 */

export type ViewerPeerErrorInput = {
  type: string;
  /** 用户自己点了「取消连接 / 停止观看」。 */
  manualStop: boolean;
  /** 已经通过数据通道收到共享方的 share-ended。 */
  shareEnded: boolean;
  /** 信令层给的 Retry-After（毫秒）。目前 worker 还没下发，留给下发后直接生效。 */
  retryAfterMs?: number | null;
  /** 没有 Retry-After 时按出口配额的静默期兜底（constants/signaling.ts）。 */
  fallbackRetryAfterMs: number;
  /** 服务端标明的额度层级；`session` 是每出口会话数，等再久也没用。 */
  limit?: 'session' | 'offer' | null;
  /** 本次连接已经因为 peer-unavailable 重试过几次（调用方自己数）。 */
  shareUnavailableAttempts?: number;
  /** peer-unavailable 的有限重试次数上限；0 表示不重试直接终态。 */
  maxShareUnavailableRetries?: number;
};

export type ViewerPeerErrorPlan =
  | { kind: 'ignore' }
  | { kind: 'share-unavailable-retry' }
  | { kind: 'share-unavailable' }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'session-limit' }
  | { kind: 'report' };

const normalizeRetryAfter = (value: number | null | undefined, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1_000;
};

export const planViewerPeerError = ({
  type,
  manualStop,
  shareEnded,
  retryAfterMs,
  fallbackRetryAfterMs,
  limit,
  shareUnavailableAttempts = 0,
  maxShareUnavailableRetries = 0,
}: ViewerPeerErrorInput): ViewerPeerErrorPlan => {
  // 分享方主动结束 / 用户自己取消：都不是错误，交给调用方走各自的收尾。
  if (shareEnded || manualStop) return { kind: 'ignore' };
  // 分享者暂时查不到：分享端重建 Peer 期间同样会这样，先有限重试再下结论。
  if (type === 'peer-unavailable') {
    const attempts =
      Number.isFinite(shareUnavailableAttempts) && shareUnavailableAttempts > 0
        ? Math.floor(shareUnavailableAttempts)
        : 0;
    const maxRetries =
      Number.isFinite(maxShareUnavailableRetries) && maxShareUnavailableRetries > 0
        ? Math.floor(maxShareUnavailableRetries)
        : 0;
    return attempts < maxRetries ? { kind: 'share-unavailable-retry' } : { kind: 'share-unavailable' };
  }
  if (type === 'rate-limited') {
    // 每出口会话数被占满：倒计时和「稍后再试」都是错的，用户要关掉占名额的设备。
    if (limit === 'session') return { kind: 'session-limit' };
    return { kind: 'rate-limited', retryAfterMs: normalizeRetryAfter(retryAfterMs, fallbackRetryAfterMs) };
  }
  return { kind: 'report' };
};

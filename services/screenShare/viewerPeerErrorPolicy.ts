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
 * 代价说明：分享端重建 peer 的几秒窗口里，观众也可能收到 peer-unavailable。
 * 这时直接进终态、要求重新打开链接，比把死链包装成网络故障更可接受——真正还会
 * 回来的只有分享端的信令断线（peerRuntime 自己重连，不发这个错误）。
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
};

export type ViewerPeerErrorPlan =
  | { kind: 'ignore' }
  | { kind: 'share-gone' }
  | { kind: 'rate-limited'; retryAfterMs: number }
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
}: ViewerPeerErrorInput): ViewerPeerErrorPlan => {
  // 分享方主动结束 / 用户自己取消：都不是错误，交给调用方走各自的收尾。
  if (shareEnded || manualStop) return { kind: 'ignore' };
  // 链接指向一个不存在的分享者：重试没有意义，直接终态并清掉持久化会话。
  if (type === 'peer-unavailable') return { kind: 'share-gone' };
  if (type === 'rate-limited') {
    return { kind: 'rate-limited', retryAfterMs: normalizeRetryAfter(retryAfterMs, fallbackRetryAfterMs) };
  }
  return { kind: 'report' };
};

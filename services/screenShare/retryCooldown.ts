/**
 * 「还要等 N 秒才能重试」的通用换算。
 *
 * 两处用到：登记房号被限流（服务端 429 + Retry-After）、观众建连被 offer 限流
 * （信令层拒绝）。旧实现把 retryAfterMs 记下来就丢了，界面只剩一句「稍后再试」——
 * 按钮看起来坏了。这里把截止时间换算成界面能显示的剩余秒数，并明确回答「现在能不能点」。
 */

export interface RetryCooldown {
  /** 剩余整秒（向上取整，避免显示「0 秒」却仍然点不动）；不在冷却期为 null。 */
  secondsLeft: number | null;
  canRetry: boolean;
}

export const describeRetryCooldown = (
  retryAt: number | null,
  now: number,
): RetryCooldown => {
  if (retryAt === null || !Number.isFinite(retryAt)) return { secondsLeft: null, canRetry: true };
  const remaining = retryAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return { secondsLeft: null, canRetry: true };
  return { secondsLeft: Math.ceil(remaining / 1000), canRetry: false };
};

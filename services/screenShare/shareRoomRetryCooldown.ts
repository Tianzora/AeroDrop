/**
 * 登记被限流后的冷却。
 *
 * 服务端用 429 + Retry-After 告诉我们还要等多久，旧实现把它记进 retryAfterMs 就丢了，
 * 界面上只有一句「过于频繁，请稍后再试」——点「重新开始共享」会立刻再吃一次 429，
 * 看起来像按钮坏了。这里把它换算成界面能显示的剩余秒数，并明确回答「现在能不能点」。
 */

export interface ShareRoomRetryCooldown {
  /** 剩余整秒（向上取整，避免显示「0 秒」却仍然点不动）；不在冷却期为 null。 */
  secondsLeft: number | null;
  canRetry: boolean;
}

export const describeShareRoomRetryCooldown = (
  retryAt: number | null,
  now: number,
): ShareRoomRetryCooldown => {
  if (retryAt === null || !Number.isFinite(retryAt)) return { secondsLeft: null, canRetry: true };
  const remaining = retryAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return { secondsLeft: null, canRetry: true };
  return { secondsLeft: Math.ceil(remaining / 1000), canRetry: false };
};

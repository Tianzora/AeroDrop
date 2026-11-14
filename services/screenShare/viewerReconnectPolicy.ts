/**
 * 观众侧媒体断链的重连预算。
 *
 * 「已断链 → 等一会儿 → 重新建连」这条循环必须有一处统一的收支判定，否则每次重连
 * 成功开一次信令就把计数清零，ICE 反复失败时观众会永远停在「正在重试」，既看不到
 * 终态也没有重试按钮。
 */

export type ViewerReconnectPlan =
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'exhausted' };

export interface ViewerReconnectInput {
  /** 已经用掉的重连次数。 */
  attempts: number;
  maxAttempts: number;
  /** 第 n 次重连的等待 = base * n，线性递增；抖动期间不会因为指数退避等太久。 */
  baseDelayMs: number;
  maxDelayMs: number;
}

const toCount = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

export const planViewerReconnect = ({
  attempts,
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
}: ViewerReconnectInput): ViewerReconnectPlan => {
  const used = toCount(attempts, 0);
  const budget = toCount(maxAttempts, 0);
  if (used >= budget) return { kind: 'exhausted' };

  const attempt = used + 1;
  const base = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : 0;
  const cap = Number.isFinite(maxDelayMs) ? Math.max(0, maxDelayMs) : base * attempt;
  return { kind: 'retry', attempt, delayMs: Math.min(base * attempt, cap) };
};

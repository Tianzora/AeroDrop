import { UNKNOWN_SHARE_CODE_BUDGET } from '../../constants/signaling';
export { UNKNOWN_SHARE_CODE_BUDGET } from '../../constants/signaling';

// 固定窗口 + fail-closed：窗口内未命中次数用满后一律拒绝，直到窗口过期。
// 预算值定义在 constants/signaling.ts（与其它信令参数同一处）。

export type UnknownShareCodeBudgetOptions = {
  maxMisses: number;
  windowMs: number;
};

export type UnknownShareCodeBudgetDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

export type UnknownShareCodeBudget = {
  /** 记一次未命中并返回本次是否放行。 */
  consume(now: number): UnknownShareCodeBudgetDecision;
  getMissCount(): number;
};

export const createUnknownShareCodeBudget = (
  partialOptions: Partial<UnknownShareCodeBudgetOptions> = {}
): UnknownShareCodeBudget => {
  const options = { ...UNKNOWN_SHARE_CODE_BUDGET, ...partialOptions };
  const maxMisses = Math.max(1, Math.floor(options.maxMisses));
  const windowMs = Math.max(1, Math.floor(options.windowMs));

  let windowStart: number | null = null;
  let misses = 0;

  return {
    consume(now: number): UnknownShareCodeBudgetDecision {
      if (windowStart === null || now - windowStart >= windowMs) {
        windowStart = now;
        misses = 0;
      }
      if (misses >= maxMisses) {
        return { allowed: false, retryAfterMs: Math.max(1, windowStart + windowMs - now) };
      }
      misses += 1;
      return { allowed: true, remaining: maxMisses - misses };
    },
    getMissCount(): number {
      return misses;
    },
  };
};

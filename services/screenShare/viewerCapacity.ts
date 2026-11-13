import { SCREEN_SHARE_LIMITS } from '../../constants/transfer.ts';
import {
  SCREEN_SHARE_AGGREGATE_UPLINK_BPS,
  SCREEN_SHARE_COMFORTABLE_VIEWER_BPS,
} from './bitratePolicy.ts';

const normalizeViewerLimit = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;

/**
 * 「支持 N 人」不是承诺：每多一个观众就多一份独立编码上行。硬上限只保证超过后
 * 会被明确拒绝（share-full），画质能维持多少人取决于聚合上行预算。
 */
export const resolveRecommendedViewerCount = (
  maxViewers: number = SCREEN_SHARE_LIMITS.MAX_VIEWERS,
): number => {
  const limit = normalizeViewerLimit(maxViewers, SCREEN_SHARE_LIMITS.MAX_VIEWERS);
  const byUplinkBudget = Math.floor(
    SCREEN_SHARE_AGGREGATE_UPLINK_BPS / SCREEN_SHARE_COMFORTABLE_VIEWER_BPS,
  );
  return Math.max(1, Math.min(limit, byUplinkBudget));
};

export const describeViewerCapacity = (
  maxViewers: number = SCREEN_SHARE_LIMITS.MAX_VIEWERS,
): { max: number; recommended: number } => {
  const max = normalizeViewerLimit(maxViewers, SCREEN_SHARE_LIMITS.MAX_VIEWERS);
  return { max, recommended: resolveRecommendedViewerCount(max) };
};

/** 超过建议人数时提示「画质可能下降」，但不要拒绝——拒绝由硬上限负责。 */
export const shouldWarnViewerCapacity = (
  viewerCount: number,
  recommendedViewers: number,
): boolean => {
  if (!Number.isFinite(viewerCount) || !Number.isFinite(recommendedViewers)) return false;
  return viewerCount > Math.max(1, Math.floor(recommendedViewers));
};

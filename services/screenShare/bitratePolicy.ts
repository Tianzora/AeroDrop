
export type ScreenShareQualityLevel = 'high' | 'medium' | 'low';

export const SCREEN_SHARE_BITRATE_LIMITS: Record<
  ScreenShareQualityLevel,
  { min: number; max: number }
> = {
  high: { min: 2_000_000, max: 100_000_000 },
  medium: { min: 500_000, max: 8_000_000 },
  low: { min: 100_000, max: 2_500_000 },
};

export const SCREEN_SHARE_CAPTURE_PRESETS: Record<
  ScreenShareQualityLevel,
  { maxFrameRate: number; scaleResolutionDownBy: number }
> = {
  high: { maxFrameRate: 60, scaleResolutionDownBy: 1 },
  medium: { maxFrameRate: 45, scaleResolutionDownBy: 1 },
  low: { maxFrameRate: 24, scaleResolutionDownBy: 1.25 },
};

/**
 * 中继链路按流量计费，保留一个成本上限；局域网与点对点不设人为上限，
 * 实际发送速率交给每条 RTCPeerConnection 的 GCC 按双方带宽决定。
 */
export const SCREEN_SHARE_RELAY_BITRATE_CAP = 8_000_000;

export const resolveBitrateCap = (
  level: ScreenShareQualityLevel,
  isRelay = false,
): number => {
  const levelMax = SCREEN_SHARE_BITRATE_LIMITS[level].max;
  return isRelay ? Math.min(levelMax, SCREEN_SHARE_RELAY_BITRATE_CAP) : levelMax;
};

/**
 * 分享端胶囊展示“大多数观看者”的画质，而不是最差的那个：单个弱网 viewer
 * 由它自己的降档处理，不应该让整个分享端看起来一直在降级。
 * 偶数个观看者取偏高的中位（上中位），避免两个 viewer 一高一低时被较差的那个决定。
 */
export const resolveAggregateQuality = (
  levels: ScreenShareQualityLevel[],
): ScreenShareQualityLevel => {
  if (levels.length === 0) return 'high';
  const rank: Record<ScreenShareQualityLevel, number> = { low: 0, medium: 1, high: 2 };
  const sorted = [...levels].sort((a, b) => rank[a] - rank[b]);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * 只有“持续且明显卡顿”才降档；轻微丢包先交给 BWE 调码率，不切画质档位。
 */
export const shouldDowngradeQuality = (
  level: ScreenShareQualityLevel,
  packetLossRate: number,
  currentBitrate: number,
): boolean => {
  if (level === 'low') return false;
  const limits = SCREEN_SHARE_BITRATE_LIMITS[level];
  if (level === 'high') {
    return packetLossRate > 0.12 || (packetLossRate > 0.03 && currentBitrate < limits.min * 0.45);
  }
  return packetLossRate > 0.18 || (packetLossRate > 0.05 && currentBitrate < limits.min * 0.35);
};

export const shouldUpgradeQuality = (packetLossRate: number): boolean =>
  packetLossRate < 0.005;

import type { BrowserNetworkProfile } from './networkProfile';
import type { IceConfigResult } from './stunService';
import { getRouteSelectionTimings } from './routeSelectionPolicy.ts';

export type HappyEyeballsPlan = {
  initialPolicy: RTCIceTransportPolicy;
  backgroundPolicy: RTCIceTransportPolicy | null;
  initialTimeoutMs: number;
  backgroundDelayMs: number | null;
  backgroundTimeoutMs: number | null;
  reason: 'default' | 'relay_recommended' | 'mobile_network' | 'constrained_network' | 'stalled_transfer';
};

type ConnectionPolicyOptions = {
  defaultInitialTimeoutMs: number;
  relayInitialTimeoutMs: number;
  forceRelay?: boolean;
};

const getRelayPrewarmReason = (
  iceConfig: IceConfigResult,
  profile: BrowserNetworkProfile
) => {
  if (!iceConfig.hasTurn) {
    return 'default' as const;
  }

  if (profile.isMobileDevice || profile.isLikelyMobileNetwork) {
    return 'mobile_network';
  }

  if (profile.isConstrained) {
    return 'constrained_network';
  }

  if (
    iceConfig.relayRecommended ||
    (iceConfig.fetchLatencyMs !== null && iceConfig.fetchLatencyMs >= 1200)
  ) {
    return 'relay_recommended';
  }

  return 'default';
};

export const createHappyEyeballsPlan = (
  iceConfig: IceConfigResult,
  profile: BrowserNetworkProfile,
  options: ConnectionPolicyOptions
): HappyEyeballsPlan => {
  if (iceConfig.hasTurn && options.forceRelay) {
    return {
      initialPolicy: 'relay',
      backgroundPolicy: null,
      initialTimeoutMs: options.relayInitialTimeoutMs,
      backgroundDelayMs: null,
      backgroundTimeoutMs: null,
      reason: 'stalled_transfer',
    };
  }

  const relayPrewarmReason = getRelayPrewarmReason(iceConfig, profile);
  const routeTimings = getRouteSelectionTimings({
    isMobileDevice: profile.isMobileDevice,
    isConstrained: profile.isConstrained,
    relayRecommended: iceConfig.relayRecommended,
    fetchLatencyMs: iceConfig.fetchLatencyMs,
  });
  const shouldPrewarmRelay = iceConfig.hasTurn && routeTimings.startRelayDelayMs !== null;

  if (!iceConfig.hasTurn) {
    return {
      initialPolicy: 'all',
      backgroundPolicy: null,
      initialTimeoutMs: options.defaultInitialTimeoutMs,
      backgroundDelayMs: null,
      backgroundTimeoutMs: null,
      reason: 'default',
    };
  }

  return {
    initialPolicy: 'all',
    backgroundPolicy: shouldPrewarmRelay ? 'relay' : null,
    initialTimeoutMs: options.defaultInitialTimeoutMs,
    backgroundDelayMs: shouldPrewarmRelay ? routeTimings.startRelayDelayMs : null,
    backgroundTimeoutMs: shouldPrewarmRelay ? options.relayInitialTimeoutMs : null,
    reason: shouldPrewarmRelay ? relayPrewarmReason : 'default',
  };
};

/**
 * 重连预算（快速重试次数、committed 自动重连次数）只在连接「稳定存活」过之后才清零。
 * 若在握手成功时就清零，"连上即断" 的抖动会让预算永远用不完，退化成无限重连；
 * 连接从未稳定时不重置，让调用方的次数上限真正生效。
 */
export const shouldResetReconnectBudget = (options: {
  connectedSinceMs: number | null;
  nowMs: number;
  stableWindowMs: number;
}) =>
  options.connectedSinceMs !== null &&
  options.connectedSinceMs > 0 &&
  options.nowMs - options.connectedSinceMs >= options.stableWindowMs;

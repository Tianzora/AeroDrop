import type { BrowserNetworkProfile } from './networkProfile';
import type { IceConfigResult } from './stunService';
import { getRouteSelectionTimings } from './routeSelectionPolicy.ts';
import { TransferState } from '../types/index.ts';

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
  options.nowMs - options.connectedSinceMs >= options.stableWindowMs;

/**
 * 快速重连（未完成路由提交时的重试）的次数上限与退避延迟。
 * 两个调用点（连接关闭后的调度、peer-unavailable 重试）必须共用这里，避免同一策略在两处
 * 分叉；attempt 是 1 起算的本次重试序号。
 */
export const canAttemptFastReconnect = (retryCount: number, maxRetries: number) =>
  retryCount < maxRetries;

export const getFastReconnectDelayMs = (options: {
  attempt: number;
  baseMs: number;
  maxMs: number;
}) =>
  Math.min(
    options.baseMs * 2 ** (Math.max(1, options.attempt) - 1),
    options.maxMs
  );

/**
 * 快速重连预算耗尽后是否该终止这一轮连接：只有「还没连上发送端」且没有其它在途路由尝试时
 * 才判定失败。relay 尝试仍在进行时提前报错会把本来还有机会的连接误判掉。
 */
export const shouldAbandonExhaustedFastReconnect = (options: {
  currentState: TransferState;
  hasOtherRouteAttempt: boolean;
}) => options.currentState === TransferState.WAITING_FOR_PEER && !options.hasOtherRouteAttempt;

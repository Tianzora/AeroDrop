import type { RouteAttemptKind } from '../types/index.ts';

export type RouteSelectionContext = {
  isMobileDevice: boolean;
  isConstrained: boolean;
  relayRecommended: boolean;
  fetchLatencyMs?: number | null;
};

export type RouteSelectionPolicyClass =
  | 'desktop_normal'
  | 'desktop_risk'
  | 'mobile_constrained';

export type RouteSelectionDecision = {
  policyClass: RouteSelectionPolicyClass;
  startAllImmediately: boolean;
  startRelayDelayMs: number | null;
  primaryProbeWindowMs: number | null;
  p2pGraceWindowMs: number;
  reasons: string[];
  inputs: RouteSelectionContext;
};

export type RouteSnapshot = {
  kind: RouteAttemptKind;
  isDirect: boolean;
  isLanDirect: boolean;
};

export const getRouteSelectionDecision = (context: RouteSelectionContext): RouteSelectionDecision => {
  if (context.isMobileDevice || context.isConstrained) {
    const reasons: string[] = [];
    if (context.isMobileDevice) reasons.push('mobile_device');
    if (context.isConstrained) reasons.push('constrained_network');
    return {
      policyClass: 'mobile_constrained',
      startAllImmediately: true,
      startRelayDelayMs: 500,
      primaryProbeWindowMs: null,
      p2pGraceWindowMs: 900,
      reasons,
      inputs: context,
    };
  }

  const reasons: string[] = [];
  if (context.relayRecommended) reasons.push('relay_recommended');
  if (typeof context.fetchLatencyMs === 'number' && context.fetchLatencyMs >= 1200) {
    reasons.push('high_fetch_latency');
  }

  if (
    context.relayRecommended ||
    (typeof context.fetchLatencyMs === 'number' && context.fetchLatencyMs >= 1200)
  ) {
    return {
      policyClass: 'desktop_risk',
      startAllImmediately: true,
      startRelayDelayMs: 800,
      primaryProbeWindowMs: null,
      p2pGraceWindowMs: 1500,
      reasons,
      inputs: context,
    };
  }

  return {
    policyClass: 'desktop_normal',
    startAllImmediately: true,
    startRelayDelayMs: null,
    primaryProbeWindowMs: 1200,
    p2pGraceWindowMs: 1800,
    reasons,
    inputs: context,
  };
};

export const getRouteSelectionTimings = (context: RouteSelectionContext) => {
  const decision = getRouteSelectionDecision(context);
  return {
    startAllImmediately: decision.startAllImmediately,
    startRelayDelayMs: decision.startRelayDelayMs,
    primaryProbeWindowMs: decision.primaryProbeWindowMs,
    p2pGraceWindowMs: decision.p2pGraceWindowMs,
  };
};

export const pickPreferredRouteKind = (
  left: RouteSnapshot,
  right: RouteSnapshot
): RouteAttemptKind => {
  const rank = (route: RouteSnapshot) => {
    if (route.isLanDirect) return 3;
    if (route.isDirect) return 2;
    return 1;
  };

  const leftRank = rank(left);
  const rightRank = rank(right);

  if (leftRank !== rightRank) {
    return rightRank > leftRank ? right.kind : left.kind;
  }

  // Equal route quality: keep the composite `all` attempt authoritative so the
  // winner does not depend on probe arrival order.
  if (left.kind !== right.kind) {
    return left.kind === 'all' ? left.kind : right.kind;
  }

  return left.kind;
};

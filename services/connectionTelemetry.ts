import { logDebug } from './diagnostics';
import { classifyCandidatePair } from './networkAddress';

type TelemetryRole = 'sender' | 'receiver' | 'screen-share' | 'screen-viewer';

type TelemetryStatus = 'in_progress' | 'connected' | 'failed' | 'closed';

type AttemptRecord = {
  index: number;
  startedAt: number;
  durationMs?: number;
  reason?: string;
};

type EventRecord = {
  ts: number;
  event: string;
  data?: Record<string, unknown>;
};

export type IceRoute = {
  protocol?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  localNetworkType?: string;
  remoteNetworkType?: string;
  localUrl?: string;
  remoteUrl?: string;
  relayProtocol?: string;
  pathType?: 'LAN' | 'WAN' | 'TURN' | 'UNKNOWN';
  rttMs?: number;
};

export type ConnectionSession = {
  id: string;
  role: TelemetryRole;
  startedAt: number;
  status: TelemetryStatus;
  retries: number;
  attempts: AttemptRecord[];
  context?: Record<string, unknown>;
  firstConnectedAt?: number;
  firstConnectMs?: number;
  iceConfigFetchMs?: number;
  signalingOpenMs?: number;
  lastError?: string;
  iceRoute?: IceRoute;
  events: EventRecord[];
};

type CandidateLike = {
  address?: string;
  ip?: string;
  candidateType?: string;
  protocol?: string;
  networkType?: string;
  url?: string;
  relayProtocol?: string;
};

type StatsLike = Map<string, any>;

const sessionPrefix = 'conn';
const globalKey = '__AERODROP_CONN_METRICS__';
const QUIET_INFO_EVENTS = new Set([
  'session_start',
  'attempt_start',
  'attempt_retry',
  'ice_config_fetched',
  'signaling_open',
]);

const now = () => performance.now();

const toFixedMs = (n: number) => Math.max(0, Math.round(n));

const pushGlobal = (payload: unknown) => {
  try {
    const win = window as Window & { [globalKey]?: unknown[] };
    if (!Array.isArray(win[globalKey])) {
      win[globalKey] = [];
    }
    win[globalKey]!.push(payload);
    if (win[globalKey]!.length > 200) {
      win[globalKey] = win[globalKey]!.slice(-200);
    }
  } catch {
    // Ignore telemetry storage failures.
  }
};

const log = (level: 'info' | 'warn', session: ConnectionSession, event: string, data?: Record<string, unknown>) => {
  const payload = {
    tag: 'conn-metrics',
    sessionId: session.id,
    role: session.role,
    status: session.status,
    event,
    elapsedMs: toFixedMs(now() - session.startedAt),
    retries: session.retries,
    attempts: session.attempts.length,
    data,
  };
  if (level === 'warn') {
    logDebug('warn', '[conn-metrics]', payload);
  } else if (!QUIET_INFO_EVENTS.has(event)) {
    logDebug('info', '[conn-metrics]', payload);
  }
  pushGlobal(payload);
};

const finalizeAttempt = (session: ConnectionSession, reason?: string) => {
  const last = session.attempts.at(-1);
  if (!last || typeof last.durationMs === 'number') {
    return;
  }
  last.durationMs = toFixedMs(now() - last.startedAt);
  if (reason) last.reason = reason;
};

export const createConnectionSession = (
  role: TelemetryRole,
  context?: Record<string, unknown>
): ConnectionSession => {
  const session: ConnectionSession = {
    id: `${sessionPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    startedAt: now(),
    status: 'in_progress',
    retries: 0,
    attempts: [],
    context,
    events: [],
  };
  log('info', session, 'session_start', context);
  return session;
};

export const markSessionEvent = (
  session: ConnectionSession | null | undefined,
  event: string,
  data?: Record<string, unknown>
) => {
  if (!session) return;
  session.events.push({ ts: now(), event, data });
  log('info', session, event, data);
};

export const startConnectionAttempt = (
  session: ConnectionSession | null | undefined,
  reason = 'connect'
) => {
  if (!session || session.status !== 'in_progress') return;
  finalizeAttempt(session);
  session.attempts.push({
    index: session.attempts.length + 1,
    startedAt: now(),
    reason,
  });
  log('info', session, 'attempt_start', { reason, attempt: session.attempts.length });
};

export const markConnectionRetry = (
  session: ConnectionSession | null | undefined,
  reason: string
) => {
  if (!session || session.status !== 'in_progress') return;
  finalizeAttempt(session, reason);
  session.retries += 1;
  log('info', session, 'attempt_retry', { reason, retries: session.retries });
};

export const markIceConfigFetched = (
  session: ConnectionSession | null | undefined
) => {
  if (!session) return;
  session.iceConfigFetchMs = toFixedMs(now() - session.startedAt);
  log('info', session, 'ice_config_fetched', { iceConfigFetchMs: session.iceConfigFetchMs });
};

export const markSignalingOpen = (
  session: ConnectionSession | null | undefined
) => {
  if (!session) return;
  session.signalingOpenMs = toFixedMs(now() - session.startedAt);
  log('info', session, 'signaling_open', { signalingOpenMs: session.signalingOpenMs });
};

export const markConnectionSuccess = (
  session: ConnectionSession | null | undefined,
  data?: Record<string, unknown>
) => {
  if (!session || session.status !== 'in_progress') return;
  finalizeAttempt(session, 'connected');
  session.status = 'connected';
  session.firstConnectedAt = now();
  session.firstConnectMs = toFixedMs(session.firstConnectedAt - session.startedAt);
  log('info', session, 'connected', {
    firstConnectMs: session.firstConnectMs,
    iceConfigFetchMs: session.iceConfigFetchMs,
    signalingOpenMs: session.signalingOpenMs,
    retries: session.retries,
    ...data,
  });
};

export const markConnectionFailure = (
  session: ConnectionSession | null | undefined,
  reason: string,
  data?: Record<string, unknown>
) => {
  if (!session || session.status !== 'in_progress') return;
  finalizeAttempt(session, reason);
  session.status = 'failed';
  session.lastError = reason;
  log('warn', session, 'failed', { reason, ...data });
};

const pickSelectedPair = (stats: StatsLike) => {
  let selectedPair: any = null;
  stats.forEach((report) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      selectedPair = stats.get(report.selectedCandidatePairId) || selectedPair;
    }
  });

  if (selectedPair) return selectedPair;

  stats.forEach((report) => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.selected) {
      selectedPair = report;
    }
  });

  return selectedPair;
};

export const getIceRoute = async (pc: RTCPeerConnection): Promise<IceRoute | null> => {
  if (!pc || pc.connectionState === 'closed') return null;
  const stats = (await pc.getStats()) as StatsLike;
  const pair = pickSelectedPair(stats);
  if (!pair) return null;

  const local = stats.get(pair.localCandidateId) as CandidateLike | undefined;
  const remote = stats.get(pair.remoteCandidateId) as CandidateLike | undefined;
  const localIp = local?.address || local?.ip || '';
  const remoteIp = remote?.address || remote?.ip || '';
  const pathType = classifyCandidatePair({
    localAddress: localIp,
    remoteAddress: remoteIp,
    localCandidateType: local?.candidateType,
    remoteCandidateType: remote?.candidateType,
  });

  return {
    protocol: local?.protocol || remote?.protocol,
    localCandidateType: local?.candidateType,
    remoteCandidateType: remote?.candidateType,
    localNetworkType: local?.networkType,
    remoteNetworkType: remote?.networkType,
    localUrl: local?.url,
    remoteUrl: remote?.url,
    relayProtocol: local?.relayProtocol || remote?.relayProtocol,
    pathType,
    rttMs: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
  };
};

export const collectIceRouteWithRetry = async (
  pc: RTCPeerConnection,
  tries = 6,
  initialIntervalMs = 200
): Promise<IceRoute | null> => {
  for (let i = 0; i < tries; i++) {
    try {
      const route = await getIceRoute(pc);
      if (route) return route;
    } catch {
      // Ignore and retry.
    }
    if (i < tries - 1) {
      // Exponential backoff: 200, 400, 800, 1600, 3200 ms
      const delay = initialIntervalMs * Math.pow(2, i);
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  }
  return null;
};

export const attachIceRouteToSession = (
  session: ConnectionSession | null | undefined,
  route: IceRoute | null
) => {
  if (!session || !route) return;
  session.iceRoute = route;
  markSessionEvent(session, 'ice_route', route as Record<string, unknown>);
};


import {
  appendNetworkProfileQuery,
  getBrowserNetworkProfile,
  type BrowserNetworkProfile,
  type RelayReason,
  watchNetworkProfileChanges,
} from './networkProfile';
import { getAeroDropE2EHooks } from './e2eHooks';
import { logDebug } from './diagnostics';

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type IceConfigResponse = {
  iceServers?: IceServerConfig[];
  secure?: boolean;
  iceCandidatePoolSize?: number;
  iceTransportPolicy?: RTCIceTransportPolicy;
  hasTurn?: boolean;
  relayRecommended?: boolean;
  relayReason?: RelayReason;
};

export type IceConfigResult = {
  iceServers: IceServerConfig[];
  secure: boolean;
  iceCandidatePoolSize: number;
  iceTransportPolicy: RTCIceTransportPolicy;
  hasTurn: boolean;
  relayRecommended: boolean;
  relayReason: RelayReason;
  fetchLatencyMs: number | null;
};

const ICE_CACHE_TTL_MS = 30_000;
const ICE_FETCH_TIMEOUT_MS = 2000;
const ICE_CONFIG_LOG_KEY = '__AERODROP_ICE_CONFIG_LOGS__';
let cachedConfig: IceConfigResult | null = null;
let cachedAt = 0;
let cachedProfileKey = '';
let inflightRequest: Promise<IceConfigResult> | null = null;
let listenersInstalled = false;

const invalidateIceConfigCache = () => {
  cachedConfig = null;
  cachedAt = 0;
  cachedProfileKey = '';
};

const ensureNetworkProfileListeners = () => {
  if (listenersInstalled) {
    return;
  }

  listenersInstalled = true;
  watchNetworkProfileChanges(() => {
    invalidateIceConfigCache();
  });
};

export const getIceConfig = async (): Promise<IceConfigResult> => {
  const e2eOverride = getAeroDropE2EHooks()?.getIceConfigOverride?.();
  if (e2eOverride) {
    return e2eOverride;
  }

  ensureNetworkProfileListeners();
  const now = Date.now();
  const profile = getBrowserNetworkProfile();
  if (cachedConfig && cachedProfileKey === profile.profileKey && now - cachedAt < ICE_CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = fetchIceConfig(profile).finally(() => {
    inflightRequest = null;
  });
  return inflightRequest;
};

const fallbackConfig: IceConfigResult = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  secure: true,
  iceCandidatePoolSize: 20,
  iceTransportPolicy: 'all' as RTCIceTransportPolicy,
  hasTurn: false,
  relayRecommended: false,
  relayReason: null,
  fetchLatencyMs: null,
};

const pushIceConfigLog = (payload: unknown) => {
  try {
    const win = window as Window & { [ICE_CONFIG_LOG_KEY]?: unknown[] };
    if (!Array.isArray(win[ICE_CONFIG_LOG_KEY])) {
      win[ICE_CONFIG_LOG_KEY] = [];
    }
    win[ICE_CONFIG_LOG_KEY]!.push(payload);
    if (win[ICE_CONFIG_LOG_KEY]!.length > 100) {
      win[ICE_CONFIG_LOG_KEY] = win[ICE_CONFIG_LOG_KEY]!.slice(-100);
    }
  } catch {
    // Ignore debug storage failures.
  }
};

const logIceConfig = (
  level: 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>
) => {
  const payload = {
    tag: 'ice-config',
    event,
    ts: Date.now(),
    data,
  };
  if (level === 'warn') {
    logDebug('warn', '[ice-config]', payload);
  } else if (level === 'error') {
    logDebug('error', '[ice-config]', payload);
  } else {
    logDebug('info', '[ice-config]', payload);
  }
  pushIceConfigLog(payload);
};

const summarizeIceConfig = (result: IceConfigResult) => ({
  hasTurn: result.hasTurn,
  iceTransportPolicy: result.iceTransportPolicy,
  relayRecommended: result.relayRecommended,
  relayReason: result.relayReason,
  fetchLatencyMs: result.fetchLatencyMs,
  iceCandidatePoolSize: result.iceCandidatePoolSize,
  serverCount: result.iceServers.length,
  turnServerCount: result.iceServers.filter((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
  }).length,
});

const fetchIceConfig = async (profile: BrowserNetworkProfile): Promise<IceConfigResult> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);
  const startedAt = performance.now();
  const url = new URL('/api/ice-config', window.location.origin);
  appendNetworkProfileQuery(url.searchParams, profile);
  try {
    logIceConfig('info', 'fetch_start', { path: url.pathname, profile });
    const res = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
    if (!res.ok) {
      logIceConfig('warn', 'fetch_non_ok', {
        status: res.status,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return fallbackConfig;
    }
    const data = (await res.json()) as IceConfigResponse;
    const elapsedMs = Math.round(performance.now() - startedAt);

    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      logIceConfig('warn', 'fetch_invalid_payload', {
        elapsedMs,
      });
      return fallbackConfig;
    }

    const result: IceConfigResult = {
      iceServers: data.iceServers,
      secure: typeof data.secure === 'boolean' ? data.secure : fallbackConfig.secure,
      iceCandidatePoolSize: typeof data.iceCandidatePoolSize === 'number' ? data.iceCandidatePoolSize : fallbackConfig.iceCandidatePoolSize,
      iceTransportPolicy: data.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      relayRecommended: typeof data.relayRecommended === 'boolean'
        ? data.relayRecommended
        : data.iceTransportPolicy === 'relay',
      relayReason: data.relayReason ?? null,
      hasTurn: typeof data.hasTurn === 'boolean'
        ? data.hasTurn
        : data.iceServers.some(server => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'));
          }),
      fetchLatencyMs: elapsedMs,
    };
    logIceConfig('info', 'fetch_success', {
      elapsedMs,
      ...summarizeIceConfig(result),
    });
    cachedConfig = result;
    cachedAt = Date.now();
    cachedProfileKey = profile.profileKey;
    return result;
  } catch (error) {
    logIceConfig('warn', 'fetch_failed_using_fallback', {
      elapsedMs: Math.round(performance.now() - startedAt),
      reason: error instanceof Error ? error.message : String(error),
    });
    return fallbackConfig;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

/*
 * NOTE:
 * TURN credentials should come from server-side environment bindings.
 * Do not hardcode long-lived TURN credentials in frontend bundles.
 */

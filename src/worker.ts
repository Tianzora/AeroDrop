import { DurableObject } from 'cloudflare:workers';
import { resolveIceTransportPolicyDecision } from '../services/iceConfigPolicy';
import { createIceConfigRateLimiter, getIceConfigRetryAfterSeconds } from '../services/iceConfigRateLimitPolicy';
import {
  SHARE_CODE_FORBIDDEN_BODY,
  SHARE_CODE_MAX_BODY_BYTES,
  SHARE_CODE_TAKEN_BODY,
  allocateShareCode,
  isShareCodeRecordExpired,
  isValidShareCodeSecretHash,
  normalizeShareCode,
  resolveShareCodeRegistration,
  validateShareCodeCreatePayload,
  verifyShareCodeRevoke,
  type ShareCodeAllocationResult,
  type ShareCodeRecord,
} from '../services/shareCodeRegistry.ts';
import { createIceConfigGlobalLimiter } from '../services/iceConfigGlobalRateLimit.ts';
import {
  createShareCodeRateLimiters,
  getShareCodeRetryAfterSeconds,
} from '../services/shareCodeRateLimitPolicy.ts';
import {
  createSignalingRateLimiter,
  createSignalingSessionLimiter,
  isSignalingMessageTooLarge,
  recordSignalingMessage,
  MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT,
  type SignalingMessageWindow,
  type SignalingSessionLimiter,
} from '../services/signalingRateLimitPolicy';
import {
  createSelfHostedTurnIceServer,
  hasTurnIceServers,
  selectReliableIceServers,
} from '../services/turnCredentials';

interface AssetBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: AssetBinding;
  SIGNALING_HUB: DurableObjectNamespace;
  // 同一出口 IP 的并发信令上限，默认 12；CGNAT 部署可调高。
  SIGNALING_MAX_SESSIONS_PER_CLIENT?: string;
  CF_TURN_TOKEN_ID?: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
  CF_TURN_TTL_SECONDS?: string;
  TURN_URLS?: string;
  TURN_SHARED_SECRET?: string;
  TURN_REALM?: string;
  TURN_TTL_SECONDS?: string;
}

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type IceConfigPayload = {
  iceServers: IceServerConfig[];
  secure: boolean;
  iceCandidatePoolSize: number;
  iceTransportPolicy: 'all' | 'relay';
  hasTurn: boolean;
  relayRecommended?: boolean;
  relayReason?: 'isp' | 'score' | 'location' | 'network' | null;
};

type CloudflareTurnApiResponse = {
  iceServers?: IceServerConfig[];
};

type NetworkRiskReason = 'isp' | 'score' | 'location' | 'network' | null;

type ClientNetworkHints = {
  isMobileDevice: boolean;
  networkType: string;
  effectiveType: string;
  saveData: boolean;
  rtt: number | null;
  downlink: number | null;
};

type NetworkRiskAssessment = {
  isRisk: boolean;
  reason: NetworkRiskReason;
  details: string;
  isp: string;
  country: string;
};

type SignalingEnvelope =
  | { type: 'registered'; peerId: string }
  | { type: 'ping' | 'pong'; ts: number; sourcePeerId?: string }
  | { type: 'error'; code: string; message?: string; connectionId?: string; targetPeerId?: string; kind?: 'data' | 'media' }
  | {
      type: 'offer' | 'answer';
      connectionId: string;
      kind: 'data' | 'media';
      sourcePeerId: string;
      targetPeerId: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: 'ice-candidate';
      connectionId: string;
      kind: 'data' | 'media';
      sourcePeerId: string;
      targetPeerId: string;
      candidate: RTCIceCandidateInit;
    };

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-cache';
const SW_CACHE_CONTROL = 'no-cache';
const MANIFEST_CACHE_CONTROL = 'no-cache';
const DEFAULT_CF_TURN_TTL_SECONDS = 3600;
const MIN_CF_TURN_TTL_SECONDS = 60;
const MAX_CF_TURN_TTL_SECONDS = 86400;
const CF_TURN_CACHE_SAFETY_WINDOW_SECONDS = 60;
const CF_TURN_FETCH_TIMEOUT_MS = 4000;

const STUN_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let cachedCfIceConfig: IceConfigPayload | null = null;
let cachedCfIceConfigExpiresAt = 0;
let inflightCfIceConfig: Promise<IceConfigPayload | null> | null = null;

const SIGNALING_DO_NAME = 'global-signaling-hub';
const SIGNALING_PATH = '/ws-signaling';

// Per-isolate budget for TURN credential issuance; see iceConfigRateLimitPolicy.
const iceConfigRateLimiter = createIceConfigRateLimiter();

// /api/share-code 的固定窗口预算（POST 10/10s、GET 30/10s）。
const shareCodeRateLimiters = createShareCodeRateLimiters();

const SHARE_CODE_DO_PATH = '/internal/share-codes';
const SHARE_CODE_DO_URL = 'https://signaling-hub.internal' + SHARE_CODE_DO_PATH;

const ICE_LIMIT_DO_PATH = '/internal/ice-limit';
const ICE_LIMIT_DO_URL = 'https://signaling-hub.internal' + ICE_LIMIT_DO_PATH;
// 一次 DO 往返的上限；超时就退回 isolate 内限流，不给 ice-config 加不可控延迟。
const ICE_LIMIT_DO_TIMEOUT_MS = 800;

type ShareCodeRow = {
  code: string;
  peer_id: string;
  secret_hash: string;
  expires_at: number;
};

type ShareCodeBodyResult =
  | { ok: true; tooLarge: false; value: unknown }
  | { ok: false; tooLarge: boolean };

const setSecurityHeaders = (headers: Headers) => {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  headers.set('X-XSS-Protection', '1; mode=block');
  if (!headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
};

const applyResponsePolicies = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers);

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    const pathname = new URL(request.url).pathname.toLowerCase();

    if (pathname === '/sw.js') {
      headers.set('Cache-Control', SW_CACHE_CONTROL);
    } else if (pathname === '/manifest.json') {
      headers.set('Cache-Control', MANIFEST_CACHE_CONTROL);
    } else if (pathname.endsWith('.js') || pathname.endsWith('.css')) {
      headers.set('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
    } else if (pathname === '/' || pathname.endsWith('/index.html') || pathname.endsWith('.html')) {
      headers.set('Cache-Control', HTML_CACHE_CONTROL);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const json = (data: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBooleanFlag = (value: string | null): boolean => value === '1' || value === 'true';

const parseNullableNumber = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const getClientNetworkHints = (request: Request): ClientNetworkHints => {
  const url = new URL(request.url);
  return {
    isMobileDevice: parseBooleanFlag(url.searchParams.get('mobileDevice')),
    networkType: url.searchParams.get('networkType')?.trim().toLowerCase() || 'unknown',
    effectiveType: url.searchParams.get('effectiveType')?.trim().toLowerCase() || 'unknown',
    saveData: parseBooleanFlag(url.searchParams.get('saveData')),
    rtt: parseNullableNumber(url.searchParams.get('rtt')),
    downlink: parseNullableNumber(url.searchParams.get('downlink')),
  };
};

const getCloudflareTurnTokenId = (env: Env): string => {
  return env.CF_TURN_TOKEN_ID?.trim() || env.CF_TURN_KEY_ID?.trim() || '';
};

const getCloudflareTurnTtlSeconds = (env: Env): number => {
  const requestedTtl = parsePositiveInt(env.CF_TURN_TTL_SECONDS, DEFAULT_CF_TURN_TTL_SECONDS);
  return Math.min(MAX_CF_TURN_TTL_SECONDS, Math.max(MIN_CF_TURN_TTL_SECONDS, requestedTtl));
};

const rankIceUrl = (url: string): number => {
  const normalized = url.trim().toLowerCase();
  if (normalized.startsWith('turn:') && normalized.includes('transport=udp')) return 0;
  if (normalized.startsWith('turn:')) return 1;
  if (normalized.startsWith('turns:') && normalized.includes('transport=tcp')) return 3;
  if (normalized.startsWith('turns:')) return 4;
  if (normalized.startsWith('stun:')) return 5;
  return 6;
};

const normalizeIceServers = (iceServers: IceServerConfig[]): IceServerConfig[] => {
  return iceServers.map((server) => {
    const urls = Array.isArray(server.urls) ? [...server.urls] : [server.urls];
    const orderedUrls = Array.from(new Set(urls)).sort((left, right) => rankIceUrl(left) - rankIceUrl(right));
    return {
      ...server,
      urls: Array.isArray(server.urls) ? orderedUrls : orderedUrls[0] || server.urls,
    };
  });
};

const createIceConfigPayload = (
  iceServers: IceServerConfig[],
  iceTransportPolicy: 'all' | 'relay' = 'all',
  relayReason: NetworkRiskReason = null,
  relayRecommended = iceTransportPolicy === 'relay',
): IceConfigPayload => ({
  iceServers: normalizeIceServers(iceServers),
  secure: true,
  iceCandidatePoolSize: 20,
  iceTransportPolicy,
  hasTurn: iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
  }),
  relayRecommended,
  relayReason,
});

/**
 * CSRF-only gate. Browsers send Origin/Referer/Sec-Fetch-Site, but every one of
 * those headers is client-controlled, so a non-browser client can always forge
 * one. This is not authentication and must not be relied on as such.
 */
const isAllowedSameOriginRequest = (request: Request): boolean => {
  const requestOrigin = request.headers.get('Origin');
  const requestReferer = request.headers.get('Referer');
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  const requestUrl = new URL(request.url);
  const allowedOrigin = requestUrl.origin;
  let refererOrigin: string | null = null;

  if (requestReferer) {
    try {
      refererOrigin = new URL(requestReferer).origin;
    } catch {
      refererOrigin = null;
    }
  }

  return (
    requestOrigin === allowedOrigin ||
    (!requestOrigin && refererOrigin === allowedOrigin) ||
    (!requestOrigin &&
      !refererOrigin &&
      (secFetchSite === 'same-origin' || secFetchSite === 'same-site'))
  );
};

const assessNetworkRisk = (request: Request): NetworkRiskAssessment => {
  const cf = request.cf;
  const clientNetwork = getClientNetworkHints(request);

  if (!cf) {
    return {
      isRisk: clientNetwork.networkType === 'cellular' || clientNetwork.saveData,
      reason: clientNetwork.networkType === 'cellular' || clientNetwork.saveData ? 'network' : null,
      details: 'Local development or CF object missing',
      isp: 'Local Dev',
      country: 'CN',
    };
  }

  const riskKeywords = [
    'google',
    'amazon',
    'aws',
    'microsoft',
    'azure',
    'digitalocean',
    'linode',
    'vultr',
    'alibaba',
    'tencent',
    'oracle',
    'cloudflare',
    'cdn',
    'server',
  ];
  const mobileCarrierKeywords = [
    'mobile',
    'wireless',
    'cellular',
    'telecom',
    'unicom',
    'cmcc',
    'verizon',
    'vodafone',
    't-mobile',
    'sprint',
    'telefonica',
  ];

  const originalIsp = (cf.asOrganization as string) || 'Unknown';
  const isp = originalIsp.toLowerCase();
  const country = (cf.country as string) || 'Unknown';
  const threatScore = (cf.threatScore as number) || 0;
  const isLikelyMobileNetwork =
    clientNetwork.networkType === 'cellular' ||
    mobileCarrierKeywords.some((keyword) => isp.includes(keyword));
  const clientLooksConstrained =
    clientNetwork.saveData ||
    clientNetwork.effectiveType === 'slow-2g' ||
    clientNetwork.effectiveType === '2g' ||
    clientNetwork.effectiveType === '3g' ||
    (clientNetwork.rtt !== null && clientNetwork.rtt >= 180) ||
    (clientNetwork.downlink !== null && clientNetwork.downlink > 0 && clientNetwork.downlink < 5);

  let isRisk = false;
  let reason: NetworkRiskReason = null;
  let details = '';

  if (isLikelyMobileNetwork && (clientLooksConstrained || clientNetwork.isMobileDevice)) {
    isRisk = true;
    reason = 'network';
    details = `${originalIsp} / ${clientNetwork.networkType} / ${clientNetwork.effectiveType}`;
  } else if (riskKeywords.some((keyword) => isp.includes(keyword))) {
    isRisk = true;
    reason = 'isp';
    details = originalIsp;
  } else if (isLikelyMobileNetwork) {
    isRisk = true;
    reason = 'network';
    details = `${originalIsp} / ${clientNetwork.networkType}`;
  } else if (threatScore > 10) {
    isRisk = true;
    reason = 'score';
    details = `Threat Score: ${threatScore}`;
  } else if (country !== 'CN') {
    reason = 'location';
    details = `Location: ${country}`;
  }

  return {
    isRisk,
    reason,
    details,
    isp: originalIsp,
    country,
  };
};

const fetchCloudflareTurnIceConfig = async (env: Env): Promise<IceConfigPayload | null> => {
  const turnTokenId = getCloudflareTurnTokenId(env);
  const apiToken = env.CF_TURN_API_TOKEN?.trim();

  if (!turnTokenId || !apiToken) {
    return null;
  }

  const now = Date.now();
  if (cachedCfIceConfig && now < cachedCfIceConfigExpiresAt) {
    return cachedCfIceConfig;
  }

  if (inflightCfIceConfig) {
    return inflightCfIceConfig;
  }

  inflightCfIceConfig = (async () => {
    const ttlSeconds = getCloudflareTurnTtlSeconds(env);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CF_TURN_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${turnTokenId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`Cloudflare TURN API returned ${response.status}`);
      }

      const data = (await response.json()) as CloudflareTurnApiResponse;
      if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
        throw new Error('Cloudflare TURN API returned no iceServers');
      }

      const payload = createIceConfigPayload(data.iceServers);
      cachedCfIceConfig = payload;

      const cacheTtlSeconds = Math.max(
        30,
        Math.min(300, ttlSeconds - CF_TURN_CACHE_SAFETY_WINDOW_SECONDS)
      );
      cachedCfIceConfigExpiresAt = Date.now() + cacheTtlSeconds * 1000;
      return payload;
    } catch (error) {
      console.error('Failed to fetch Cloudflare TURN credentials', error);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  })().finally(() => {
    inflightCfIceConfig = null;
  });

  return inflightCfIceConfig;
};

const createSelfHostedTurnIceConfig = async (env: Env): Promise<IceConfigPayload | null> => {
  try {
    const turnServer = await createSelfHostedTurnIceServer(env);
    return turnServer ? createIceConfigPayload([...STUN_SERVERS, turnServer]) : null;
  } catch (error) {
    console.error(
      'Failed to generate self-hosted TURN credentials',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return null;
  }
};

const iceConfigRateLimitedResponse = (retryAfterSeconds: number): Response =>
  json(
    { error: 'Too Many Requests' },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds),
      },
    }
  );

type IceConfigGlobalLimitOutcome =
  | { kind: 'allowed' }
  | { kind: 'limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

/**
 * 全局限流计数放在单例 SignalingHub DO 里，跨 colo 共享；isolate 内的限流器只在
 * DO 不可用/超时时降级使用。传输失败一律当作 unavailable，不阻断正常用户。
 */
const consumeIceConfigGlobalLimit = async (
  env: Env,
  clientKey: string
): Promise<IceConfigGlobalLimitOutcome> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ICE_LIMIT_DO_TIMEOUT_MS);

  try {
    const stub = env.SIGNALING_HUB.get(env.SIGNALING_HUB.idFromName(SIGNALING_DO_NAME));
    const response = await stub.fetch(
      new Request(ICE_LIMIT_DO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey }),
        signal: controller.signal,
      })
    );
    if (!response.ok) return { kind: 'unavailable' };

    const payload = (await response.json()) as { allowed?: unknown; retryAfterSeconds?: unknown };
    if (payload.allowed === true) return { kind: 'allowed' };
    if (payload.allowed === false) {
      const retryAfterSeconds =
        typeof payload.retryAfterSeconds === 'number'
        && Number.isFinite(payload.retryAfterSeconds)
        && payload.retryAfterSeconds > 0
          ? Math.ceil(payload.retryAfterSeconds)
          : 60;
      return { kind: 'limited', retryAfterSeconds };
    }

    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timeoutId);
  }
};

const handleIceConfig = async (request: Request, env: Env): Promise<Response> => {
  if (!isAllowedSameOriginRequest(request)) {
    return json(
      { error: 'Forbidden' },
      {
        status: 403,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }

    const clientKey = getSignalingClientKey(request);
  const globalLimit = await consumeIceConfigGlobalLimit(env, clientKey);
  if (globalLimit.kind === 'limited') {
    return iceConfigRateLimitedResponse(globalLimit.retryAfterSeconds);
  }
  if (globalLimit.kind === 'unavailable') {
    // 降级：全局计数不可用时至少限制本 isolate 的用量（多实例下仍会放大）。
    const localLimit = iceConfigRateLimiter.consume(clientKey, Date.now());
    if (!localLimit.allowed) {
      return iceConfigRateLimitedResponse(getIceConfigRetryAfterSeconds(localLimit.retryAfterMs));
    }
  }

  const networkRisk = assessNetworkRisk(request);
  const [cloudflareIceConfig, selfHostedIceConfig] = await Promise.all([
    fetchCloudflareTurnIceConfig(env),
    createSelfHostedTurnIceConfig(env),
  ]);
  const reliableIceServers = selectReliableIceServers([
    cloudflareIceConfig?.iceServers ?? [],
    selfHostedIceConfig?.iceServers ?? [],
  ], STUN_SERVERS);
  const policyDecision = resolveIceTransportPolicyDecision({
    hasTurn: hasTurnIceServers(reliableIceServers),
    isRisk: networkRisk.isRisk,
    riskReason: networkRisk.reason,
  });
  const payload = createIceConfigPayload(
    reliableIceServers,
    policyDecision.iceTransportPolicy,
    policyDecision.relayReason,
    policyDecision.relayRecommended,
  );

  return json(
    payload,
    {
      headers: {
        'Cache-Control': 'no-store',
        Vary: 'Origin, Referer',
      },
    }
  );
};

const handleSignalingUpgrade = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== 'GET') {
    return new Response('Worker expected GET method', { status: 400 });
  }

  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Worker expected Upgrade: websocket', { status: 426 });
  }

  if (!isAllowedSameOriginRequest(request)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const peerId = url.searchParams.get('peerId')?.trim() || '';
  if (!peerId) {
    return new Response('Missing peerId', { status: 400 });
  }

  const hubId = env.SIGNALING_HUB.idFromName(SIGNALING_DO_NAME);
  const stub = env.SIGNALING_HUB.get(hubId);
  return await stub.fetch(request);
};

const handleNetworkCheck = (request: Request): Response => {
  const networkRisk = assessNetworkRisk(request);
  return json(
    {
      isRisk: networkRisk.isRisk,
      reason: networkRisk.reason,
      details: networkRisk.details,
      isp: networkRisk.isp,
      country: networkRisk.country,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    }
  );
};

const handlePing = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'POST',
      },
    });
  }

  const body = await request.text();
  if (body !== 'ping') {
    return new Response('Bad Request', { status: 400 });
  }

  return new Response('pong', {
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
};

const shareCodeJson = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  json(data, { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } });

const shareCodeRateLimitedResponse = (retryAfterMs: number): Response =>
  shareCodeJson(
    { error: 'Too Many Requests' },
    429,
    { 'Retry-After': String(getShareCodeRetryAfterSeconds(retryAfterMs)) }
  );

const callShareCodeStore = async (env: Env, body: Record<string, unknown>): Promise<Response> => {
  const hubId = env.SIGNALING_HUB.idFromName(SIGNALING_DO_NAME);
  const stub = env.SIGNALING_HUB.get(hubId);
  return stub.fetch(
    new Request(SHARE_CODE_DO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
};

const readShareCodeBody = async (request: Request): Promise<ShareCodeBodyResult> => {
  const contentLength = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > SHARE_CODE_MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }

  const text = await request.text();
  if (text.length > SHARE_CODE_MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }

  try {
    return { ok: true, tooLarge: false, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
};

const handleShareCodeCreate = async (request: Request, env: Env): Promise<Response> => {
  if (!isAllowedSameOriginRequest(request)) {
    return shareCodeJson({ error: 'Forbidden' }, 403);
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }

  const rateLimit = shareCodeRateLimiters.post.consume(getSignalingClientKey(request), Date.now());
  if (!rateLimit.allowed) {
    return shareCodeRateLimitedResponse(rateLimit.retryAfterMs);
  }

  const body = await readShareCodeBody(request);
  if (!body.ok && body.tooLarge) {
    return shareCodeJson({ error: 'Body too large' }, 413);
  }
  if (!body.ok) {
    return shareCodeJson({ error: 'Invalid JSON body' }, 400);
  }

  const validated = validateShareCodeCreatePayload(body.value);
  if (!validated.ok) {
    return shareCodeJson({ error: validated.error }, 400);
  }

  const storeResponse = await callShareCodeStore(env, {
    op: 'create',
    peerId: validated.peerId,
    secretHash: validated.secretHash,
    ...(validated.code ? { code: validated.code } : {}),
  });
  if (storeResponse.status === 409) {
    return shareCodeJson(SHARE_CODE_TAKEN_BODY, 409);
  }
  if (!storeResponse.ok) {
    return shareCodeJson({ error: 'Share code allocation failed' }, 503);
  }

  return shareCodeJson(await storeResponse.json());
};

const handleShareCodeLookup = async (request: Request, env: Env): Promise<Response> => {
  if (!isAllowedSameOriginRequest(request)) {
    return shareCodeJson({ error: 'Forbidden' }, 403);
  }
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
    });
  }

  const rateLimit = shareCodeRateLimiters.get.consume(getSignalingClientKey(request), Date.now());
  if (!rateLimit.allowed) {
    return shareCodeRateLimitedResponse(rateLimit.retryAfterMs);
  }

  const code = normalizeShareCode(new URL(request.url).searchParams.get('code'));
  if (!code) {
    return shareCodeJson({ error: 'code must be six digits' }, 400);
  }

  const storeResponse = await callShareCodeStore(env, { op: 'lookup', code });
  if (storeResponse.status === 404) {
    return shareCodeJson({ error: 'Share code not found or expired' }, 404);
  }
  if (!storeResponse.ok) {
    return shareCodeJson({ error: 'Share code lookup failed' }, 503);
  }

  return shareCodeJson(await storeResponse.json());
};

const handleShareCodeRevoke = async (request: Request, env: Env, rawCode: string): Promise<Response> => {
  if (!isAllowedSameOriginRequest(request)) {
    return shareCodeJson({ error: 'Forbidden' }, 403);
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }

  const rateLimit = shareCodeRateLimiters.post.consume(getSignalingClientKey(request), Date.now());
  if (!rateLimit.allowed) {
    return shareCodeRateLimitedResponse(rateLimit.retryAfterMs);
  }

  const code = normalizeShareCode(rawCode);
  if (!code) {
    return shareCodeJson({ error: 'code must be six digits' }, 400);
  }

  const body = await readShareCodeBody(request);
  if (!body.ok && body.tooLarge) {
    return shareCodeJson({ error: 'Body too large' }, 413);
  }
  if (!body.ok) {
    return shareCodeJson({ error: 'Invalid JSON body' }, 400);
  }

  const payload = body.value as { peerId?: unknown; secretHash?: unknown };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return shareCodeJson({ error: 'Body must be a JSON object' }, 400);
  }

  const peerId = typeof payload.peerId === 'string' ? payload.peerId.trim() : '';
  const secretHash = typeof payload.secretHash === 'string' ? payload.secretHash.toLowerCase() : '';
  if (!peerId || !isValidShareCodeSecretHash(secretHash)) {
    return shareCodeJson({ error: 'peerId and secretHash are required' }, 400);
  }

  const storeResponse = await callShareCodeStore(env, { op: 'revoke', code, peerId, secretHash });
  if (storeResponse.status === 403) {
    return shareCodeJson(SHARE_CODE_FORBIDDEN_BODY, 403);
  }
  if (storeResponse.status === 404) {
    return shareCodeJson({ error: 'Share code not found' }, 404);
  }
  if (!storeResponse.ok) {
    return shareCodeJson({ error: 'Share code revoke failed' }, 503);
  }

  return shareCodeJson(await storeResponse.json());
};

const handleApiRequest = async (request: Request, env: Env, pathname: string): Promise<Response> => {
  switch (pathname) {
    case '/api/ice-config':
      return handleIceConfig(request, env);
    case '/api/network-check':
      return handleNetworkCheck(request);
    case '/api/ping':
      return handlePing(request);
    default:
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === SIGNALING_PATH) {
      return await handleSignalingUpgrade(request, env);
    }

    if (pathname === '/api/share-code') {
      const response = request.method === 'GET'
        ? await handleShareCodeLookup(request, env)
        : await handleShareCodeCreate(request, env);
      return applyResponsePolicies(request, response);
    }

    const shareCodeRevokeMatch = /^\/api\/share-code\/([^/]+)\/revoke$/.exec(pathname);
    if (shareCodeRevokeMatch) {
      return applyResponsePolicies(
        request,
        await handleShareCodeRevoke(request, env, shareCodeRevokeMatch[1])
      );
    }

    if (pathname.startsWith('/api/')) {
      const response = await handleApiRequest(request, env, pathname);
      return applyResponsePolicies(request, response);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return applyResponsePolicies(request, assetResponse);
  },
};

type SessionAttachment = {
  clientKey: string;
  peerId: string;
};

const getSignalingClientKey = (request: Request): string => {
  const cfConnectingIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfConnectingIp) return `ip:${cfConnectingIp}`;

  const forwardedFor = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  if (forwardedFor) return `xff:${forwardedFor}`;

  return 'ip:unknown';
};

export class SignalingHub extends DurableObject {
  private sessionsByPeer = new Map<string, WebSocket>();
  private peerBySocket = new Map<WebSocket, string>();
  private clientBySocket = new Map<WebSocket, string>();
  private rateLimiter = createSignalingRateLimiter();
  private sessionLimiter: SignalingSessionLimiter;
  private messageWindows = new Map<WebSocket, SignalingMessageWindow>();
  // 全局 /api/ice-config 限流计数（住在单例 DO 里，跨 colo 共享）。
  private iceConfigGlobalLimiter = createIceConfigGlobalLimiter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // 同一出口 IP 的并发信令上限；CGNAT 场景下可由部署方调高。
    this.sessionLimiter = createSignalingSessionLimiter(
      parsePositiveInt(env.SIGNALING_MAX_SESSIONS_PER_CLIENT, MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT)
    );

    this.initializeShareCodeSchema();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment?.peerId) continue;
      this.sessionsByPeer.set(attachment.peerId, ws);
      this.peerBySocket.set(ws, attachment.peerId);
      this.clientBySocket.set(ws, attachment.clientKey || 'ip:unknown');
      this.sessionLimiter.tryAcquire(attachment.clientKey || 'ip:unknown');
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === SHARE_CODE_DO_PATH) {
      return this.handleShareCodeInternalRequest(request);
    }
    if (url.pathname === ICE_LIMIT_DO_PATH) {
      return this.handleIceConfigLimitRequest(request);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const peerId = url.searchParams.get('peerId')?.trim() || '';
    if (!peerId) {
      return new Response('Missing peerId', { status: 400 });
    }
    const clientKey = getSignalingClientKey(request);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ clientKey, peerId } satisfies SessionAttachment);
    this.ctx.acceptWebSocket(server);

    const registration = await resolveShareCodeRegistration({
      peerId,
      code: url.searchParams.get('code'),
      token: url.searchParams.get('token'),
      now: Date.now(),
      findShareCode: (candidate) => this.findActiveShareCode(candidate, Date.now()),
    });
    if (!registration.allowed) {
      const legacyPeerId = registration.reason === 'legacy-peer-id';
      const invalidPeerId = registration.reason === 'invalid-peer-id';
      server.send(
        JSON.stringify({
          type: 'error',
          code: legacyPeerId || invalidPeerId ? 'invalid-id' : 'unauthorized',
          message: legacyPeerId
            ? '4-digit peer ids are no longer supported'
            : invalidPeerId
              ? 'Peer id must be a random 8-128 char id'
              : 'Share code or token is invalid',
        } satisfies SignalingEnvelope)
      );
      server.close(4009, 'Signaling registration rejected');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.sessionLimiter.tryAcquire(clientKey)) {
      server.send(
        JSON.stringify({
          type: 'error',
          code: 'rate-limited',
          message: 'Too many signaling sessions',
        } satisfies SignalingEnvelope)
      );
      server.close(4029, 'Too many sessions');
      return new Response(null, { status: 101, webSocket: client });
    }

    const existing = this.sessionsByPeer.get(peerId);
    if (existing && existing !== server) {
      this.sessionLimiter.release(clientKey);
      server.send(
        JSON.stringify({
          type: 'error',
          code: 'unavailable-id',
          message: 'Peer ID already in use',
        } satisfies SignalingEnvelope)
      );
      server.close(4009, 'Peer ID already in use');
      return new Response(null, { status: 101, webSocket: client });
    }

    this.sessionsByPeer.set(peerId, server);
    this.peerBySocket.set(server, peerId);
    this.clientBySocket.set(server, clientKey);
    server.send(JSON.stringify({ type: 'registered', peerId } satisfies SignalingEnvelope));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') {
      this.sendError(ws, 'invalid-message', 'Only text signaling messages are supported');
      return;
    }

    if (isSignalingMessageTooLarge(message)) {
      this.sendError(ws, 'invalid-message', 'Signaling message too large');
      try {
        ws.close(1009, 'Message too large');
      } catch {
        // The peer may already be closed.
      }
      return;
    }

    const messageWindow = recordSignalingMessage(this.messageWindows.get(ws), Date.now());
    this.messageWindows.set(ws, messageWindow.state);
    if (!messageWindow.allowed) {
      this.sendError(ws, 'rate-limited', 'Too many signaling messages');
      try {
        ws.close(1008, 'Too many signaling messages');
      } catch {
        // The peer may already be closed.
      }
      return;
    }

    let payload: SignalingEnvelope;
    try {
      payload = JSON.parse(message) as SignalingEnvelope;
    } catch {
      this.sendError(ws, 'invalid-message', 'Invalid JSON signaling payload');
      return;
    }

    if (payload.type === 'ping') {
      ws.send(
        JSON.stringify({
          type: 'pong',
          ts: payload.ts,
          sourcePeerId: this.peerBySocket.get(ws) || undefined,
        } satisfies SignalingEnvelope)
      );
      return;
    }

    if (payload.type === 'pong') {
      return;
    }

    if (payload.type !== 'offer' && payload.type !== 'answer' && payload.type !== 'ice-candidate') {
      this.sendError(ws, 'invalid-message', `Unsupported signaling type: ${(payload as { type?: string }).type ?? 'unknown'}`);
      return;
    }

    const sourcePeerId = this.peerBySocket.get(ws) || '';
    if (!sourcePeerId) {
      this.sendError(ws, 'disconnected', 'Socket is not registered');
      return;
    }

    if (payload.type === 'offer') {
      const rateLimitDecision = this.rateLimiter.recordOfferAttempt({
        clientKey: this.clientBySocket.get(ws) || 'ip:unknown',
        now: Date.now(),
      });
      if (!rateLimitDecision.allowed) {
        this.sendError(
          ws,
          'rate-limited',
          'Too many connection requests',
          payload.connectionId,
          payload.targetPeerId,
          payload.kind
        );
        return;
      }
    }

    const target = this.sessionsByPeer.get(payload.targetPeerId);
    if (!target) {
      this.sendError(ws, 'peer-unavailable', 'Target peer is unavailable', payload.connectionId, payload.targetPeerId, payload.kind);
      return;
    }

    target.send(
      JSON.stringify({
        ...payload,
        sourcePeerId,
      } satisfies SignalingEnvelope)
    );
  }

  webSocketClose(ws: WebSocket): void {
    this.unregisterSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.unregisterSocket(ws);
  }

  private unregisterSocket(ws: WebSocket): void {
    this.messageWindows.delete(ws);

    const clientKey = this.clientBySocket.get(ws);
    if (clientKey) {
      this.clientBySocket.delete(ws);
      this.sessionLimiter.release(clientKey);
    }

    const peerId = this.peerBySocket.get(ws);
    if (!peerId) return;
    this.peerBySocket.delete(ws);
    if (this.sessionsByPeer.get(peerId) === ws) {
      this.sessionsByPeer.delete(peerId);
    }
  }

  private initializeShareCodeSchema(): void {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS share_codes (' +
        'code TEXT PRIMARY KEY, ' +
        'peer_id TEXT NOT NULL, ' +
        'secret_hash TEXT NOT NULL, ' +
        'expires_at INTEGER NOT NULL, ' +
        'created_at INTEGER NOT NULL)'
    );
  }

  private deleteExpiredShareCodes(now: number): void {
    this.ctx.storage.sql.exec('DELETE FROM share_codes WHERE expires_at <= ?', now);
  }

  private findActiveShareCode(code: string, now: number): ShareCodeRecord | null {
    this.deleteExpiredShareCodes(now);
    const rows = this.ctx.storage.sql
      .exec<ShareCodeRow>(
        'SELECT code, peer_id, secret_hash, expires_at FROM share_codes WHERE code = ?',
        code
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;

    const record: ShareCodeRecord = {
      code: row.code,
      peerId: row.peer_id,
      secretHash: row.secret_hash,
      expiresAt: row.expires_at,
    };
    return isShareCodeRecordExpired(record, now) ? null : record;
  }

  private registerShareCode(
    peerId: string,
    secretHash: string,
    requestedCode: string | null,
    now: number
  ): ShareCodeAllocationResult {
    // 先清过期行：这样「冲突」只可能来自仍然有效的码，不会把 TTL 清理混进 409。
    this.deleteExpiredShareCodes(now);
    // 同一 peerId 只保留最新一张码，避免反复建码把表堆大。
    this.ctx.storage.sql.exec('DELETE FROM share_codes WHERE peer_id = ?', peerId);

    return allocateShareCode({
      peerId,
      secretHash,
      code: requestedCode,
      now,
      tryInsert: (record) => {
        const inserted = this.ctx.storage.sql
          .exec<{ code: string }>(
            'INSERT INTO share_codes (code, peer_id, secret_hash, expires_at, created_at) ' +
              'VALUES (?, ?, ?, ?, ?) ON CONFLICT(code) DO NOTHING RETURNING code',
            record.code,
            record.peerId,
            record.secretHash,
            record.expiresAt,
            now
          )
          .toArray();
        return inserted.length > 0;
      },
    });
  }

  /**
   * 仅 Worker 内部通过 DO stub 调用；Durable Object 没有公网路由，外部无法直接
   * 请求 /internal/* 路径。这里仍校验方法/字段，避免误用。
   */
  private async handleIceConfigLimitRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let payload: { clientKey?: unknown };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (typeof payload.clientKey !== 'string' || payload.clientKey.length === 0 || payload.clientKey.length > 128) {
      return new Response('Bad Request', { status: 400 });
    }

    const decision = this.iceConfigGlobalLimiter.check(payload.clientKey, Date.now());
    return Response.json(decision);
  }

  private revokeShareCode(code: string): boolean {
    const deleted = this.ctx.storage.sql
      .exec<{ code: string }>('DELETE FROM share_codes WHERE code = ? RETURNING code', code)
      .toArray();
    return deleted.length > 0;
  }

  private async handleShareCodeInternalRequest(request: Request): Promise<Response> {
    let payload: { op?: unknown; peerId?: unknown; secretHash?: unknown; code?: unknown };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const now = Date.now();
    const code = normalizeShareCode(typeof payload.code === 'string' ? payload.code : null);

    if (payload.op === 'create') {
      if (typeof payload.peerId !== 'string' || typeof payload.secretHash !== 'string') {
        return new Response('Bad Request', { status: 400 });
      }

      const requestedCode = typeof payload.code === 'string' ? normalizeShareCode(payload.code) : null;
      if (payload.code !== undefined && requestedCode === null) {
        return new Response('code must be six digits', { status: 400 });
      }

      const allocation = this.registerShareCode(payload.peerId, payload.secretHash, requestedCode, now);
      if (allocation.status === 'taken') {
        return Response.json(SHARE_CODE_TAKEN_BODY, { status: 409 });
      }

      return Response.json({ code: allocation.record.code, expiresAt: allocation.record.expiresAt });
    }

    if (payload.op === 'lookup') {
      if (!code) return new Response('Bad Request', { status: 400 });
      const record = this.findActiveShareCode(code, now);
      if (!record) return new Response('Not Found', { status: 404 });
      return Response.json({ peerId: record.peerId, expiresAt: record.expiresAt });
    }

    if (payload.op === 'revoke') {
      if (!code) return new Response('Bad Request', { status: 400 });

      const peerId = typeof payload.peerId === 'string' ? payload.peerId : '';
      const secretHash = typeof payload.secretHash === 'string' ? payload.secretHash : '';
      if (!peerId || !secretHash) return new Response('Bad Request', { status: 400 });

      // 码不存在与凭证不匹配都回 403：不让调用方把 revoke 当「这个码是否已占用」的探测口。
      const record = this.findActiveShareCode(code, now);
      if (!verifyShareCodeRevoke({ record, peerId, secretHash }).allowed) {
        return Response.json(SHARE_CODE_FORBIDDEN_BODY, { status: 403 });
      }
      if (!this.revokeShareCode(code)) {
        return Response.json(SHARE_CODE_FORBIDDEN_BODY, { status: 403 });
      }

      return Response.json({ revoked: true, code });
    }

    return new Response('Bad Request', { status: 400 });
  }

  private sendError(
    ws: WebSocket,
    code: string,
    message: string,
    connectionId?: string,
    targetPeerId?: string,
    kind?: 'data' | 'media'
  ): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        code,
        message,
        connectionId,
        targetPeerId,
        kind,
      } satisfies SignalingEnvelope)
    );
  }
}

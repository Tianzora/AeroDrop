import { DurableObject } from 'cloudflare:workers';
import { resolveIceTransportPolicyDecision } from '../services/iceConfigPolicy';
import { createIceConfigRateLimiter, getIceConfigRetryAfterSeconds } from '../services/iceConfigRateLimitPolicy';
import {
  SHARE_CODE_FORBIDDEN_BODY,
  SHARE_CODE_MAX_BODY_BYTES,
  SHARE_CODE_REBIND_REJECTED_BODY,
  SHARE_CODE_TAKEN_BODY,
  allocateShareCode,
  isValidShareCodeSecretHash,
  normalizeShareCode,
  resolveShareCodeRegistration,
  shouldRejectShareCodeRebind,
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
import {
  SESSION_PROOF_GRACE_MS,
  buildNextSessionProofHistory,
  createSessionProof,
  hashSessionProof,
  isValidSessionProof,
  isValidSessionSecretHash,
  shouldAcceptSessionAdmission,
  type SessionProofHistoryEntry,
} from '../services/signaling/sessionBinding';
import {
  rendezvousShardIndex,
  resolveSignalingShardCount,
  signalingShardIndex,
  signalingShardName,
} from '../services/signaling/shardRouting';

// 注销后保留 peerId 归属的时间窗。与口令 TTL 上限对齐，覆盖「同一个分享反复启停」。
const SHARE_CODE_TOMBSTONE_MS = 24 * 60 * 60 * 1000;
// 会话绑定的保留时间：即使 socket 已断开，同 peerId 的接管仍必须出示 proof。
// 24h 与口令墓碑对齐，避免分享结束后 peerId 立刻可被无凭证抢注。
const SIGNALING_SESSION_BINDING_MS = 24 * 60 * 60 * 1000;
// pagehide 可能只是切后台/被系统挂起，不能立刻永久注销；延迟窗口内允许原凭证恢复。
const SHARE_CODE_REVOKE_MAX_GRACE_MS = 120_000;

interface AssetBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: AssetBinding;
  SIGNALING_HUB: DurableObjectNamespace;
  // 同一出口 IP 的并发信令上限，默认 12；CGNAT 部署可调高。
  SIGNALING_MAX_SESSIONS_PER_CLIENT?: string;
  // 信令分片数，默认 1（单例 DO，行为不变）；扩容时按 rendezvous 路由到新片。
  SIGNALING_SHARD_COUNT?: string;
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
  | { type: 'registered'; peerId: string; sessionProof?: string }
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
// 分片之间的内部投递与口令回源查询；只由 worker/其它 DO 调用，不对公网暴露。
const SIGNALING_DELIVER_DO_PATH = '/internal/deliver-signaling';
const SIGNALING_SHARE_CODE_LOOKUP_PATH = '/internal/lookup-share-code';
const SIGNALING_SESSION_SLOT_PATH = '/internal/session-slot';
// 会话名额的兜底 TTL：正常路径由 socket 关闭时释放；进程被杀/DO 迁移可能漏掉释放，
// 超过这个时间没有心跳的槽位在下次领取时被清掉，避免一次故障永久占满出口 IP 的名额。
const SIGNALING_SESSION_SLOT_TTL_MS = 6 * 60 * 60 * 1000;

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
  revoke_after: number | null;
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

      // 分享链接（文件 ?code=、屏幕共享 ?view=）只对持链接的人有效，不该被搜索引擎收录。
      // 响应头对不执行 JS 的爬虫同样生效，静态 meta 做不到这一点。
      const url = new URL(request.url);
      if (url.searchParams.has('code') || url.searchParams.has('view')) {
        headers.set('X-Robots-Tag', 'noindex');
      }
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

  // 同一个 peerId 永远路由到同一片：注册、消息转发、内部投递都依赖这条不变量。
  const shardCount = resolveSignalingShardCount(env.SIGNALING_SHARD_COUNT);
  const shardName = signalingShardName(rendezvousShardIndex(peerId, shardCount));
  const hubId = env.SIGNALING_HUB.idFromName(shardName);
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

  // 没有 Content-Length 的分块上传也必须边读边限：先 request.text() 再判断长度
  // 等于让调用方用超大 body 吃掉 Worker 内存。
  if (!request.body) {
    return { ok: false, tooLarge: false };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > SHARE_CODE_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
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
    ...(validated.ttlMs ? { ttlMs: validated.ttlMs } : {}),
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

const handleShareCodeCredentialAction = async (
  request: Request,
  env: Env,
  rawCode: string,
  op: 'revoke' | 'resume'
): Promise<Response> => {
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

  const payload = body.value as { peerId?: unknown; secretHash?: unknown; graceMs?: unknown };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return shareCodeJson({ error: 'Body must be a JSON object' }, 400);
  }

  const peerId = typeof payload.peerId === 'string' ? payload.peerId.trim() : '';
  const secretHash = typeof payload.secretHash === 'string' ? payload.secretHash.toLowerCase() : '';
  if (!peerId || !isValidShareCodeSecretHash(secretHash)) {
    return shareCodeJson({ error: 'peerId and secretHash are required' }, 400);
  }

  const graceMs = op === 'revoke' && typeof payload.graceMs === 'number' && Number.isFinite(payload.graceMs)
    ? Math.min(Math.max(0, Math.floor(payload.graceMs)), SHARE_CODE_REVOKE_MAX_GRACE_MS)
    : 0;
  const storeResponse = await callShareCodeStore(env, {
    op,
    code,
    peerId,
    secretHash,
    ...(graceMs > 0 ? { graceMs } : {}),
  });
  if (storeResponse.status === 403) {
    return shareCodeJson(SHARE_CODE_FORBIDDEN_BODY, 403);
  }
  if (storeResponse.status === 404) {
    return shareCodeJson({ error: 'Share code not found' }, 404);
  }
  if (!storeResponse.ok) {
    return shareCodeJson({ error: `Share code ${op} failed` }, 503);
  }

  return shareCodeJson(await storeResponse.json());
};

const handleShareCodeRevoke = (request: Request, env: Env, rawCode: string): Promise<Response> =>
  handleShareCodeCredentialAction(request, env, rawCode, 'revoke');

const handleShareCodeResume = (request: Request, env: Env, rawCode: string): Promise<Response> =>
  handleShareCodeCredentialAction(request, env, rawCode, 'resume');

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

    const shareCodeResumeMatch = /^\/api\/share-code\/([^/]+)\/resume$/.exec(pathname);
    if (shareCodeResumeMatch) {
      return applyResponsePolicies(
        request,
        await handleShareCodeResume(request, env, shareCodeResumeMatch[1])
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
  // 分享会话绑定的密钥摘要。只有分享端会带；文件传输会话不带，接管行为保持原样。
  // 必须进 attachment：DO 休眠后用 deserializeAttachment 恢复，内存里的判定要靠它。
  sessionSecretHash?: string;
  // 分片模式下的全局会话名额 id（见 SIGNALING_SESSION_SLOT_PATH）；单例模式不写。
  slotId?: string;
};

/**
 * 会话绑定的持久化记录。proof 轮换后 attachment 里不再有分享密钥摘要（重连只带 proof），
 * 所以「socket 断开后仍要求凭证」只能靠这张表；只存摘要，明文 proof 只下发一次。
 */
type SessionBindingRecord = {
  secretHash: string | null;
  proofHash: string;
  recentProofHashes: SessionProofHistoryEntry[];
};

/** 历史 proof 是 JSON 文本列；解析失败按「没有历史」处理，绝不让坏数据变成放行。 */
const parseSessionProofHistory = (raw: string | null): SessionProofHistoryEntry[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as { proofHash?: unknown; expiresAt?: unknown };
      if (typeof candidate.proofHash !== 'string' || typeof candidate.expiresAt !== 'number') {
        return [];
      }
      return [{ proofHash: candidate.proofHash, expiresAt: candidate.expiresAt }];
    });
  } catch {
    return [];
  }
};

const getSignalingClientKey = (request: Request): string => {
  const cfConnectingIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfConnectingIp) return `ip:${cfConnectingIp}`;

  const forwardedFor = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  if (forwardedFor) return `xff:${forwardedFor}`;

  return 'ip:unknown';
};

export class SignalingHub extends DurableObject<Env> {
  private sessionsByPeer = new Map<string, WebSocket>();
  private peerBySocket = new Map<WebSocket, string>();
  private clientBySocket = new Map<WebSocket, string>();
  private rateLimiter = createSignalingRateLimiter();
  private sessionLimiter: SignalingSessionLimiter;
  private messageWindows = new Map<WebSocket, SignalingMessageWindow>();
  // 会话密钥不匹配的拒绝不限流（发生在会话名额检查之前），日志按 peerId 每分钟最多一条。
  private lastConflictLogAt = new Map<string, number>();
  // 全局 /api/ice-config 限流计数（住在单例 DO 里，跨 colo 共享）。
  private iceConfigGlobalLimiter = createIceConfigGlobalLimiter();
  // 分片模式下的全局会话名额：socket -> slotId，关闭时按 id 释放。
  private slotBySocket = new Map<WebSocket, string>();
  private maxSignalingSessions: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // 同一出口 IP 的并发信令上限；CGNAT 场景下可由部署方调高。
    this.maxSignalingSessions = parsePositiveInt(
      env.SIGNALING_MAX_SESSIONS_PER_CLIENT,
      MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT
    );
    this.sessionLimiter = createSignalingSessionLimiter(this.maxSignalingSessions);

    this.initializeShareCodeSchema();
    this.initializeSessionBindingSchema();
    this.initializeSessionSlotSchema();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment?.peerId) continue;
      this.sessionsByPeer.set(attachment.peerId, ws);
      this.peerBySocket.set(ws, attachment.peerId);
      this.clientBySocket.set(ws, attachment.clientKey || 'ip:unknown');
      this.sessionLimiter.tryAcquire(attachment.clientKey || 'ip:unknown');
      if (attachment.slotId) {
        this.slotBySocket.set(ws, attachment.slotId);
      }
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
    if (url.pathname === SIGNALING_DELIVER_DO_PATH) {
      return this.handleSignalingDeliverRequest(request);
    }
    if (url.pathname === SIGNALING_SHARE_CODE_LOOKUP_PATH) {
      return this.handleShareCodeLookupRequest(request);
    }
    if (url.pathname === SIGNALING_SESSION_SLOT_PATH) {
      return this.handleSessionSlotRequest(request);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const peerId = url.searchParams.get('peerId')?.trim() || '';
    if (!peerId) {
      return new Response('Missing peerId', { status: 400 });
    }
    // 摘要格式非法说明客户端实现有问题（也可能是伪造）：在握手阶段就拒绝，不给会话名额。
    const sessionSecretHash = url.searchParams.get('sessionSecretHash')?.trim() || undefined;
    if (sessionSecretHash !== undefined && !isValidSessionSecretHash(sessionSecretHash)) {
      return new Response('Invalid sessionSecretHash', { status: 400 });
    }
    // 轮换凭证：同一格式、不同语义。格式错说明客户端实现有问题，握手阶段就拒绝。
    const sessionProof = url.searchParams.get('sessionProof')?.trim() || undefined;
    if (sessionProof !== undefined && !isValidSessionProof(sessionProof)) {
      return new Response('Invalid sessionProof', { status: 400 });
    }
    const clientKey = getSignalingClientKey(request);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({
      clientKey,
      peerId,
      ...(sessionSecretHash ? { sessionSecretHash } : {}),
    } satisfies SessionAttachment);
    this.ctx.acceptWebSocket(server);

    const codeParam = url.searchParams.get('code');
    const tokenParam = url.searchParams.get('token');
    // share_codes 仍只住在 shard 0：本片不是 shard 0 时先回源取一次记录，再交给同步的
    // resolveShareCodeRegistration 判定。失败按「查不到」处理（fail closed），不放宽校验。
    const remoteLookup = this.shouldUseRemoteShareCodeLookup();
    const prefetchedCode = remoteLookup && codeParam ? await this.lookupShareCodeRemotely('code', codeParam) : null;
    const prefetchedByPeerId =
      remoteLookup && !codeParam ? await this.lookupShareCodeRemotely('peerId', peerId) : null;
    const registration = await resolveShareCodeRegistration({
      peerId,
      code: codeParam,
      token: tokenParam,
      now: Date.now(),
      findShareCode: remoteLookup
        ? () => prefetchedCode
        : (candidate) => this.findActiveShareCode(candidate, Date.now()),
      findShareCodeByPeerId: remoteLookup
        ? () => prefetchedByPeerId
        : (candidate) => this.findActiveShareCodeByPeerId(candidate, Date.now()),
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

    // peerId 冲突：同一个 peerId 只应有一条活着的信令连接。旧实现直接拒绝新连接，但旧
    // socket 的 close 事件经常晚于新连接到达（网络切换、刷新页面时必然出现的竞态），于是
    // 重连会一直拿到 unavailable-id（终态），页面停在「口令已被占用」。这里改成「新连接
    // 接管」：旧 socket 收到终态 error 后停止重连，它占用的会话名额立刻释放，避免名额被
    // 永久占住把同一出口 IP 拖进 4029。
    // 同一个 peerId 的新连接接管旧连接（抖动后的重连会复用 peerId）。名额必须先领取
    // 再驱逐：否则新连接因出口 IP 满额被 4029 时，旧会话已经被关掉，双方都没人服务。
    const existing = this.sessionsByPeer.get(peerId);
    const isTakeover = existing !== undefined && existing !== server;
    const existingAttachment = isTakeover
      ? (existing.deserializeAttachment() as SessionAttachment | null)
      : null;
    const now = Date.now();
    // 身份绑定：会话一旦绑定，接管必须出示当前（或宽限期内的上一代）proof；没有绑定
    // 记录时才回落到首次注册用的分享密钥摘要。判定与限流名额无关——拒绝路径必须让
    // 旧会话原样继续服务。
    const binding = this.findSessionBinding(peerId, now);
    const incomingProofHash = sessionProof ? await hashSessionProof(sessionProof) : undefined;
    const boundSecretHash =
      binding?.secretHash ?? existingAttachment?.sessionSecretHash ?? sessionSecretHash;
    const admission = shouldAcceptSessionAdmission({
      boundSecretHash,
      storedProofHash: binding?.proofHash,
      recentProofHashes: binding?.recentProofHashes,
      incomingSecretHash: sessionSecretHash,
      incomingProofHash,
      now,
    });
    if (admission === 'reject') {
      this.sendSessionConflict(server, peerId, now);
      return new Response(null, { status: 101, webSocket: client });
    }
    const existingClientKey = isTakeover ? this.clientBySocket.get(existing) : undefined;
    if (isTakeover && existingClientKey === clientKey) {
      // 同一出口 IP 的接管：名额此刻在旧 socket 手里，先收回再领取，等价于原子迁移。
      this.sessionLimiter.release(clientKey);
    }

    // 分片后「每客户端 12 会话」必须全局计数：每个片各算一次会把上限放大成 12×N。
    // 权威计数在 shard 0（与 ice-config 全局计数同处），只有分片 > 1 时才启用；
    // 单例模式完全走原来的内存计数，行为不变。
    let sessionSlotId: string | undefined;
    if (this.getSignalingShardCount() > 1) {
      sessionSlotId = crypto.randomUUID();
      const existingSlotId = existingAttachment?.slotId;
      if (isTakeover && existingSlotId) {
        // 接管同一个 peerId 时先释放旧槽位，否则「已满 + 重连」会被自己的旧连接挡住。
        await this.releaseSignalingSessionSlot(existingSlotId);
      }
      if (!(await this.reserveSignalingSessionSlot(sessionSlotId, clientKey))) {
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
      this.slotBySocket.set(server, sessionSlotId);
    }

    if (!this.sessionLimiter.tryAcquire(clientKey)) {
      if (sessionSlotId) {
        this.slotBySocket.delete(server);
        await this.releaseSignalingSessionSlot(sessionSlotId);
      }
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

    if (isTakeover) {
      this.sessionsByPeer.delete(peerId);
      this.peerBySocket.delete(existing);
      this.clientBySocket.delete(existing);
      if (existingClientKey !== undefined && existingClientKey !== clientKey) {
        this.sessionLimiter.release(existingClientKey);
      }
      try {
        existing.send(
          JSON.stringify({
            type: 'error',
            code: 'unavailable-id',
            message: 'Peer ID taken over by a newer connection',
          } satisfies SignalingEnvelope)
        );
      } catch (error) {
        // 旧 socket 可能已经断开；记录而不是静默吞掉，否则排障时看不到接管失败。
        console.warn('Failed to notify replaced signaling session', { peerId, error });
      } finally {
        // 通知失败也必须关掉旧会话，否则它会以「已注册」的假象继续占着 peerId。
        try {
          existing.close(4011, 'Peer ID taken over by a newer connection');
        } catch (error) {
          console.warn('Failed to close replaced signaling session', { peerId, error });
        }
      }
    }

    this.sessionsByPeer.set(peerId, server);
    this.peerBySocket.set(server, peerId);
    this.clientBySocket.set(server, clientKey);
    if (sessionSlotId) {
      // 名额 id 必须进 attachment：DO 休眠恢复后仍能按 socket 释放。
      server.serializeAttachment({
        clientKey,
        peerId,
        ...(sessionSecretHash ? { sessionSecretHash } : {}),
        slotId: sessionSlotId,
      } satisfies SessionAttachment);
    }
    // 绑定过密钥的会话在每次成功注册后轮换 proof：客户端下一次重连只带 proof，静态
    // 分享密钥摘要不再出现在 WS URL 上。明文 proof 只在这一帧里出现一次，落库的是摘要。
    let issuedProof: string | undefined;
    if (binding !== null || boundSecretHash !== undefined) {
      issuedProof = createSessionProof();
      this.saveSessionBinding({
        peerId,
        secretHash: boundSecretHash ?? null,
        proofHash: await hashSessionProof(issuedProof),
        recentProofHashes: buildNextSessionProofHistory({
          storedProofHash: binding?.proofHash,
          recentProofHashes: binding?.recentProofHashes,
          now,
          graceMs: SESSION_PROOF_GRACE_MS,
        }),
        now,
      });
    }
    server.send(
      JSON.stringify({
        type: 'registered',
        peerId,
        ...(issuedProof ? { sessionProof: issuedProof } : {}),
      } satisfies SignalingEnvelope)
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // 计数必须在类型检查之前：否则二进制帧可以绕过节流无限发送。
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

    if (typeof message !== 'string') {
      this.sendError(ws, 'invalid-message', 'Only text signaling messages are supported');
      try {
        ws.close(1003, 'Binary messages are not supported');
      } catch {
        // The peer may already be closed.
      }
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

    const delivered = await this.deliverSignaling(
      payload.targetPeerId,
      JSON.stringify({
        ...payload,
        sourcePeerId,
      } satisfies SignalingEnvelope)
    );
    if (!delivered) {
      this.sendError(ws, 'peer-unavailable', 'Target peer is unavailable', payload.connectionId, payload.targetPeerId, payload.kind);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.unregisterSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.unregisterSocket(ws);
  }

  private unregisterSocket(ws: WebSocket): void {
    this.messageWindows.delete(ws);

    const slotId = this.slotBySocket.get(ws);
    if (slotId) {
      this.slotBySocket.delete(ws);
      // 释放是尽力而为：计数失败最多让名额晚一点回收（有 TTL 兜底），不能影响关闭流程。
      this.ctx.waitUntil(this.releaseSignalingSessionSlot(slotId));
    }

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
        'created_at INTEGER NOT NULL, ' +
        'revoke_after INTEGER)'
    );
    // 旧库补列：pagehide 的延迟注销需要记录待生效时间。
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(share_codes)')
      .toArray();
    if (!columns.some((column) => column.name === 'revoke_after')) {
      this.ctx.storage.sql.exec('ALTER TABLE share_codes ADD COLUMN revoke_after INTEGER');
    }
    // 注销后保留一段时间的「墓碑」：只 DELETE 活跃行会让 peerId 的归属信息消失，
    // 任何拿到过发送方 peerId 的人都能抢先用自己的 secretHash 重新绑定这个 id，
    // 之后发送方续期会一直 409 并被静默吞掉。墓碑让 24h 内的重绑定仍需原凭证。
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS share_code_tombstones (' +
        'peer_id TEXT PRIMARY KEY, ' +
        'code TEXT NOT NULL, ' +
        'secret_hash TEXT NOT NULL, ' +
        'revoked_at INTEGER NOT NULL)'
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_share_code_tombstones_revoked ' +
        'ON share_code_tombstones(revoked_at)'
    );
  }

  private deleteExpiredShareCodes(now: number): void {
    // 口令 TTL 与分享有效期相等，自然到期时活跃行已经不存在，而 revoke 对过期记录
    // 一律 403：不在这里补写墓碑，最常用的到期路径就完全没有归属记录。
    this.ctx.storage.sql.exec(
      'INSERT INTO share_code_tombstones (peer_id, code, secret_hash, revoked_at) ' +
        'SELECT peer_id, code, secret_hash, ? FROM share_codes ' +
        'WHERE expires_at <= ? OR (revoke_after IS NOT NULL AND revoke_after <= ?) ' +
        'ON CONFLICT(peer_id) DO UPDATE SET code = excluded.code, ' +
        'secret_hash = excluded.secret_hash, revoked_at = excluded.revoked_at',
      now,
      now,
      now
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM share_codes WHERE expires_at <= ? OR (revoke_after IS NOT NULL AND revoke_after <= ?)',
      now,
      now
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM share_code_tombstones WHERE revoked_at <= ?',
      now - SHARE_CODE_TOMBSTONE_MS
    );
  }

  private initializeSessionBindingSchema(): void {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS signaling_session_bindings (' +
        'peer_id TEXT PRIMARY KEY, ' +
        'secret_hash TEXT, ' +
        'proof_hash TEXT NOT NULL, ' +
        "recent_hashes TEXT NOT NULL DEFAULT '[]', " +
        'updated_at INTEGER NOT NULL, ' +
        'expires_at INTEGER NOT NULL)'
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_signaling_session_bindings_expires ' +
        'ON signaling_session_bindings(expires_at)'
    );
  }

  private findSessionBinding(peerId: string, now: number): SessionBindingRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{
        secret_hash: string | null;
        proof_hash: string;
        recent_hashes: string | null;
        expires_at: number;
      }>(
        'SELECT secret_hash, proof_hash, recent_hashes, expires_at ' +
          'FROM signaling_session_bindings WHERE peer_id = ?',
        peerId
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at <= now) {
      // 过期绑定立刻清掉：否则 peerId 会被一个没人持有的会话一直锁住。
      this.ctx.storage.sql.exec('DELETE FROM signaling_session_bindings WHERE peer_id = ?', peerId);
      return null;
    }
    return {
      secretHash: row.secret_hash,
      proofHash: row.proof_hash,
      recentProofHashes: parseSessionProofHistory(row.recent_hashes),
    };
  }

  private saveSessionBinding(input: {
    peerId: string;
    secretHash?: string | null;
    proofHash: string;
    recentProofHashes: SessionProofHistoryEntry[];
    now: number;
  }): void {
    // 顺手清理过期行：注册频率远低于查询频率，不值得单独开 alarm。
    this.ctx.storage.sql.exec(
      'DELETE FROM signaling_session_bindings WHERE expires_at <= ?',
      input.now
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO signaling_session_bindings ' +
        '(peer_id, secret_hash, proof_hash, recent_hashes, updated_at, expires_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(peer_id) DO UPDATE SET ' +
        'secret_hash = excluded.secret_hash, ' +
        'proof_hash = excluded.proof_hash, ' +
        'recent_hashes = excluded.recent_hashes, ' +
        'updated_at = excluded.updated_at, ' +
        'expires_at = excluded.expires_at',
      input.peerId,
      input.secretHash ?? null,
      input.proofHash,
      JSON.stringify(input.recentProofHashes),
      input.now,
      input.now + SIGNALING_SESSION_BINDING_MS
    );
  }

  private getSignalingShardCount(): number {
    return resolveSignalingShardCount(this.env.SIGNALING_SHARD_COUNT);
  }

  /** 本实例的 DO 名（idFromName 创建的 id 在 DO 内可读回 name）。 */
  private getSignalingShardName(): string | null {
    return this.ctx.id.name ?? null;
  }

  private isShardZero(): boolean {
    const name = this.getSignalingShardName();
    return name === null || signalingShardIndex(name) === 0;
  }

  /** 分片 > 1 且本片不是 shard 0 时，口令表（share_codes）必须回 shard 0 查。 */
  private shouldUseRemoteShareCodeLookup(): boolean {
    return this.getSignalingShardCount() > 1 && !this.isShardZero();
  }

  private signalingStub(shardName: string): DurableObjectStub {
    return this.env.SIGNALING_HUB.get(this.env.SIGNALING_HUB.idFromName(shardName));
  }

  private async lookupShareCodeRemotely(
    kind: 'code' | 'peerId',
    value: string
  ): Promise<ShareCodeRecord | null> {
    try {
      const response = await this.signalingStub(signalingShardName(0)).fetch(
        new Request(`https://signaling.internal${SIGNALING_SHARE_CODE_LOOKUP_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, value, now: Date.now() }),
        })
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { record?: ShareCodeRecord | null } | null;
      return body?.record ?? null;
    } catch (error) {
      // 查询失败必须按「没查到」处理：宁可让本次注册被拒，也不能放宽身份校验。
      console.warn('signaling share-code lookup failed', error);
      return null;
    }
  }

  private async handleSignalingDeliverRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let body: { targetPeerId?: unknown; message?: unknown } | null = null;
    try {
      body = (await request.json()) as { targetPeerId?: unknown; message?: unknown };
    } catch {
      body = null;
    }
    const targetPeerId = typeof body?.targetPeerId === 'string' ? body.targetPeerId : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!targetPeerId || !message || isSignalingMessageTooLarge(message)) {
      return json({ delivered: false }, { status: 400 });
    }
    const target = this.sessionsByPeer.get(targetPeerId);
    if (!target) {
      return json({ delivered: false });
    }
    target.send(message);
    return json({ delivered: true });
  }

  private async handleShareCodeLookupRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let body: { kind?: unknown; value?: unknown; now?: unknown } | null = null;
    try {
      body = (await request.json()) as { kind?: unknown; value?: unknown; now?: unknown };
    } catch {
      body = null;
    }
    const kind = body?.kind;
    const value = typeof body?.value === 'string' ? body.value : '';
    const now = typeof body?.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();
    if ((kind !== 'code' && kind !== 'peerId') || !value) {
      return json({ record: null }, { status: 400 });
    }
    const record =
      kind === 'code' ? this.findActiveShareCode(value, now) : this.findActiveShareCodeByPeerId(value, now);
    return json({ record });
  }

  /**
   * 投递一条信令：本片有该会话就直接发；否则按 peerId 的分片路由转发给目标片。
   * 分片数为 1 时退化为原来的「本片查不到就 peer-unavailable」。
   */
  private async deliverSignaling(targetPeerId: string, message: string): Promise<boolean> {
    const target = this.sessionsByPeer.get(targetPeerId);
    if (target) {
      target.send(message);
      return true;
    }
    const shardCount = this.getSignalingShardCount();
    if (shardCount <= 1) return false;
    const ownShardName = this.getSignalingShardName();
    if (ownShardName === null) return false;
    const targetShardName = signalingShardName(rendezvousShardIndex(targetPeerId, shardCount));
    if (targetShardName === ownShardName) return false;
    try {
      const response = await this.signalingStub(targetShardName).fetch(
        new Request(`https://signaling.internal${SIGNALING_DELIVER_DO_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPeerId, message }),
        })
      );
      if (!response.ok) return false;
      const body = (await response.json()) as { delivered?: unknown } | null;
      return body?.delivered === true;
    } catch (error) {
      console.warn('signaling cross-shard delivery failed', error);
      return false;
    }
  }

  private initializeSessionSlotSchema(): void {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS signaling_session_slots (' +
        'slot_id TEXT PRIMARY KEY, ' +
        'client_key TEXT NOT NULL, ' +
        'expires_at INTEGER NOT NULL)'
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_signaling_session_slots_client ' +
        'ON signaling_session_slots(client_key)'
    );
  }

  /** 原子语义的近似：先清过期槽位，再数一次、插一条。DO 内单线程执行，无并发窗口。 */
  private applySessionSlotReserve(slotId: string, clientKey: string, now: number): boolean {
    this.ctx.storage.sql.exec('DELETE FROM signaling_session_slots WHERE expires_at <= ?', now);
    const rows = this.ctx.storage.sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM signaling_session_slots WHERE client_key = ?',
        clientKey
      )
      .toArray();
    if (Number(rows[0]?.count ?? 0) >= this.maxSignalingSessions) {
      return false;
    }
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO signaling_session_slots (slot_id, client_key, expires_at) VALUES (?, ?, ?)',
      slotId,
      clientKey,
      now + SIGNALING_SESSION_SLOT_TTL_MS
    );
    return true;
  }

  private applySessionSlotRelease(slotId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM signaling_session_slots WHERE slot_id = ?', slotId);
  }

  private async handleSessionSlotRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let body: { action?: unknown; slotId?: unknown; clientKey?: unknown; now?: unknown } | null = null;
    try {
      body = (await request.json()) as { action?: unknown; slotId?: unknown; clientKey?: unknown; now?: unknown };
    } catch {
      body = null;
    }
    const slotId = typeof body?.slotId === 'string' ? body.slotId : '';
    if (!slotId) {
      return json({ granted: false, released: false }, { status: 400 });
    }
    if (body?.action === 'release') {
      this.applySessionSlotRelease(slotId);
      return json({ released: true });
    }
    if (body?.action !== 'reserve') {
      return json({ granted: false, released: false }, { status: 400 });
    }
    const clientKey = typeof body?.clientKey === 'string' && body.clientKey ? body.clientKey : 'ip:unknown';
    const now = typeof body?.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();
    return json({ granted: this.applySessionSlotReserve(slotId, clientKey, now) });
  }

  /**
   * 领取一个全局会话名额。计数在 shard 0；本片就是 shard 0 时直接走本地表。
   * 计数服务不可用时放行：名额是防滥用，不是身份校验，不能因为计数故障让信令整体不可用。
   */
  private async reserveSignalingSessionSlot(slotId: string, clientKey: string): Promise<boolean> {
    if (this.getSignalingShardCount() <= 1) return true;
    if (this.isShardZero()) return this.applySessionSlotReserve(slotId, clientKey, Date.now());
    try {
      const response = await this.signalingStub(signalingShardName(0)).fetch(
        new Request(`https://signaling.internal${SIGNALING_SESSION_SLOT_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reserve', slotId, clientKey, now: Date.now() }),
        })
      );
      if (!response.ok) return true;
      const body = (await response.json()) as { granted?: unknown } | null;
      return body?.granted !== false;
    } catch (error) {
      console.warn('signaling session slot reserve failed', error);
      return true;
    }
  }

  private async releaseSignalingSessionSlot(slotId: string): Promise<void> {
    if (this.getSignalingShardCount() <= 1) return;
    if (this.isShardZero()) {
      this.applySessionSlotRelease(slotId);
      return;
    }
    try {
      await this.signalingStub(signalingShardName(0)).fetch(
        new Request(`https://signaling.internal${SIGNALING_SESSION_SLOT_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'release', slotId }),
        })
      );
    } catch (error) {
      console.warn('signaling session slot release failed', error);
    }
  }

  private findActiveShareCode(code: string, now: number): ShareCodeRecord | null {
    this.deleteExpiredShareCodes(now);
    const rows = this.ctx.storage.sql
      .exec<ShareCodeRow>(
        'SELECT code, peer_id, secret_hash, expires_at, revoke_after FROM share_codes WHERE code = ?',
        code
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at <= now || (row.revoke_after !== null && row.revoke_after <= now)) {
      return null;
    }

    const record: ShareCodeRecord = {
      code: row.code,
      peerId: row.peer_id,
      secretHash: row.secret_hash,
      expiresAt: row.expires_at,
    };
    return record;
  }

  private findActiveShareCodeByPeerId(peerId: string, now: number): ShareCodeRecord | null {
    const rows = this.ctx.storage.sql
      .exec<ShareCodeRow>(
        'SELECT code, peer_id, secret_hash, expires_at, revoke_after FROM share_codes WHERE peer_id = ?',
        peerId
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at <= now || (row.revoke_after !== null && row.revoke_after <= now)) {
      return null;
    }
    const record: ShareCodeRecord = {
      code: row.code,
      peerId: row.peer_id,
      secretHash: row.secret_hash,
      expiresAt: row.expires_at,
    };
    return record;
  }

  private findRecentTombstoneByPeerId(
    peerId: string,
    now: number
  ): { secretHash: string } | null {
    const rows = this.ctx.storage.sql
      .exec<{ secret_hash: string }>(
        'SELECT secret_hash FROM share_code_tombstones WHERE peer_id = ? ' +
          'AND revoked_at > ? ORDER BY revoked_at DESC LIMIT 1',
        peerId,
        now - SHARE_CODE_TOMBSTONE_MS
      )
      .toArray();
    return rows[0] ? { secretHash: rows[0].secret_hash } : null;
  }

  private registerShareCode(
    peerId: string,
    secretHash: string,
    requestedCode: string | null,
    now: number,
    ttlMs?: number
  ): ShareCodeAllocationResult {
    // 先清过期行：这样「冲突」只可能来自仍然有效的码，不会把 TTL 清理混进 409。
    this.deleteExpiredShareCodes(now);

    // 改绑必须先证明自己就是原来的持有者：否则任何知道口令的人都能用「码 -> peerId」
    // 查到发送方 id，再用自己的 HMAC 覆盖这行记录，把仍在进行的分享劫走。
    // 活跃行与 24h 墓碑都算归属证明，覆盖「先 revoke 再抢绑」的窗口。
    const existingBinding = this.findActiveShareCodeByPeerId(peerId, now);
    const tombstone = this.findRecentTombstoneByPeerId(peerId, now);
    if (
      shouldRejectShareCodeRebind({
        activeSecretHash: existingBinding?.secretHash ?? null,
        tombstoneSecretHash: tombstone?.secretHash ?? null,
        requestSecretHash: secretHash,
      })
    ) {
      return { status: 'rebind-rejected' };
    }

    // 同一 peerId 只保留最新一张码，避免反复建码把表堆大。
    this.ctx.storage.sql.exec('DELETE FROM share_codes WHERE peer_id = ?', peerId);

    return allocateShareCode({
      peerId,
      secretHash,
      code: requestedCode,
      now,
      ttlMs,
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

  private deferShareCodeRevoke(record: ShareCodeRecord, revokeAfter: number): boolean {
    const updated = this.ctx.storage.sql
      .exec<{ code: string }>(
        'UPDATE share_codes SET revoke_after = ? ' +
          'WHERE code = ? AND peer_id = ? AND secret_hash = ? RETURNING code',
        revokeAfter,
        record.code,
        record.peerId,
        record.secretHash
      )
      .toArray();
    return updated.length > 0;
  }

  private resumeShareCode(record: ShareCodeRecord): boolean {
    const updated = this.ctx.storage.sql
      .exec<{ code: string }>(
        'UPDATE share_codes SET revoke_after = NULL ' +
          'WHERE code = ? AND peer_id = ? AND secret_hash = ? RETURNING code',
        record.code,
        record.peerId,
        record.secretHash
      )
      .toArray();
    return updated.length > 0;
  }

  private revokeShareCode(record: ShareCodeRecord, now: number): boolean {
    // 先写墓碑再删活跃行：即使 DELETE 失败，归属信息也不会丢。
    this.ctx.storage.sql.exec(
      'INSERT INTO share_code_tombstones (peer_id, code, secret_hash, revoked_at) ' +
        'VALUES (?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET ' +
        'code = excluded.code, secret_hash = excluded.secret_hash, revoked_at = excluded.revoked_at',
      record.peerId,
      record.code,
      record.secretHash,
      now
    );
    const deleted = this.ctx.storage.sql
      .exec<{ code: string }>('DELETE FROM share_codes WHERE code = ? RETURNING code', record.code)
      .toArray();
    return deleted.length > 0;
  }

  private async handleShareCodeInternalRequest(request: Request): Promise<Response> {
    let payload: {
      op?: unknown;
      peerId?: unknown;
      secretHash?: unknown;
      code?: unknown;
      ttlMs?: unknown;
      graceMs?: unknown;
    };
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

      const requestedTtlMs = typeof payload.ttlMs === 'number' ? payload.ttlMs : undefined;
      const allocation = this.registerShareCode(
        payload.peerId,
        payload.secretHash,
        requestedCode,
        now,
        requestedTtlMs
      );
      if (allocation.status === 'taken') {
        return Response.json(SHARE_CODE_TAKEN_BODY, { status: 409 });
      }
      if (allocation.status === 'rebind-rejected') {
        return Response.json(SHARE_CODE_REBIND_REJECTED_BODY, { status: 409 });
      }

      return Response.json({ code: allocation.record.code, expiresAt: allocation.record.expiresAt });
    }

    if (payload.op === 'lookup') {
      if (!code) return new Response('Bad Request', { status: 400 });
      const record = this.findActiveShareCode(code, now);
      if (!record) return new Response('Not Found', { status: 404 });
      return Response.json({ peerId: record.peerId, expiresAt: record.expiresAt });
    }

    if (payload.op === 'resume') {
      if (!code) return new Response('Bad Request', { status: 400 });

      const peerId = typeof payload.peerId === 'string' ? payload.peerId : '';
      const secretHash = typeof payload.secretHash === 'string' ? payload.secretHash : '';
      if (!peerId || !secretHash) return new Response('Bad Request', { status: 400 });

      // 与 revoke 同一套凭证校验：只允许原持有者取消待注销。
      const record = this.findActiveShareCode(code, now);
      if (!record || !verifyShareCodeRevoke({ record, peerId, secretHash }).allowed) {
        return Response.json(SHARE_CODE_FORBIDDEN_BODY, { status: 403 });
      }
      if (!this.resumeShareCode(record)) {
        return Response.json(SHARE_CODE_FORBIDDEN_BODY, { status: 403 });
      }
      return Response.json({ resumed: true, code });
    }

    if (payload.op === 'revoke') {
      if (!code) return new Response('Bad Request', { status: 400 });

      const peerId = typeof payload.peerId === 'string' ? payload.peerId : '';
      const secretHash = typeof payload.secretHash === 'string' ? payload.secretHash : '';
      if (!peerId || !secretHash) return new Response('Bad Request', { status: 400 });

      // 码不存在与凭证不匹配都回 403：不让调用方把 revoke 当「这个码是否已占用」的探测口。
      const record = this.findActiveShareCode(code, now);
      if (!record || !verifyShareCodeRevoke({ record, peerId, secretHash }).allowed) {
        return Response.json(SHARE_CODE_FORBIDDEN_BODY, { status: 403 });
      }
      const graceMs = typeof payload.graceMs === 'number' && Number.isFinite(payload.graceMs)
        ? Math.min(Math.max(0, Math.floor(payload.graceMs)), SHARE_CODE_REVOKE_MAX_GRACE_MS)
        : 0;
      if (graceMs > 0) {
        if (!this.deferShareCodeRevoke(record, now + graceMs)) {
          return Response.json(SHARE_CODE_FORBIDDEN_BODY, { status: 403 });
        }
        return Response.json({ revoked: false, deferredUntil: now + graceMs, code });
      }
      if (!this.revokeShareCode(record, now)) {
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

  /**
   * 拒绝一次无法证明身份的接管：发终态 error 后直接关闭。
   *
   * 这条路径发生在名额检查之前（被拒的连接不占会话名额），所以日志必须限频，否则
   * 拿着分享链接的扫描者可以把日志打满。4010 是客户端约定的「会话冲突」终态码。
   */
  private sendSessionConflict(server: WebSocket, peerId: string, now: number): void {
    server.send(
      JSON.stringify({
        type: 'error',
        code: 'session-conflict',
        message: 'Session is bound to another connection',
      } satisfies SignalingEnvelope)
    );
    if (now - (this.lastConflictLogAt.get(peerId) ?? 0) >= 60_000) {
      if (this.lastConflictLogAt.size > 500) this.lastConflictLogAt.clear();
      this.lastConflictLogAt.set(peerId, now);
      console.warn('Rejected signaling session replacement without a valid session proof', {
        peerId,
      });
    }
    server.close(4010, 'Signaling session conflict');
  }
}

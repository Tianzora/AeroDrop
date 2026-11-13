import {
  CF_TURN_CACHE_SAFETY_WINDOW_SECONDS,
  CF_TURN_FETCH_TIMEOUT_MS,
  DEFAULT_CF_TURN_TTL_SECONDS,
  ICE_LIMIT_DO_TIMEOUT_MS,
  MAX_CF_TURN_TTL_SECONDS,
  MIN_CF_TURN_TTL_SECONDS,
  SHARE_CODE_REVOKE_MAX_GRACE_MS,
  SIGNALING_SESSION_SLOT_REFRESH_MS,
} from '../constants/signaling';

import { DurableObject } from 'cloudflare:workers';
import { resolveIceTransportPolicyDecision } from '../services/iceConfigPolicy';
import { createIceConfigRateLimiter, getIceConfigRetryAfterSeconds } from '../services/iceConfigRateLimitPolicy';
import {
  SHARE_CODE_ERROR_MESSAGES,
  SHARE_CODE_FORBIDDEN_BODY,
  SHARE_CODE_REBIND_REJECTED_BODY,
  SHARE_CODE_TAKEN_BODY,
  SHARE_CODE_UNKNOWN_LOOKUP_RETRY_AFTER_SECONDS,
  allocateShareCode,
  isValidShareCodeSecretHash,
  normalizeShareCode,
  resolveShareCodeRegistration,
  shareCodeErrorMessage,
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
  createSignalingHandshakeBudget,
  getSignalingHandshakeRetryAfterSeconds,
} from '../services/signaling/handshakeBudget';
import { createSignalingTelemetry } from '../services/signaling/signalingTelemetry';
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
  SESSION_SECRET_HASH_GRACE_MS,
  createSessionProof,
  hashSessionProof,
  isValidSessionProof,
  isValidSessionSecretHash,
} from '../services/signaling/sessionBinding';
import {
  SHARE_CODE_TOMBSTONE_MS,
  SIGNALING_SESSION_BINDING_MS,
  SIGNALING_SESSION_SLOT_TTL_MS,
  applySessionSlotRelease,
  applySessionSlotRenew,
  applySessionSlotReserve,
  commitSessionBindingRotation,
  deferShareCodeRevoke as applyDeferredShareCodeRevoke,
  deleteExpiredShareCodes as purgeExpiredShareCodes,
  deleteShareCodesByPeerId as deleteShareCodesForPeer,
  findActiveShareCode as readActiveShareCode,
  findActiveShareCodeByPeerId as readActiveShareCodeByPeerId,
  findRecentTombstoneByPeerId as readRecentShareCodeTombstone,
  initializeSessionBindingSchema,
  initializeSessionSlotSchema,
  initializeShareCodeSchema,
  insertShareCode as insertShareCodeRow,
  planSessionAdmission,
  resumeShareCode as applyResumeShareCode,
  revokeShareCode as applyRevokeShareCode,
  type SqlLike,
} from '../services/signaling/sessionStore';
import { assessNetworkRisk, type NetworkRiskReason } from '../services/signaling/networkRisk';
import { applyResponsePolicies } from '../services/signaling/httpPolicy';
import { readShareCodeBody } from '../services/signaling/shareCodeBody';
import {
  parsePositiveInt,
  resolveSignalingClientKey,
} from '../services/signaling/requestContext';
import {
  createUnknownShareCodeBudget,
  type UnknownShareCodeBudget,
} from '../services/signaling/unknownShareCodeBudget';
import { deliverRegisteredThenCommit } from '../services/signaling/sessionAdmissionDelivery';
import { planSignalingSessionSeat } from '../services/signaling/sessionSeat';
import {
  rendezvousShardIndex,
  resolveSignalingShardCount,
  signalingShardIndex,
  signalingShardName,
} from '../services/signaling/shardRouting';
import {
  SHARE_CODE_LOOKUP_BATCH_LIMIT,
  createShareCodeLookupBatcher,
  type ShareCodeLookupBatcher,
  type ShareCodeLookupRequest as ShareCodeLookupBatchRequest,
} from '../services/signaling/shareCodeLookupBatch';

// 注销后保留 peerId 归属的时间窗见 services/signaling/sessionStore.ts。
// pagehide 可能只是切后台/被系统挂起，不能立刻永久注销；延迟窗口内允许原凭证恢复。

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


const STUN_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let cachedCfIceConfig: IceConfigPayload | null = null;
let cachedCfIceConfigExpiresAt = 0;
let inflightCfIceConfig: Promise<IceConfigPayload | null> | null = null;

const SIGNALING_DO_NAME = 'global-signaling-hub';

// Workers Logs 就是这个进程的指标管道：一行一个 JSON，按 event 计数即可。
// 前缀不能省：Workers Logs 会把「整行是合法 JSON」的日志拆成结构化属性，message 列为空，
// 而告警的 SQL 过滤器只能查 message 这类字符串列（自定义属性不是可查询列）。加一个普通词
// 让整行不再是合法 JSON，指标文本就会原样落到 message 里，`message LIKE '%<event>%'` 才命中。
const signalingTelemetry = createSignalingTelemetry((line) => console.log(`signaling_metric ${line}`));
const SIGNALING_PATH = '/ws-signaling';
// 分片之间的内部投递与口令回源查询；只由 worker/其它 DO 调用，不对公网暴露。
const SIGNALING_DELIVER_DO_PATH = '/internal/deliver-signaling';
const SIGNALING_SHARE_CODE_LOOKUP_BATCH_PATH = '/internal/lookup-share-codes';
const SIGNALING_SESSION_SLOT_PATH = '/internal/session-slot';
// 会话绑定表（摘要 + proof 摘要 + 宽限期历史）只住在 shard 0，跨片走这个内部端点。
const SIGNALING_SESSION_BINDING_PATH = '/internal/session-binding';
/** 常驻连接每 30 分钟续一次名额 TTL；ping 每 5s 一次，不节流会变成写热点。 */

// Per-isolate budget for TURN credential issuance; see iceConfigRateLimitPolicy.
const iceConfigRateLimiter = createIceConfigRateLimiter();

// /api/share-code 的固定窗口预算（POST 10/10s、GET 30/10s）。
const shareCodeRateLimiters = createShareCodeRateLimiters();

// 分片模式下 WS 握手的跨 DO 回源预算（per-isolate，只削弱放大，不是硬配额）。
const signalingHandshakeBudget = createSignalingHandshakeBudget();

const SHARE_CODE_DO_PATH = '/internal/share-codes';
const SHARE_CODE_DO_URL = 'https://signaling-hub.internal' + SHARE_CODE_DO_PATH;

const ICE_LIMIT_DO_PATH = '/internal/ice-limit';
const ICE_LIMIT_DO_URL = 'https://signaling-hub.internal' + ICE_LIMIT_DO_PATH;
// 一次 DO 往返的上限；超时就退回 isolate 内限流，不给 ice-config 加不可控延迟。

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

    const clientKey = resolveSignalingClientKey(request.headers);
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
  const shardIndex = rendezvousShardIndex(peerId, shardCount);
  const shardName = signalingShardName(shardIndex);
  // 单例模式每个握手都记一条纯属噪声，只在真正分片时记录。
  if (shardCount > 1) {
    signalingTelemetry.record('signal_shard_selected', { shard: shardIndex, shardCount });
  }
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

  const rateLimit = shareCodeRateLimiters.post.consume(resolveSignalingClientKey(request.headers), Date.now());
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
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.allocationFailed }, 503);
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

  const rateLimit = shareCodeRateLimiters.get.consume(resolveSignalingClientKey(request.headers), Date.now());
  if (!rateLimit.allowed) {
    return shareCodeRateLimitedResponse(rateLimit.retryAfterMs);
  }

  const code = normalizeShareCode(new URL(request.url).searchParams.get('code'));
  if (!code) {
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.invalidCode }, 400);
  }

  const storeResponse = await callShareCodeStore(env, { op: 'lookup', code });
  if (storeResponse.status === 404) {
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.notFoundOrExpired }, 404);
  }
  if (storeResponse.status === 429) {
    // 全局未知码预算在 shard 0 里判定；把 Retry-After 原样交给调用方，客户端才能退避。
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.rateLimited }, 429, {
      'Retry-After': String(SHARE_CODE_UNKNOWN_LOOKUP_RETRY_AFTER_SECONDS),
    });
  }
  if (!storeResponse.ok) {
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.lookupFailed }, 503);
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

  const rateLimit = shareCodeRateLimiters.post.consume(resolveSignalingClientKey(request.headers), Date.now());
  if (!rateLimit.allowed) {
    return shareCodeRateLimitedResponse(rateLimit.retryAfterMs);
  }

  const code = normalizeShareCode(rawCode);
  if (!code) {
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.invalidCode }, 400);
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
    return shareCodeJson({ error: SHARE_CODE_ERROR_MESSAGES.notFound }, 404);
  }
  if (!storeResponse.ok) {
    return shareCodeJson({ error: shareCodeErrorMessage(op) }, 503);
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
type SessionBindingAdmissionInput = {
  peerId: string;
  existingSecretHash?: string;
  incomingSecretHash?: string;
  incomingProofHash?: string;
  now: number;
};

type SessionBindingAdmission =
  | { allowed: false }
  | {
      allowed: true;
      /** 本次注册签发的新 proof 明文；只有非空时才出现在 registered 帧里。 */
      proof?: string;
      /**
       * 等待落库的轮换。proof 已经在 registered 帧里交给客户端，落库必须晚于「确认能投递」，
       * 否则帧丢失 + 超出 proof 宽限期会让客户端永久 4010。
       */
      pending?: { proofHash: string; boundSecretHash: string | null };
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
  /** 同一个槽位在接管时会转给新 socket；旧 socket 退出时不能把新会话的名额释放掉。 */
  private slotOwnerSocket = new Map<string, WebSocket>();
  /** 槽位续期的节流时间：ping 很密，没必要每 5s 写一次 SQL。 */
  private slotRefreshedAt = new Map<WebSocket, number>();
  /** 同一 socket 的投递链，跨片 await 也不会打乱 offer/ICE 的顺序。 */
  private deliveryChains = new Map<WebSocket, Promise<void>>();
  private maxSignalingSessions: number;
  /** 跨片口令查询的合并器：同一窗口内的并发注册共用一次 RPC，而不是一次注册一次 RPC。 */
  private shareCodeLookupBatcher: ShareCodeLookupBatcher | null = null;
  /** 口令 GET 的全局未知码预算：只保护 shard 0 的口令表，不按码锁定。 */
  private unknownShareCodeBudget: UnknownShareCodeBudget = createUnknownShareCodeBudget();

  private getSql(): SqlLike {
    return this.ctx.storage.sql as unknown as SqlLike;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // 同一出口 IP 的并发信令上限；CGNAT 场景下可由部署方调高。
    this.maxSignalingSessions = parsePositiveInt(
      env.SIGNALING_MAX_SESSIONS_PER_CLIENT,
      MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT
    );
    this.sessionLimiter = createSignalingSessionLimiter(this.maxSignalingSessions);

    // DO 里只剩「表结构 + 状态机入口」；SQL 细节全部下沉到 sessionStore，便于用 fake 单测。
    const sql = this.getSql();
    initializeShareCodeSchema(sql);
    initializeSessionBindingSchema(sql);
    initializeSessionSlotSchema(sql);

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment?.peerId) continue;
      this.sessionsByPeer.set(attachment.peerId, ws);
      this.peerBySocket.set(ws, attachment.peerId);
      this.clientBySocket.set(ws, attachment.clientKey || 'ip:unknown');
      this.sessionLimiter.tryAcquire(attachment.clientKey || 'ip:unknown');
      if (attachment.slotId) {
        this.slotBySocket.set(ws, attachment.slotId);
        this.slotOwnerSocket.set(attachment.slotId, ws);
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
    if (url.pathname === SIGNALING_SHARE_CODE_LOOKUP_BATCH_PATH) {
      return this.handleShareCodeLookupBatchRequest(request);
    }
    if (url.pathname === SIGNALING_SESSION_SLOT_PATH) {
      return this.handleSessionSlotRequest(request);
    }
    if (url.pathname === SIGNALING_SESSION_BINDING_PATH) {
      return this.handleSessionBindingRequest(request);
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
    const clientKey = resolveSignalingClientKey(request.headers);
    const remoteLookup = this.shouldUseRemoteShareCodeLookup();
    // 分片模式下每次注册要跨 DO 回源查口令，且发生在会话名额与消息节流之前；
    // 先消耗 per-isolate 握手预算，别让未认证的握手放大成 DO 调用风暴。
    // 预算只在分片模式生效，单例部署不经过这里。
    if (remoteLookup) {
      const budget = signalingHandshakeBudget.consume(clientKey, Date.now());
      if (!budget.allowed) {
        signalingTelemetry.record('signal_handshake_budget_exhausted', {
          retryAfterMs: budget.retryAfterMs,
        });
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': String(getSignalingHandshakeRetryAfterSeconds(budget.retryAfterMs)) },
        });
      }
    }

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
    // 本地判定会 normalize 口令，远端预取也必须用同一个值，否则分片模式下
    // 「带首尾空白的码」会被误判成不存在（行为随分片数分裂）。
    const normalizedCodeParam = normalizeShareCode(codeParam);
    const prefetchedCode =
      remoteLookup && normalizedCodeParam
        ? await this.lookupShareCodeRemotely('code', normalizedCodeParam)
        : null;
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
    // 身份绑定表只住在 shard 0：分片数变化时同一个 peerId 会换片，绑定不能跟着旧片的
    // socket 走，否则新片查不到绑定就会退回「知道 peerId 即可接管」。所以判定与本次
    // proof 轮换都在 shard 0 完成（本片就是 shard 0 时走本地），这里只消费结果。
    const incomingProofHash = sessionProof ? await hashSessionProof(sessionProof) : undefined;
    const admission = await this.admitSignalingSession({
      peerId,
      isTakeover,
      existingSecretHash: existingAttachment?.sessionSecretHash,
      incomingSecretHash: sessionSecretHash,
      incomingProofHash,
      now,
    });
    if (!admission.allowed) {
      this.sendSessionConflict(server, peerId, now);
      return new Response(null, { status: 101, webSocket: client });
    }
    const existingClientKey = isTakeover ? this.clientBySocket.get(existing) : undefined;
    // 同一出口 IP 的接管：名额此刻记在旧 socket 上。接管块会把旧 socket 从 clientBySocket
    // 摘除（旧 socket 关闭时不再释放），所以这里直接「转移」席位：既不 release 也不
    // tryAcquire。先 release 再 tryAcquire 的旧写法在 tryAcquire 失败时会留下计数 -1 的
    // 漂移，而且这条路径提前 return，旧 socket 也没被关掉。
    const seatPlan = planSignalingSessionSeat({ isTakeover, existingClientKey, clientKey });

    // 分片后「每客户端 12 会话」必须全局计数：每个片各算一次会把上限放大成 12×N。
    // 权威计数在 shard 0（与 ice-config 全局计数同处），只有分片 > 1 时才启用；
    // 单例模式完全走原来的内存计数，行为不变。
    let sessionSlotId: string | undefined;
    if (this.getSignalingShardCount() > 1) {
      // 接管时复用旧槽位（reserve 会原地续期并转移归属）。先释放再领取的话，
      // 一旦领取失败，旧会话的名额就白丢了；反复尝试可以把全局上限压到 0。
      sessionSlotId =
        isTakeover && existingAttachment?.slotId ? existingAttachment.slotId : crypto.randomUUID();
      if (!(await this.reserveSignalingSessionSlot(sessionSlotId, clientKey))) {
        signalingTelemetry.record('signal_session_slot_rejected', {
          shardCount: this.getSignalingShardCount(),
        });
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

    if (seatPlan.kind === 'acquire' && !this.sessionLimiter.tryAcquire(clientKey)) {
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
    // 摘要要跨 proof 轮换保留：绑定 24h 过期后，attachment 是唯一的兜底依据，
    // 不能因为「这次只带了 proof」就把已有摘要抹掉。
    const attachmentSecretHash = sessionSecretHash ?? existingAttachment?.sessionSecretHash;
    if (sessionSlotId || attachmentSecretHash) {
      // 名额 id 必须进 attachment：DO 休眠恢复后仍能按 socket 释放。
      server.serializeAttachment({
        clientKey,
        peerId,
        ...(attachmentSecretHash ? { sessionSecretHash: attachmentSecretHash } : {}),
        ...(sessionSlotId ? { slotId: sessionSlotId } : {}),
      } satisfies SessionAttachment);
    }
    if (sessionSlotId) {
      this.slotOwnerSocket.set(sessionSlotId, server);
      this.slotRefreshedAt.set(server, now);
    }
    // proof 明文只在这一帧出现一次，绑定表里存的是它的 SHA-256 摘要。
    // 轮换落库必须在 registered 之后：帧丢了客户端手里只有旧 proof，先落库会在宽限期后
    // 让旧 proof 失效，重连直接 4010。helper 会把「投递失败 → 不落库」钉死成顺序契约。
    await deliverRegisteredThenCommit({
      sendRegistered: () => {
        server.send(
          JSON.stringify({
            type: 'registered',
            peerId,
            ...(admission.proof ? { sessionProof: admission.proof } : {}),
          } satisfies SignalingEnvelope)
        );
      },
      commit: () => this.finalizeSignalingSessionAdmission(peerId, admission),
    });
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
      const activeSlotId = this.slotBySocket.get(ws);
      if (activeSlotId) {
        const now = Date.now();
        if (now - (this.slotRefreshedAt.get(ws) ?? 0) >= SIGNALING_SESSION_SLOT_REFRESH_MS) {
          this.slotRefreshedAt.set(ws, now);
          this.ctx.waitUntil(this.renewSignalingSessionSlot(activeSlotId));
        }
      }
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

    // 跨片投递要 await 一次 RPC，同一 socket 的后续帧会在这里插队（ICE 候选先于
    // offer 投到对端就白丢了）。按 socket 串行化，保证「发送顺序 = 投递顺序」。
    const deliveryError = payload as { connectionId?: string; kind?: 'data' | 'media' };
    this.enqueueSignalingDelivery(
      ws,
      payload.targetPeerId,
      JSON.stringify({ ...payload, sourcePeerId } satisfies SignalingEnvelope),
      deliveryError
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

    this.deliveryChains.delete(ws);
    this.slotRefreshedAt.delete(ws);
    const slotId = this.slotBySocket.get(ws);
    if (slotId) {
      this.slotBySocket.delete(ws);
      // 接管会把同一个槽位转给新 socket：旧 socket 退出时只清自己的映射。
      if (this.slotOwnerSocket.get(slotId) === ws) {
        this.slotOwnerSocket.delete(slotId);
        // 释放是尽力而为：计数失败最多让名额晚一点回收（有 TTL 兜底），不能影响关闭流程。
        this.ctx.waitUntil(this.releaseSignalingSessionSlot(slotId));
      }
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

  private getShareCodeLookupBatcher(): ShareCodeLookupBatcher {
    if (this.shareCodeLookupBatcher === null) {
      this.shareCodeLookupBatcher = createShareCodeLookupBatcher({
        run: (requests) => this.runShareCodeLookupBatch(requests),
        // 几毫秒的窗口把几乎同时到达的注册（例如六个人一起点开链接）攒成一批；
        // 对单次注册只增加个位数毫秒，换掉的是每注册一次跨 DO RPC。
        defer: (flush) => {
          setTimeout(flush, 2);
        },
      });
    }
    return this.shareCodeLookupBatcher;
  }

  private async runShareCodeLookupBatch(
    requests: readonly ShareCodeLookupBatchRequest[]
  ): Promise<readonly (ShareCodeRecord | null)[]> {
    if (requests.length > 1) {
      signalingTelemetry.record('signal_share_code_lookup_batched', { size: requests.length });
    }
    const response = await this.signalingStub(signalingShardName(0)).fetch(
      new Request(`https://signaling.internal${SIGNALING_SHARE_CODE_LOOKUP_BATCH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookups: requests, now: Date.now() }),
      })
    );
    if (!response.ok) {
      throw new Error(`share-code batch lookup failed with ${response.status}`);
    }
    const body = (await response.json()) as { records?: unknown } | null;
    if (!Array.isArray(body?.records)) {
      throw new Error('share-code batch lookup returned an invalid payload');
    }
    return body.records as (ShareCodeRecord | null)[];
  }

  private async lookupShareCodeRemotely(
    kind: 'code' | 'peerId',
    value: string
  ): Promise<ShareCodeRecord | null> {
    try {
      return await this.getShareCodeLookupBatcher().request({ kind, value });
    } catch (error) {
      // 查询失败必须按「没查到」处理：宁可让本次注册被拒，也不能放宽身份校验。
      signalingTelemetry.record('signal_share_code_lookup_failed', { kind });
      console.warn('signaling share-code lookup failed', error);
      return null;
    }
  }

  /**
   * 会话绑定的权威副本只在 shard 0。分片模式下的注册必须回 shard 0 做「判定 + 轮换」，
   * 因为分片数一改，同一个 peerId 就会落到别的片，跟着 socket 存在的 attachment 与
   * 片内 SQL 都会失效——那正是「改分片数 = 静默降级为无绑定」的来源。
   */
  private async admitSignalingSession(
    input: SessionBindingAdmissionInput & { isTakeover: boolean }
  ): Promise<SessionBindingAdmission> {
    if (this.isShardZero()) {
      return this.applySessionBindingAdmission(input);
    }
    // 每次注册都要回源：只知道 peerId 的攻击者可以在原 socket 断开后以「全新注册」
    // 的身份挤进来（此时没有 existing 会话，isTakeover 为 false，拿不到这条捷径）。
    // 未绑定的 peerId（观众、文件传输、首次注册）在 shard 0 查不到绑定，直接放行。
    try {
      const response = await this.signalingStub(signalingShardName(0)).fetch(
        new Request(`https://signaling.internal${SIGNALING_SESSION_BINDING_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, isTakeover: undefined }),
        })
      );
      if (!response.ok) throw new Error(`binding rpc status ${response.status}`);
      const body = (await response.json()) as SessionBindingAdmission | null;
      if (!body || typeof body.allowed !== 'boolean') throw new Error('binding rpc body');
      return body.allowed ? { allowed: true, proof: body.proof, pending: body.pending } : { allowed: false };
    } catch (error) {
      signalingTelemetry.record('signal_session_binding_unavailable', {});
      console.warn('signaling session-binding lookup failed', error);
      // 接管必须有权威绑定才放行（fail closed）；全新注册没有可夺的会话，放行以保可用性。
      return { allowed: !input.isTakeover };
    }
  }

  private async applySessionBindingAdmission(
    input: SessionBindingAdmissionInput
  ): Promise<SessionBindingAdmission> {
    const plan = planSessionAdmission(this.getSql(), input);
    if (!plan.allowed) {
      return { allowed: false };
    }
    if (!plan.needsRotation) {
      return { allowed: true };
    }
    // 绑定过密钥的会话每次成功注册都轮换 proof：客户端下次重连只带 proof，静态分享密钥
    // 摘要不再出现在 WS URL 上。明文只回给调用方一帧，落库的是摘要。
    //
    // 这里刻意不落库：注册流程在 slot/名额检查之后才发 registered，帧一旦丢失客户端
    // 手里就没有新 proof；先落库会让旧 proof 在宽限期后失效并永久 4010。落库由
    // finalizeSignalingSessionAdmission 在确认投递之后完成。
    const proof = createSessionProof();
    const proofHash = await hashSessionProof(proof);
    return { allowed: true, proof, pending: { proofHash, boundSecretHash: plan.boundSecretHash ?? null } };
  }

  /**
   * registered 帧发出后落库 proof 轮换。失败只记指标：帧已经交给客户端，无法回滚，
   * 但内存里的旧摘要仍是有效凭证（宽限期 + proof 历史），最坏是少轮换一次。
   */
  private async finalizeSignalingSessionAdmission(
    peerId: string,
    admission: SessionBindingAdmission
  ): Promise<void> {
    if (!admission.allowed || !admission.pending) return;
    const { proofHash, boundSecretHash } = admission.pending;
    const now = Date.now();
    try {
      if (this.isShardZero()) {
        commitSessionBindingRotation(this.getSql(), {
          peerId,
          now,
          proofHash,
          boundSecretHash,
          graceMs: SESSION_SECRET_HASH_GRACE_MS,
          proofGraceMs: SESSION_PROOF_GRACE_MS,
          ttlMs: SIGNALING_SESSION_BINDING_MS,
        });
        return;
      }
      const response = await this.signalingStub(signalingShardName(0)).fetch(
        new Request(`https://signaling.internal${SIGNALING_SESSION_BINDING_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'commit',
            peerId,
            now,
            proofHash,
            boundSecretHash,
          }),
        })
      );
      if (!response.ok) throw new Error(`binding commit status ${response.status}`);
    } catch (error) {
      signalingTelemetry.record('signal_session_binding_commit_failed', {
        shardCount: this.getSignalingShardCount(),
      });
      console.warn('signaling session-binding commit failed', error);
    }
  }

  private async handleSessionBindingRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await request.json()) as Record<string, unknown> | null;
    } catch {
      body = null;
    }
    const peerId = typeof body?.peerId === 'string' ? body.peerId : '';
    const now = typeof body?.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();
    const pickHash = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !isValidSessionSecretHash(value)) return '__invalid__';
      return value;
    };
    const existingSecretHash = pickHash(body?.existingSecretHash);
    const incomingSecretHash = pickHash(body?.incomingSecretHash);
    const incomingProofHash = pickHash(body?.incomingProofHash);
    // 内部端点也校验入参：坏数据不能被当成「没有绑定」从而放宽判定。
    if (
      !peerId ||
      existingSecretHash === '__invalid__' ||
      incomingSecretHash === '__invalid__' ||
      incomingProofHash === '__invalid__'
    ) {
      return json({ allowed: false }, { status: 400 });
    }

    if (body?.action === 'commit') {
      const proofHash = pickHash(body?.proofHash);
      const boundSecretHash = body?.boundSecretHash === null ? null : pickHash(body?.boundSecretHash);
      if (!proofHash || proofHash === '__invalid__' || boundSecretHash === '__invalid__') {
        return json({ committed: false }, { status: 400 });
      }
      commitSessionBindingRotation(this.getSql(), {
        peerId,
        now,
        proofHash,
        boundSecretHash: boundSecretHash ?? null,
        graceMs: SESSION_SECRET_HASH_GRACE_MS,
        proofGraceMs: SESSION_PROOF_GRACE_MS,
        ttlMs: SIGNALING_SESSION_BINDING_MS,
      });
      return json({ committed: true });
    }

    const result = await this.applySessionBindingAdmission({
      peerId,
      existingSecretHash,
      incomingSecretHash,
      incomingProofHash,
      now,
    });
    return json(result);
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

  private async handleShareCodeLookupBatchRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let body: { lookups?: unknown; now?: unknown } | null = null;
    try {
      body = (await request.json()) as { lookups?: unknown; now?: unknown };
    } catch {
      body = null;
    }
    const lookups = body?.lookups;
    if (!Array.isArray(lookups) || lookups.length === 0 || lookups.length > SHARE_CODE_LOOKUP_BATCH_LIMIT) {
      return json({ records: [] }, { status: 400 });
    }
    const now = typeof body?.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();
    const records: (ShareCodeRecord | null)[] = [];
    for (const lookup of lookups) {
      const kind = (lookup as { kind?: unknown } | null)?.kind;
      const value = (lookup as { value?: unknown } | null)?.value;
      if ((kind !== 'code' && kind !== 'peerId') || typeof value !== 'string' || !value) {
        return json({ records: [] }, { status: 400 });
      }
      records.push(
        kind === 'code' ? this.findActiveShareCode(value, now) : this.findActiveShareCodeByPeerId(value, now)
      );
    }
    return json({ records });
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
    const targetShardIndex = rendezvousShardIndex(targetPeerId, shardCount);
    const targetShardName = signalingShardName(targetShardIndex);
    if (targetShardName === ownShardName) return false;
    try {
      const response = await this.signalingStub(targetShardName).fetch(
        new Request(`https://signaling.internal${SIGNALING_DELIVER_DO_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPeerId, message }),
        })
      );
      if (!response.ok) {
        signalingTelemetry.record('signal_cross_shard_failed', {
          targetShard: targetShardIndex,
          reason: 'rpc_status',
          status: response.status,
        });
        return false;
      }
      const body = (await response.json()) as { delivered?: unknown } | null;
      if (body?.delivered === true) {
        signalingTelemetry.record('signal_cross_shard_delivered', { targetShard: targetShardIndex });
        return true;
      }
      signalingTelemetry.record('signal_cross_shard_failed', {
        targetShard: targetShardIndex,
        reason: 'unknown_target',
      });
      return false;
    } catch (error) {
      signalingTelemetry.record('signal_cross_shard_failed', {
        targetShard: targetShardIndex,
        reason: 'rpc_error',
      });
      console.warn('signaling cross-shard delivery failed', error);
      return false;
    }
  }

  /**
   * 按 socket 串行投递：跨片要走一次 RPC，若直接 await，同一 socket 的后续帧会插队，
   * 对端可能先收到 ICE 再收到 offer。链尾留一份 Promise，等待期间的帧按到达顺序排队。
   */
  private enqueueSignalingDelivery(
    ws: WebSocket,
    targetPeerId: string,
    message: string,
    errorContext: { connectionId?: string; kind?: 'data' | 'media' }
  ): void {
    const previous = this.deliveryChains.get(ws) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const delivered = await this.deliverSignaling(targetPeerId, message);
        if (!delivered) {
          this.sendError(
            ws,
            'peer-unavailable',
            'Target peer is unavailable',
            errorContext.connectionId,
            targetPeerId,
            errorContext.kind
          );
        }
      })
      .catch((error) => {
        console.warn('signaling delivery chain failed', error);
      })
      .finally(() => {
        // 只有链尾是自己时才删除，否则会把后进队列的 Promise 丢掉。
        if (this.deliveryChains.get(ws) === next) this.deliveryChains.delete(ws);
      });
    this.deliveryChains.set(ws, next);
    this.ctx.waitUntil(next);
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
      applySessionSlotRelease(this.getSql(), slotId);
      return json({ released: true });
    }
    const now = typeof body?.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();
    if (body?.action === 'renew') {
      return json({
        renewed: applySessionSlotRenew(this.getSql(), {
          slotId,
          now,
          ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
        }),
      });
    }
    if (body?.action !== 'reserve') {
      return json({ granted: false, released: false }, { status: 400 });
    }
    const clientKey = typeof body?.clientKey === 'string' && body.clientKey ? body.clientKey : 'ip:unknown';
    return json({
      granted: applySessionSlotReserve(this.getSql(), {
        slotId,
        clientKey,
        now,
        maxSessions: this.maxSignalingSessions,
        ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
      }),
    });
  }

  /**
   * 领取一个全局会话名额。计数在 shard 0；本片就是 shard 0 时直接走本地表。
   * 计数服务不可用时放行：名额是防滥用，不是身份校验，不能因为计数故障让信令整体不可用。
   */
  private async reserveSignalingSessionSlot(slotId: string, clientKey: string): Promise<boolean> {
    if (this.getSignalingShardCount() <= 1) return true;
    if (this.isShardZero()) {
      return applySessionSlotReserve(this.getSql(), {
        slotId,
        clientKey,
        now: Date.now(),
        maxSessions: this.maxSignalingSessions,
        ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
      });
    }
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

  private async renewSignalingSessionSlot(slotId: string): Promise<void> {
    if (this.getSignalingShardCount() <= 1) return;
    if (this.isShardZero()) {
      applySessionSlotRenew(this.getSql(), {
        slotId,
        now: Date.now(),
        ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
      });
      return;
    }
    try {
      await this.signalingStub(signalingShardName(0)).fetch(
        new Request(`https://signaling.internal${SIGNALING_SESSION_SLOT_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'renew', slotId, now: Date.now() }),
        })
      );
    } catch (error) {
      // 续期失败不影响连接：名额 TTL 还在，下次 ping 会再试。
      console.warn('signaling session slot renew failed', error);
    }
  }

  private async releaseSignalingSessionSlot(slotId: string): Promise<void> {
    if (this.getSignalingShardCount() <= 1) return;
    if (this.isShardZero()) {
      applySessionSlotRelease(this.getSql(), slotId);
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

  // 口令表的 SQL 全部在 services/signaling/sessionStore.ts；这里只保留 DO 的调用语义。
  private findActiveShareCode(code: string, now: number): ShareCodeRecord | null {
    return readActiveShareCode(this.getSql(), { code, now, tombstoneMs: SHARE_CODE_TOMBSTONE_MS });
  }

  private findActiveShareCodeByPeerId(peerId: string, now: number): ShareCodeRecord | null {
    return readActiveShareCodeByPeerId(this.getSql(), peerId, now);
  }

  private registerShareCode(
    peerId: string,
    secretHash: string,
    requestedCode: string | null,
    now: number,
    ttlMs?: number
  ): ShareCodeAllocationResult {
    // 先清过期行：这样「冲突」只可能来自仍然有效的码，不会把 TTL 清理混进 409。
    purgeExpiredShareCodes(this.getSql(), { now, tombstoneMs: SHARE_CODE_TOMBSTONE_MS });

    // 改绑必须先证明自己就是原来的持有者：否则任何知道口令的人都能用「码 -> peerId」
    // 查到发送方 id，再用自己的 HMAC 覆盖这行记录，把仍在进行的分享劫走。
    // 活跃行与 24h 墓碑都算归属证明，覆盖「先 revoke 再抢绑」的窗口。
    const existingBinding = readActiveShareCodeByPeerId(this.getSql(), peerId, now);
    const tombstone = readRecentShareCodeTombstone(this.getSql(), {
      peerId,
      now,
      tombstoneMs: SHARE_CODE_TOMBSTONE_MS,
    });
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
    deleteShareCodesForPeer(this.getSql(), peerId);

    return allocateShareCode({
      peerId,
      secretHash,
      code: requestedCode,
      now,
      ttlMs,
      tryInsert: (record) => insertShareCodeRow(this.getSql(), record, now),
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
    return applyDeferredShareCodeRevoke(this.getSql(), record, revokeAfter);
  }

  private resumeShareCode(record: ShareCodeRecord): boolean {
    return applyResumeShareCode(this.getSql(), record);
  }

  private revokeShareCode(record: ShareCodeRecord, now: number): boolean {
    return applyRevokeShareCode(this.getSql(), record, now);
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
        return new Response(SHARE_CODE_ERROR_MESSAGES.invalidCode, { status: 400 });
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
      if (!record) {
        // 未命中走 shard 0 的全局预算：逐码锁定会被人用轮换码打满内存，也帮攻击者
        // 确认「这个码存在但被锁了」。预算满了就 fail closed，命中路径不受影响。
        const budget = this.unknownShareCodeBudget.consume(now);
        signalingTelemetry.record('share_code_lookup_miss', {
          shardCount: this.getSignalingShardCount(),
          budgetExhausted: !budget.allowed,
        });
        if (!budget.allowed) {
          return new Response(SHARE_CODE_ERROR_MESSAGES.rateLimited, {
            status: 429,
            headers: { 'Retry-After': String(SHARE_CODE_UNKNOWN_LOOKUP_RETRY_AFTER_SECONDS) },
          });
        }
        return new Response('Not Found', { status: 404 });
      }
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
    signalingTelemetry.record('signal_session_conflict', { shardCount: this.getSignalingShardCount() });
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

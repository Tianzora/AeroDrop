import { SHARE_CODE_UNKNOWN_LOOKUP_RETRY_AFTER_SECONDS } from '../constants/signaling';
/** 全局未知码预算耗尽后建议的退避秒数（DO 返回 429 的 Retry-After）。 */
export { SHARE_CODE_UNKNOWN_LOOKUP_RETRY_AFTER_SECONDS } from '../constants/signaling';

// 配对身份登记表的纯逻辑：码生成、secret 绑定校验、TTL、分配决策。
// 这里不碰存储，Worker/DO 只把 SQLite 行与请求参数传进来，便于 node:test 直接覆盖。

export const SHARE_CODE_DIGITS = 6;
export const SHARE_CODE_MIN_VALUE = 100000;
export const SHARE_CODE_SPAN = 900000;
export const SHARE_CODE_PATTERN = /^\d{6}$/;
export const SHARE_CODE_TTL_MS = 60 * 60 * 1000;
/** 发送方可以要求更长的有效期（10m / 1h / 1d），但服务端最多给 24 小时。 */
export const clampShareCodeTtlSeconds = (seconds: number): number =>
  Math.min(SHARE_CODE_MAX_TTL_MS / 1000, Math.max(SHARE_CODE_MIN_TTL_MS / 1000, Math.round(seconds)));

export const SHARE_CODE_MIN_TTL_MS = 60 * 1000;
export const SHARE_CODE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export const normalizeShareCodeTtlMs = (ttlMs?: number | null): number => {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
    return SHARE_CODE_TTL_MS;
  }
  return Math.min(SHARE_CODE_MAX_TTL_MS, Math.max(SHARE_CODE_MIN_TTL_MS, Math.floor(ttlMs)));
};
export const SHARE_CODE_MAX_INSERT_ATTEMPTS = 8;
export const SHARE_CODE_MAX_BODY_BYTES = 4096;
export const SHARE_CODE_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const SHARE_CODE_MIN_TOKEN_LENGTH = 16;
export const SHARE_CODE_MAX_TOKEN_LENGTH = 256;
export const SHARE_CODE_HASH_ALGORITHM = 'HMAC-SHA-256';
export const SHARE_CODE_TAKEN_BODY = { error: 'code already in use' } as const;

export const SHARE_CODE_REBIND_REJECTED_BODY = { error: 'peer id already registered' } as const;

// 旧版 4 位口令形状的 peerId：已不再支持，仅用于给出明确的拒绝理由。
export const LEGACY_SHARE_PEER_ID_PATTERN = /^aerodrop-\d{4}$/;
// 新 peerId：UUID 或 runtime 默认的 peer-<uuid>，只允许 URL 安全字符。
export const SHARE_PEER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type ShareCodeRecord = {
  code: string;
  peerId: string;
  secretHash: string;
  expiresAt: number;
};

export type ShareCodeRegistrationReason =
  | 'invalid-peer-id'
  | 'legacy-peer-id'
  | 'unauthorized';

export type ShareCodeRegistrationDecision =
  | { allowed: true }
  | { allowed: false; reason: ShareCodeRegistrationReason };

export type ValidatedShareCodeCreatePayload =
  | { ok: true; peerId: string; secretHash: string; code: string | null; ttlMs?: number }
  | { ok: false; error: string };

export type ShareCodeAllocationResult =
  | { status: 'ok'; record: ShareCodeRecord }
  | { status: 'taken' }
  // 客户端持有的 peerId 已被别的 secret 绑定：拒绝覆盖，避免知道口令的人把码劫走。
  | { status: 'rebind-rejected' };

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
};

/** 常量时间比较：给凭证类摘要用，避免按字节提前返回泄漏前缀。 */
export const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
};

export const isLegacySharePeerId = (peerId: string): boolean =>
  LEGACY_SHARE_PEER_ID_PATTERN.test(peerId);

export const isValidSharePeerId = (peerId: string): boolean =>
  SHARE_PEER_ID_PATTERN.test(peerId) && !isLegacySharePeerId(peerId);

export const normalizeShareCode = (raw: string | null | undefined): string | null => {
  const trimmed = raw?.trim() ?? '';
  return SHARE_CODE_PATTERN.test(trimmed) ? trimmed : null;
};

export const isValidShareCodeSecretHash = (secretHash: unknown): secretHash is string =>
  typeof secretHash === 'string' && SHARE_CODE_SECRET_HASH_PATTERN.test(secretHash.toLowerCase());

export const isValidSignalingToken = (token: unknown): token is string =>
  typeof token === 'string'
  && token.length >= SHARE_CODE_MIN_TOKEN_LENGTH
  && token.length <= SHARE_CODE_MAX_TOKEN_LENGTH;

/** 密码学均匀的整数：拒绝采样避免取模偏置。 */
export const randomInt = (maxExclusive: number): number => {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error('randomInt requires a positive integer bound');
  }

  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);

  return value % maxExclusive;
};

export const generateShareCode = (nextInt: (maxExclusive: number) => number = randomInt): string =>
  String(SHARE_CODE_MIN_VALUE + nextInt(SHARE_CODE_SPAN));

export const createShareCodeRecord = (input: {
  code: string;
  peerId: string;
  secretHash: string;
  now: number;
  ttlMs?: number;
}): ShareCodeRecord => ({
  code: input.code,
  peerId: input.peerId,
  secretHash: input.secretHash,
  expiresAt: input.now + normalizeShareCodeTtlMs(input.ttlMs),
});

export const isShareCodeRecordExpired = (record: ShareCodeRecord, now: number): boolean =>
  record.expiresAt <= now;

/** secretHash = HMAC-SHA-256(key = secret, message = peerId)，hex 小写。 */
export const computeShareCodeSecretHash = async (secret: string, peerId: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(peerId));
  return toHex(signature);
};

export const verifyShareCodeSecretHash = async (
  storedSecretHash: string,
  secret: string,
  peerId: string
): Promise<boolean> => {
  const computed = await computeShareCodeSecretHash(secret, peerId);
  return constantTimeEqual(storedSecretHash.toLowerCase(), computed);
};

export const validateShareCodeCreatePayload = (payload: unknown): ValidatedShareCodeCreatePayload => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }

  const { peerId, secretHash, code, ttlSeconds } = payload as {
    peerId?: unknown;
    secretHash?: unknown;
    code?: unknown;
    ttlSeconds?: unknown;
  };
  if (typeof peerId !== 'string' || !isValidSharePeerId(peerId.trim())) {
    return { ok: false, error: 'peerId must be a random 8-128 char [A-Za-z0-9_-] id' };
  }
  if (!isValidShareCodeSecretHash(secretHash)) {
    return { ok: false, error: 'secretHash must be a 64 char hex HMAC-SHA-256 digest' };
  }
  if (code !== undefined && code !== null && normalizeShareCode(typeof code === 'string' ? code : null) === null) {
    return { ok: false, error: 'code must be six digits' };
  }

  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
      return { ok: false, error: 'ttlSeconds must be a number' };
    }
    if (ttlSeconds < SHARE_CODE_MIN_TTL_MS / 1000 || ttlSeconds > SHARE_CODE_MAX_TTL_MS / 1000) {
      return { ok: false, error: 'ttlSeconds must be between 60 and 86400' };
    }
  }

  return {
    ok: true,
    peerId: peerId.trim(),
    secretHash: secretHash.toLowerCase(),
    code: normalizeShareCode(typeof code === 'string' ? code : null),
    ...(typeof ttlSeconds === 'number' ? { ttlMs: Math.floor(ttlSeconds * 1000) } : {}),
  };
};

/**
 * 分配一张码：带 code 时只试一次（冲突即 taken）；不带时随机生成并重试。
 * tryInsert 负责真正持久化（DO 用 INSERT ... ON CONFLICT(code) DO NOTHING），
 * 所以并发两个相同 code 时只会有一个拿到 ok。
 */
export const allocateShareCode = (input: {
  peerId: string;
  secretHash: string;
  code?: string | null;
  now: number;
  ttlMs?: number;
  tryInsert: (record: ShareCodeRecord) => boolean;
  nextInt?: (maxExclusive: number) => number;
  maxAttempts?: number;
}): ShareCodeAllocationResult => {
  if (input.code) {
    const requestedCode = normalizeShareCode(input.code);
    if (!requestedCode) return { status: 'taken' };

    const record = createShareCodeRecord({
      code: requestedCode,
      peerId: input.peerId,
      secretHash: input.secretHash,
      now: input.now,
      ttlMs: input.ttlMs,
    });
    return input.tryInsert(record) ? { status: 'ok', record } : { status: 'taken' };
  }

  const attempts = input.maxAttempts ?? SHARE_CODE_MAX_INSERT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const record = createShareCodeRecord({
      code: generateShareCode(input.nextInt),
      peerId: input.peerId,
      secretHash: input.secretHash,
      now: input.now,
      ttlMs: input.ttlMs,
    });
    if (input.tryInsert(record)) return { status: 'ok', record };
  }

  return { status: 'taken' };
};

/**
 * WS 注册校验：带 code+token 时必面与登记表记录完全对应；旧 4 位口令形状的
 * peerId 直接拒绝。不带 code/token 的随机 peerId 放行（接收方/屏幕共享只用于被叫）。
 */
export const resolveShareCodeRegistration = async (input: {
  peerId: string;
  code?: string | null;
  token?: string | null;
  now: number;
  findShareCode: (code: string) => ShareCodeRecord | null;
  findShareCodeByPeerId?: (peerId: string) => ShareCodeRecord | null;
}): Promise<ShareCodeRegistrationDecision> => {
  const peerId = input.peerId.trim();
  if (isLegacySharePeerId(peerId)) {
    return { allowed: false, reason: 'legacy-peer-id' };
  }
  if (!isValidSharePeerId(peerId)) {
    return { allowed: false, reason: 'invalid-peer-id' };
  }

  const hasCode = typeof input.code === 'string' && input.code.trim().length > 0;
  const hasToken = typeof input.token === 'string' && input.token.length > 0;
  if (!hasCode && !hasToken) {
    // 无凭证注册只允许给「没有被分享口令绑定」的 id（接收方/观看端）。
    // 否则任何拿到 6 位码的人都能查到发送方 peerId，抢在发送方重连前占住它。
    const binding = input.findShareCodeByPeerId?.(peerId);
    if (binding && !isShareCodeRecordExpired(binding, input.now)) {
      return { allowed: false, reason: 'unauthorized' };
    }
    return { allowed: true };
  }

  const code = normalizeShareCode(input.code);
  if (!code || !isValidSignalingToken(input.token)) {
    return { allowed: false, reason: 'unauthorized' };
  }

  const record = input.findShareCode(code);
  if (!record || record.peerId !== peerId) {
    return { allowed: false, reason: 'unauthorized' };
  }
  if (isShareCodeRecordExpired(record, input.now)) {
    return { allowed: false, reason: 'unauthorized' };
  }

  const matches = await verifyShareCodeSecretHash(record.secretHash, input.token, peerId);
  return matches ? { allowed: true } : { allowed: false, reason: 'unauthorized' };
};

export const SHARE_CODE_FORBIDDEN_BODY = { error: 'forbidden' } as const;

/**
 * 口令相关的对外错误文案只在这里定义：Worker 的 HTTP 层与 DO 的内部端点共用一份，
 * 避免同一句话在两个文件里各写一版、改一处漏一处。
 */
export const SHARE_CODE_ERROR_MESSAGES = {
  invalidCode: 'code must be six digits',
  notFound: 'Share code not found',
  notFoundOrExpired: 'Share code not found or expired',
  lookupFailed: 'Share code lookup failed',
  allocationFailed: 'Share code allocation failed',
  rateLimited: 'Too many requests',
} as const;

/** 凭据类操作（revoke / resume）失败文案；不区分「码不存在」与「凭证不匹配」。 */
export const shareCodeErrorMessage = (op: 'revoke' | 'resume'): string => `Share code ${op} failed`;


export type ShareCodeRevokeDecision = { allowed: true } | { allowed: false };

/**
 * 注销校验：peerId 必须与登记行一致，且请求体里的 secretHash 与存库哈希常量时间相等。
 * 调用方不能据此区分「码不存在」与「凭证不匹配」（两者都是 not-allowed），避免把
 * revoke 变成「这个 6 位码是否已被占用」的探测接口。
 */
export const verifyShareCodeRevoke = (input: {
  record: ShareCodeRecord | null;
  peerId: string;
  secretHash: string;
}): ShareCodeRevokeDecision => {
  if (!input.record) return { allowed: false };
  if (input.record.peerId !== input.peerId) return { allowed: false };
  if (!isValidShareCodeSecretHash(input.secretHash)) return { allowed: false };

  return {
    allowed: constantTimeEqual(input.record.secretHash.toLowerCase(), input.secretHash.toLowerCase()),
  };
};

/**
 * 改绑 peerId 时的归属校验：活跃行与 24h 墓碑都只认原 secretHash。
 * 只看活跃行会留下「先 revoke 再抢绑」的窗口；只看墓碑则会让仍在持码的发送端
 * 在续期时被自己的旧墓碑挡住。两者都匹配才允许覆盖。
 */
export const shouldRejectShareCodeRebind = (input: {
  activeSecretHash: string | null;
  tombstoneSecretHash: string | null;
  requestSecretHash: string;
}): boolean => {
  const request = input.requestSecretHash.toLowerCase();
  if (input.activeSecretHash && input.activeSecretHash.toLowerCase() !== request) return true;
  if (input.tombstoneSecretHash && input.tombstoneSecretHash.toLowerCase() !== request) return true;
  return false;
};

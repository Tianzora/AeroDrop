// 配对身份登记表的纯逻辑：码生成、secret 绑定校验、TTL、分配决策。
// 这里不碰存储，Worker/DO 只把 SQLite 行与请求参数传进来，便于 node:test 直接覆盖。

export const SHARE_CODE_DIGITS = 6;
export const SHARE_CODE_MIN_VALUE = 100000;
export const SHARE_CODE_SPAN = 900000;
export const SHARE_CODE_PATTERN = /^\d{6}$/;
export const SHARE_CODE_TTL_MS = 60 * 60 * 1000;
export const SHARE_CODE_MAX_INSERT_ATTEMPTS = 8;
export const SHARE_CODE_MAX_BODY_BYTES = 4096;
export const SHARE_CODE_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const SHARE_CODE_MIN_TOKEN_LENGTH = 16;
export const SHARE_CODE_MAX_TOKEN_LENGTH = 256;
export const SHARE_CODE_HASH_ALGORITHM = 'HMAC-SHA-256';
export const SHARE_CODE_TAKEN_BODY = { error: 'code already in use' } as const;

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
  | { ok: true; peerId: string; secretHash: string; code: string | null }
  | { ok: false; error: string };

export type ShareCodeAllocationResult =
  | { status: 'ok'; record: ShareCodeRecord }
  | { status: 'taken' };

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
};

const constantTimeEqual = (left: string, right: string): boolean => {
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
}): ShareCodeRecord => ({
  code: input.code,
  peerId: input.peerId,
  secretHash: input.secretHash,
  expiresAt: input.now + SHARE_CODE_TTL_MS,
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

  const { peerId, secretHash, code } = payload as { peerId?: unknown; secretHash?: unknown; code?: unknown };
  if (typeof peerId !== 'string' || !isValidSharePeerId(peerId.trim())) {
    return { ok: false, error: 'peerId must be a random 8-128 char [A-Za-z0-9_-] id' };
  }
  if (!isValidShareCodeSecretHash(secretHash)) {
    return { ok: false, error: 'secretHash must be a 64 char hex HMAC-SHA-256 digest' };
  }
  if (code !== undefined && code !== null && normalizeShareCode(typeof code === 'string' ? code : null) === null) {
    return { ok: false, error: 'code must be six digits' };
  }

  return {
    ok: true,
    peerId: peerId.trim(),
    secretHash: secretHash.toLowerCase(),
    code: normalizeShareCode(typeof code === 'string' ? code : null),
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

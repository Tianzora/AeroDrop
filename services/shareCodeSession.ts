/**
 * 口令会话：把「注册/兑换口令」与 UI 解耦，并提供 E2E 可注入的覆盖点。
 *
 * 契约（与 src/worker.ts 的 /api/share-code 对齐）：
 * - 6 位数字；发送方可自定义（已被占用返回 taken）
 * - 注册成功后发送方用 secret 作为信令 token，服务端用 HMAC(secret, peerId) 校验
 */

import { getAeroDropE2EHooks } from './e2eHooks';
import { revokeShareCode } from './shareCodeClient';

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** 32 字节随机 secret，作为信令 token。 */
const createShareSecret = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);

/** 与 Worker 的 SignalingHub 一致：HMAC-SHA256(key = secret, message = peerId)。 */
const computeShareSecretHash = async (secret: string, peerId: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(peerId));
  return toHex(signature);
};

export const SHARE_CODE_DIGITS = 6;

const SHARE_CODE_PATTERN = /^\d{6}$/;

export const isValidShareCode = (code: string): boolean => SHARE_CODE_PATTERN.test(code.trim());

export const normalizeShareCodeInput = (value: string): string =>
  value.replace(/[^0-9]/g, '').slice(0, SHARE_CODE_DIGITS);

export type ShareCodeFailureReason = 'taken' | 'rate-limited' | 'invalid' | 'failed';

export type ShareCodeRequestResult =
  | { status: 'ok'; code: string; expiresAt: number; peerId: string; secret: string }
  | { status: Exclude<ShareCodeFailureReason, 'invalid'>; retryAfterMs?: number };

const isSixDigits = (value: unknown): value is string =>
  typeof value === 'string' && SHARE_CODE_PATTERN.test(value);

/**
 * 发送方：生成随机 peerId + secret，登记口令（可请求自定义 6 位码）。
 */
export const requestShareCode = async (input: {
  peerId: string;
  requestedCode?: string;
  /** 可选有效期（秒），服务端限制 60..86400；不传按 1 小时。 */
  ttlSeconds?: number;
  /** 重新登记/续期时复用已有 secret，保持 peerId 与 HMAC 的绑定不变。 */
  secret?: string;
}): Promise<ShareCodeRequestResult> => {
  if (input.requestedCode && !isSixDigits(input.requestedCode)) {
    return { status: 'failed' };
  }

  const secret = input.secret && input.secret.length >= 16 ? input.secret : createShareSecret();
  const secretHash = await computeShareSecretHash(secret, input.peerId);

  const hooks = getAeroDropE2EHooks();
  if (hooks?.createShareCodeOverride) {
    const override = hooks.createShareCodeOverride({
      peerId: input.peerId,
      secretHash,
      code: input.requestedCode,
    });
    if (!override || !isSixDigits(override.code)) {
      return { status: 'failed' };
    }
    return {
      status: 'ok',
      code: override.code,
      expiresAt: override.expiresAt,
      peerId: input.peerId,
      secret,
    };
  }

  try {
    const response = await fetch('/api/share-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerId: input.peerId,
        secretHash,
        ...(input.requestedCode ? { code: input.requestedCode } : {}),
        ...(typeof input.ttlSeconds === 'number' ? { ttlSeconds: input.ttlSeconds } : {}),
      }),
      cache: 'no-store',
    });

    if (response.status === 409) {
      return { status: 'taken' };
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
      return {
        status: 'rate-limited',
        retryAfterMs: Number.isFinite(retryAfter) ? Math.max(1, retryAfter) * 1000 : undefined,
      };
    }
    if (!response.ok) {
      return { status: 'failed' };
    }

    const payload = (await response.json()) as { code?: unknown; expiresAt?: unknown };
    if (!isSixDigits(payload.code)) {
      return { status: 'failed' };
    }

    return {
      status: 'ok',
      code: payload.code,
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : Date.now() + 3_600_000,
      peerId: input.peerId,
      secret,
    };
  } catch {
    return { status: 'failed' };
  }
};

/**
 * 接收方：用 6 位口令兑换发送方的 peerId。
 */
/**
 * 发送方结束分享时注销口令。凭证不对/码已过期都当作「已失效」，不需要报错。
 */
export const revokeShareSession = async (input: {
  code: string;
  peerId: string;
  secret: string;
}): Promise<boolean> => {
  if (!isSixDigits(input.code) || !input.peerId || !input.secret) {
    return false;
  }

  const secretHash = await computeShareSecretHash(input.secret, input.peerId);
  const result = await revokeShareCode({ code: input.code, peerId: input.peerId, secretHash });
  return result.status === 'ok' || result.status === 'not-found' || result.status === 'forbidden';
};

export const lookupSharePeerId = async (code: string): Promise<string | null> => {
  if (!isSixDigits(code)) {
    return null;
  }

  const hooks = getAeroDropE2EHooks();
  if (hooks?.resolveShareCodeOverride) {
    return hooks.resolveShareCodeOverride(code)?.peerId ?? null;
  }

  try {
    const response = await fetch(`/api/share-code?code=${encodeURIComponent(code)}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { peerId?: unknown };
    return typeof payload.peerId === 'string' && payload.peerId.length > 0 ? payload.peerId : null;
  } catch {
    return null;
  }
};

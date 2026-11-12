// /api/share-code 的浏览器端封装：把 409 / 429 映射成可分支的结果，不抛异常。
import { CONNECTION_TIMINGS } from '../constants/transfer.ts';
import { computeShareCodeSecretHash, normalizeShareCode } from './shareCodeRegistry.ts';

export type ShareCodeClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type RegisterShareCodeInput = {
  peerId: string;
  secretHash: string;
  code?: string;
};

export type RegisterShareCodeResult =
  | { status: 'ok'; code: string; expiresAt: number }
  | { status: 'taken' }
  | { status: 'rate-limited'; retryAfterMs: number }
  | { status: 'failed'; error: string };

export type LookupShareCodeResult =
  | { status: 'ok'; peerId: string; expiresAt: number }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterMs: number }
  | { status: 'failed'; error: string };

export type RevokeShareCodeInput = {
  code: string;
  peerId: string;
  secretHash: string;
  /** >0 时服务端只登记待注销时间，窗口内可用同一凭证 resume。 */
  graceMs?: number;
};

export type RevokeShareCodeResult =
  | { status: 'ok'; code: string; deferredUntil?: number }
  | { status: 'forbidden' }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterMs: number }
  | { status: 'failed'; error: string };

export type ResumeShareCodeInput = {
  code: string;
  peerId: string;
  secretHash: string;
};

export type ResumeShareCodeResult =
  | { status: 'ok'; code: string }
  | { status: 'forbidden' }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterMs: number }
  | { status: 'failed'; error: string };

const DEFAULT_RETRY_AFTER_MS = 10_000;

const resolveFetch = (options: ShareCodeClientOptions): typeof fetch =>
  options.fetchImpl ?? fetch;

const resolveApiUrl = (options: ShareCodeClientOptions, path: string): string => {
  const base = options.baseUrl?.replace(/\/$/, '') ?? '';
  return base + path;
};

const readRetryAfterMs = (response: Response): number => {
  const header = response.headers.get('Retry-After');
  const seconds = header ? Number.parseInt(header, 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === 'string' ? payload.error : 'Share code request failed';
  } catch {
    return 'Share code request failed';
  }
};

export const registerShareCode = async (
  input: RegisterShareCodeInput,
  options: ShareCodeClientOptions = {}
): Promise<RegisterShareCodeResult> => {
  if (input.code !== undefined && input.code !== '' && normalizeShareCode(input.code) === null) {
    return { status: 'failed', error: 'code must be six digits' };
  }

  try {
    const response = await resolveFetch(options)(resolveApiUrl(options, '/api/share-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        peerId: input.peerId,
        secretHash: input.secretHash,
        ...(input.code !== undefined && input.code !== '' ? { code: input.code } : {}),
      }),
    });

    if (response.status === 409) return { status: 'taken' };
    if (response.status === 429) return { status: 'rate-limited', retryAfterMs: readRetryAfterMs(response) };
    if (!response.ok) return { status: 'failed', error: await readErrorMessage(response) };

    const payload = (await response.json()) as { code?: unknown; expiresAt?: unknown };
    if (typeof payload.code !== 'string' || typeof payload.expiresAt !== 'number') {
      return { status: 'failed', error: 'Share code response is malformed' };
    }
    return { status: 'ok', code: payload.code, expiresAt: payload.expiresAt };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'Share code request failed' };
  }
};

export const lookupShareCode = async (
  code: string,
  options: ShareCodeClientOptions = {}
): Promise<LookupShareCodeResult> => {
  const normalized = normalizeShareCode(code);
  if (!normalized) return { status: 'failed', error: 'code must be six digits' };

  try {
    const response = await resolveFetch(options)(
      resolveApiUrl(options, '/api/share-code?code=' + encodeURIComponent(normalized)),
      { method: 'GET', cache: 'no-store' }
    );

    if (response.status === 404) return { status: 'not-found' };
    if (response.status === 429) return { status: 'rate-limited', retryAfterMs: readRetryAfterMs(response) };
    if (!response.ok) return { status: 'failed', error: await readErrorMessage(response) };

    const payload = (await response.json()) as { peerId?: unknown; expiresAt?: unknown };
    if (typeof payload.peerId !== 'string' || typeof payload.expiresAt !== 'number') {
      return { status: 'failed', error: 'Share code response is malformed' };
    }
    return { status: 'ok', peerId: payload.peerId, expiresAt: payload.expiresAt };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'Share code request failed' };
  }
};

type ShareCodeCredentialAction = 'revoke' | 'resume';

const changeShareCodeState = async (
  input: { code: string; peerId: string; secretHash: string },
  action: ShareCodeCredentialAction,
  options: ShareCodeClientOptions,
  extra: { graceMs?: number } = {}
): Promise<RevokeShareCodeResult> => {
  const normalized = normalizeShareCode(input.code);
  if (!normalized) return { status: 'failed', error: 'code must be six digits' };
  if (!input.peerId || !input.secretHash) {
    return { status: 'failed', error: 'peerId and secretHash are required' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONNECTION_TIMINGS.SHARE_CODE_LOOKUP_TIMEOUT_MS
  );
  try {
    const response = await resolveFetch(options)(
      resolveApiUrl(options, '/api/share-code/' + encodeURIComponent(normalized) + '/' + action),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({
          peerId: input.peerId,
          secretHash: input.secretHash,
          ...(extra.graceMs && extra.graceMs > 0 ? { graceMs: extra.graceMs } : {}),
        }),
      }
    );

    // 403 = 凭证不对或码已不存在；两者在服务端故意不可区分。
    if (response.status === 403) return { status: 'forbidden' };
    if (response.status === 404) return { status: 'not-found' };
    if (response.status === 429) return { status: 'rate-limited', retryAfterMs: readRetryAfterMs(response) };
    if (!response.ok) return { status: 'failed', error: await readErrorMessage(response) };
    const payload = (await response.json().catch(() => ({}))) as { deferredUntil?: unknown };
    return {
      status: 'ok',
      code: normalized,
      ...(typeof payload.deferredUntil === 'number' ? { deferredUntil: payload.deferredUntil } : {}),
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'Share code request failed' };
  } finally {
    clearTimeout(timeout);
  }
};

export const revokeShareCode = (
  input: RevokeShareCodeInput,
  options: ShareCodeClientOptions = {}
): Promise<RevokeShareCodeResult> => changeShareCodeState(input, 'revoke', options, { graceMs: input.graceMs });

export const resumeShareCode = (
  input: ResumeShareCodeInput,
  options: ShareCodeClientOptions = {}
): Promise<ResumeShareCodeResult> => changeShareCodeState(input, 'resume', options);

// 与 shareCodeSession 的契约：secret 用 32 字节随机 hex，绑定哈希走 registry 的同一实现。
export const SHARE_CODE_SECRET_BYTES = 32;

export const createShareSecret = (): string => {
  const bytes = new Uint8Array(SHARE_CODE_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const computeShareSecretHash = (secret: string, peerId: string): Promise<string> =>
  computeShareCodeSecretHash(secret, peerId);

import {
  DEFAULT_SELF_HOSTED_TURN_TTL_SECONDS,
  MAX_SELF_HOSTED_TURN_TTL_SECONDS,
  MIN_SELF_HOSTED_TURN_TTL_SECONDS,
} from '../constants/signaling';

export type SelfHostedTurnEnv = {
  TURN_URLS?: string;
  TURN_SHARED_SECRET?: string;
  TURN_REALM?: string;
  TURN_TTL_SECONDS?: string;
};

export type TurnIceServer = {
  urls: string | string[];
  username: string;
  credential: string;
};

type IceServerWithUrls = {
  urls: string | string[];
};

export const parseTurnUrls = (value: string | undefined): string[] => {
  if (!value) return [];
  const urls = value
    .split(/[\r\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean);

  if (urls.length === 0 || urls.some((url) => !/^turns?:/i.test(url))) {
    return [];
  }

  return Array.from(new Set(urls));
};

const isTurnUdpUrl = (url: string) => {
  const normalized = url.trim();
  return /^turn:/i.test(normalized)
    && !/[?&]transport=tcp(?:&|$)/i.test(normalized);
};

export const omitTurnUdpIceServers = <T extends IceServerWithUrls>(iceServers: T[]): T[] => {
  return iceServers.flatMap((server) => {
    const wasArray = Array.isArray(server.urls);
    const sourceUrls: string[] = Array.isArray(server.urls) ? server.urls : [server.urls];
    const urls = sourceUrls.filter((url) => !isTurnUdpUrl(url));
    if (urls.length === 0) return [];
    return [{
      ...server,
      urls: wasArray ? urls : urls[0],
    } as T];
  });
};

export const hasTurnIceServers = <T extends IceServerWithUrls>(iceServers: T[]) => {
  return iceServers.some((server) => {
    const urls: string[] = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(url.trim()));
  });
};

export const selectReliableIceServers = <T extends IceServerWithUrls>(
  providers: T[][],
  fallback: T[],
): T[] => {
  for (const provider of providers) {
    const reliable = omitTurnUdpIceServers(provider);
    if (hasTurnIceServers(reliable)) return reliable;
  }
  return omitTurnUdpIceServers(fallback);
};

export const getTurnTtlSeconds = (value: string | undefined): number => {
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_SELF_HOSTED_TURN_TTL_SECONDS;
  const ttl = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SELF_HOSTED_TURN_TTL_SECONDS;
  return Math.min(MAX_SELF_HOSTED_TURN_TTL_SECONDS, Math.max(MIN_SELF_HOSTED_TURN_TTL_SECONDS, ttl));
};

const toBase64 = (bytes: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export const createSelfHostedTurnIceServer = async (
  env: SelfHostedTurnEnv,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<TurnIceServer | null> => {
  const urls = parseTurnUrls(env.TURN_URLS);
  const sharedSecret = env.TURN_SHARED_SECRET;
  const realm = env.TURN_REALM?.trim();
  if (urls.length === 0 || !sharedSecret || !realm) return null;

  const username = `${Math.floor(nowSeconds) + getTurnTtlSeconds(env.TURN_TTL_SECONDS)}:${realm}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(sharedSecret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(username));

  return {
    urls: urls.length === 1 ? urls[0] : urls,
    username,
    credential: toBase64(signature),
  };
};

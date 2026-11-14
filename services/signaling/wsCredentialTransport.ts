// WebSocket 凭证传输：把 `code` / `token` / `sessionSecretHash` / `sessionProof` 从
// URL query 挪到 `Sec-WebSocket-Protocol` 里。
//
// 为什么：URL 会进接入日志、边缘/代理的请求行、浏览器历史与 `Referer` 类遥测。这些字段
// 是 bearer 凭证——`sessionProof` 被抢用会轮换掉原持有者的 proof，把它锁成 4010（绑定
// 24h 内）；`token` 被抢用等价于把分享口令的另一半也交出去。
//
// 协议头是浏览器唯一能带自定义数据、又不进 URL 的通道：客户端把凭证塞进一个
// `aerodrop.creds.v1.<base64url>` 伪协议，同时附加一个非秘密的 `aerodrop.v1`，服务端只
// 回显后者。规矩来自 WebSocket 握手本身：服务端回显的协议名必须是客户端提供的之一，
// 客户端提供了协议而服务端一个都不回显时，浏览器直接判定握手失败。
//
// base64url 手工实现（不走 btoa）：btoa 只接受 Latin-1，token/口令里的非 ASCII 字符会
// 抛 InvalidCharacterError。子协议名的字符集（RFC 7230 tchar）包含 A-Z a-z 0-9 与 `-` `_`
// `.`，所以 base64url 字母表天然合法，不需要再做转义。

export const WS_BASE_PROTOCOL = 'aerodrop.v1';
export const WS_CREDENTIAL_PROTOCOL_PREFIX = 'aerodrop.creds.v1.';

/** 与旧 query 参数同名同义：一个字段同时出现在两处时，协议头优先。 */
export type WsCredentials = {
  code?: string;
  token?: string;
  sessionSecretHash?: string;
  sessionProof?: string;
};

const CREDENTIAL_KEYS = ['code', 'token', 'sessionSecretHash', 'sessionProof'] as const;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_LOOKUP = (() => {
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
    lookup[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  }
  return lookup;
})();

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const encodeBase64Url = (bytes: Uint8Array): string => {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[((first & 0b11) << 4) | (second >> 4)];
    if (index + 1 < bytes.length) {
      encoded += BASE64URL_ALPHABET[((second & 0b1111) << 2) | (third >> 6)];
    }
    if (index + 2 < bytes.length) {
      encoded += BASE64URL_ALPHABET[third & 0b111111];
    }
  }
  return encoded;
};

/** 非法字符 / 非法长度一律返回 null：调用方据此回落到 query，不抛异常。 */
const decodeBase64Url = (value: string): Uint8Array | null => {
  // 4n+1 个字符不可能由任何字节序列编码出来（base64url 不以单个字符收尾）。
  if (value.length === 0 || value.length % 4 === 1) return null;

  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let offset = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    // 非 ASCII（含代理对的一半）直接判非法，避免把被错误转码的内容当成凭证。
    const sextet = charCode < 128 ? BASE64URL_LOOKUP[charCode] : -1;
    if (sextet < 0) return null;
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return bytes.subarray(0, offset);
};

/** 把 `Sec-WebSocket-Protocol` 拆成协议名列表；空/缺失返回空数组。 */
export const parseWsProtocols = (header: string | null | undefined): string[] => {
  if (!header) return [];
  return header
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
};

const toCredentials = (value: unknown): WsCredentials | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const credentials: WsCredentials = {};
  for (const key of CREDENTIAL_KEYS) {
    const entry = record[key];
    if (entry === undefined || entry === null) continue;
    // 类型不对说明带着别的东西冒充：整条拒绝，而不是丢掉坏字段继续用剩下的。
    if (typeof entry !== 'string') return null;
    if (entry.length === 0) continue;
    credentials[key] = entry;
  }
  return credentials;
};

/**
 * 编码客户端要发送的凭证。
 * `protocol` 是带凭证的伪协议；`baseProtocol` 是非秘密的回显协议，必须一起发送，
 * 否则服务端没有可以回显的协议名，浏览器会判定握手失败。
 */
export const encodeWsCredentials = (
  credentials: WsCredentials
): { protocol: string; baseProtocol: string } => {
  const payload: Record<string, string> = {};
  for (const key of CREDENTIAL_KEYS) {
    const entry = credentials[key];
    if (entry) payload[key] = entry;
  }
  const encoded = encodeBase64Url(utf8Encoder.encode(JSON.stringify(payload)));
  return {
    protocol: `${WS_CREDENTIAL_PROTOCOL_PREFIX}${encoded}`,
    baseProtocol: WS_BASE_PROTOCOL,
  };
};

/**
 * 从协议列表里找回凭证：命中第一个 `aerodrop.creds.v1.` 开头的协议。
 * 坏 base64 / 坏 JSON / 字段类型不对 / 没有匹配项都返回 null（调用方回落 query）。
 */
export const decodeWsCredentials = (protocols: readonly string[]): WsCredentials | null => {
  for (const raw of protocols) {
    const protocol = raw.trim();
    // 前缀按忽略大小写匹配：某些代理会改写协议名的大小写。载荷本身只有原样才能解出，
    // 被改写过的载荷会解码失败并回落到 query——安全上等价于旧行为。
    if (!protocol.toLowerCase().startsWith(WS_CREDENTIAL_PROTOCOL_PREFIX)) continue;
    const payload = protocol.slice(WS_CREDENTIAL_PROTOCOL_PREFIX.length);
    const bytes = decodeBase64Url(payload);
    if (bytes === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8Decoder.decode(bytes)) as unknown;
    } catch {
      return null;
    }
    return toCredentials(parsed);
  }
  return null;
};

/**
 * 101 响应要回显的协议名。只回显非秘密的 `aerodrop.v1`，绝不回显凭证协议；客户端没带
 * 就返回 undefined（此时不设 `Sec-WebSocket-Protocol`，旧客户端行为不变）。
 * 返回列表里的原始写法，保证与客户端发送的大小写逐字一致。
 */
export const pickAcceptedProtocol = (protocols: readonly string[]): string | undefined => {
  for (const raw of protocols) {
    const protocol = raw.trim();
    if (protocol.toLowerCase() === WS_BASE_PROTOCOL) return protocol;
  }
  return undefined;
};

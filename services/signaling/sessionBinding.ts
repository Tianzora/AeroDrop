/**
 * 分享会话的身份绑定。
 *
 * 分享链接 `?view=<peerId>` 会把分享者的随机 peerId 暴露给拿到链接的人；而 SignalingHub
 * 允许同 peerId 的新连接接管旧会话（断线重连依赖这个行为）。没有绑定凭证时，任何知道
 * peerId 的人都能把分享者顶下线，观众的流全断。
 *
 * 这里只做纯判定与摘要生成，不碰 WebSocket / 存储，让 Worker 与客户端共用同一套规则。
 */

import { constantTimeEqual } from '../shareCodeRegistry';

/** 32 字节随机 secret 的 SHA-256，小写 hex。 */
const SESSION_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/i;

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export const SESSION_SECRET_BYTES = 32;

/** 只接受 64 位 hex；大小写都算合法，比较前统一转小写。 */
export const isValidSessionSecretHash = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_SECRET_HASH_PATTERN.test(value);

export type SessionReplacementDecision = 'allow' | 'reject';

/**
 * 是否允许新连接替换同 peerId 的已有会话。
 *
 * - 旧会话没有绑定 hash：保持历史行为，文件传输与旧版本客户端不受影响。
 * - 双方都有合法 hash 且一致：同一份密钥的重连/重建。
 * - 其余情况（对端缺失、格式非法或不一致）：拒绝，避免知道 peerId 的人顶掉分享者。
 */
export const shouldAcceptSessionReplacement = (input: {
  existingSecretHash?: string | null;
  incomingSecretHash?: string | null;
}): SessionReplacementDecision => {
  if (input.existingSecretHash === undefined || input.existingSecretHash === null) return 'allow';
  if (!isValidSessionSecretHash(input.existingSecretHash)) return 'reject';
  if (!isValidSessionSecretHash(input.incomingSecretHash)) return 'reject';
  return constantTimeEqual(
    input.existingSecretHash.toLowerCase(),
    input.incomingSecretHash.toLowerCase()
  )
    ? 'allow'
    : 'reject';
};

/**
 * 客户端：为一次分享会话生成密钥摘要。明文 secret 不离开内存、也不上行，服务端只比较摘要。
 * 每次开始分享生成一次并复用（重建 peer / 信令重连必须带同一个摘要，否则会被自己拒掉）。
 */
export const createSessionSecretHash = async (): Promise<string> => {
  const secret = crypto.getRandomValues(new Uint8Array(SESSION_SECRET_BYTES));
  return toHex(await crypto.subtle.digest('SHA-256', secret));
};

import {
  SESSION_PROOF_GRACE_MS,
  SESSION_PROOF_HISTORY_LIMIT,
  SESSION_SECRET_BYTES,
  SESSION_SECRET_HASH_GRACE_MS,
} from '../../constants/signaling';
// 常量定义在 constants/signaling.ts；这里重新导出，保持既有导入路径不破。
export {
  SESSION_PROOF_GRACE_MS,
  SESSION_PROOF_HISTORY_LIMIT,
  SESSION_SECRET_BYTES,
  SESSION_SECRET_HASH_GRACE_MS,
} from '../../constants/signaling';

/**
 * 分享会话的身份绑定。
 *
 * 分享链接 `?view=<peerId>` 会把分享者的随机 peerId 暴露给拿到链接的人；而 SignalingHub
 * 允许同 peerId 的新连接接管旧会话（断线重连依赖这个行为）。没有绑定凭证时，任何知道
 * peerId 的人都能把分享者顶下线，观众的流全断。
 *
 * 绑定分两层：
 * 1. 首次注册用 `sessionSecretHash`（分享密钥的 SHA-256，静态 bearer）；
 * 2. 之后每次注册换用服务端签发的 `sessionProof`。proof 只经 WebSocket 文本帧下发，
 *    不进分享链接；每次成功注册后轮换，旧 proof 只在宽限期内可复用（覆盖「新 proof
 *    还没送到客户端，socket 就断了」的窗口）。首层只出现在第一次建连，不再是长期凭证。
 *
 * 这里只做纯判定与生成，不碰 WebSocket / 存储，让 Worker 与客户端共用同一套规则。
 */

import { constantTimeEqual } from '../shareCodeRegistry';

/** 32 字节随机 secret 的 SHA-256，小写 hex。 */
const SESSION_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/i;

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');


/** 只接受 64 位 hex；大小写都算合法，比较前统一转小写。 */
export const isValidSessionSecretHash = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_SECRET_HASH_PATTERN.test(value);

/**
 * 服务端签发的会话凭证。它同样是 64 位 hex，但与分享密钥摘要不同源：客户端不需要知道
 * 任何明文，只把它原样带回下一次注册。服务端只存它的 SHA-256。
 */
export const isValidSessionProof = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_SECRET_HASH_PATTERN.test(value);

export type SessionReplacementDecision = 'allow' | 'reject';

/**
 * 是否允许新连接替换同 peerId 的已有会话（仅看分享密钥摘要，不看 proof）。
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


/** 历史 proof 摘要及其过期时间。只存摘要，明文 proof 只经 WS 下发一次。 */
export type SessionProofHistoryEntry = {
  proofHash: string;
  expiresAt: number;
};

/**
 * 是否接纳这次注册。
 *
 * 一旦会话绑定过 proof，就只认 proof，不再回落到分享密钥摘要：否则拿到一次静态 bearer
 * 的人可以无限次接管。绑定记录本身损坏时也拒绝（fail-closed）。
 */
export const shouldAcceptSessionAdmission = (input: {
  /** 首次绑定时记录的分享密钥摘要；没有绑定记录时为 undefined。 */
  boundSecretHash?: string | null;
  /** 当前有效 proof 的摘要。 */
  storedProofHash?: string | null;
  /** 宽限期内仍可使用的历史 proof 摘要。 */
  recentProofHashes?: ReadonlyArray<SessionProofHistoryEntry> | null;
  /** 首次绑定摘要还能冒充凭证到什么时候（毫秒时间戳，0 表示不可用）。 */
  secretHashGraceExpiresAt?: number | null;
  incomingSecretHash?: string | null;
  incomingProofHash?: string | null;
  now: number;
}): SessionReplacementDecision => {
  const storedProofHash = input.storedProofHash;
  if (storedProofHash === undefined || storedProofHash === null) {
    // 还没轮换过（首次注册 / 旧版本会话）：退回摘要规则，未绑定的会话保持历史行为。
    return shouldAcceptSessionReplacement({
      existingSecretHash: input.boundSecretHash,
      incomingSecretHash: input.incomingSecretHash,
    });
  }
  if (!isValidSessionProof(storedProofHash)) return 'reject';

  const incomingProofHash = input.incomingProofHash;
  if (isValidSessionProof(incomingProofHash)) {
    const normalizedIncoming = incomingProofHash.toLowerCase();
    if (constantTimeEqual(normalizedIncoming, storedProofHash.toLowerCase())) return 'allow';

    for (const entry of input.recentProofHashes ?? []) {
      if (!entry || !isValidSessionProof(entry.proofHash)) continue;
      if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= input.now) continue;
      if (constantTimeEqual(normalizedIncoming, entry.proofHash.toLowerCase())) return 'allow';
    }
  }

  // 兜底：首次注册时服务端已经落库了摘要，但 `registered` 帧（唯一一次下发 proof
  // 的地方）丢失，客户端只能拿摘要重连。只在这个短窗口内放行；否则等于把静态
  // bearer 永久保留下来。
  const graceExpiresAt = input.secretHashGraceExpiresAt;
  if (
    isValidSessionSecretHash(input.boundSecretHash) &&
    isValidSessionSecretHash(input.incomingSecretHash) &&
    Number.isFinite(graceExpiresAt) &&
    (graceExpiresAt as number) > input.now &&
    constantTimeEqual(input.boundSecretHash.toLowerCase(), input.incomingSecretHash.toLowerCase())
  ) {
    return 'allow';
  }
  return 'reject';
};

/**
 * 轮换时的下一份历史：把当前 proof 的摘要挪进宽限期列表，丢掉过期项，并限制条数。
 * 返回新数组，不改入参（Worker 拿它序列化进绑定记录）。
 */
export const buildNextSessionProofHistory = (input: {
  storedProofHash?: string | null;
  recentProofHashes?: ReadonlyArray<SessionProofHistoryEntry> | null;
  now: number;
  graceMs?: number;
}): SessionProofHistoryEntry[] => {
  const graceMs =
    Number.isFinite(input.graceMs) && (input.graceMs ?? 0) > 0
      ? (input.graceMs as number)
      : SESSION_PROOF_GRACE_MS;
  const entries = (input.recentProofHashes ?? []).filter(
    (entry): entry is SessionProofHistoryEntry =>
      Boolean(entry) &&
      isValidSessionProof(entry.proofHash) &&
      Number.isFinite(entry.expiresAt) &&
      entry.expiresAt > input.now
  );
  if (isValidSessionProof(input.storedProofHash)) {
    entries.push({ proofHash: input.storedProofHash, expiresAt: input.now + graceMs });
  }
  return entries.slice(-SESSION_PROOF_HISTORY_LIMIT);
};

/**
 * 客户端：为一次分享会话生成密钥摘要。明文 secret 不离开内存、也不上行，服务端只比较摘要。
 * 每次开始分享生成一次并复用（重建 peer / 信令重连必须带同一个摘要，否则会被自己拒掉）。
 */
export const createSessionSecretHash = async (): Promise<string> => {
  const secret = crypto.getRandomValues(new Uint8Array(SESSION_SECRET_BYTES));
  return toHex(await crypto.subtle.digest('SHA-256', secret));
};

/** 服务端：签发下一代会话凭证（明文只出现在这一条 WebSocket 帧里，落库的是摘要）。 */
export const createSessionProof = (): string => {
  const proof = crypto.getRandomValues(new Uint8Array(SESSION_SECRET_BYTES));
  return Array.from(proof)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

/** 服务端：proof 的摘要。proof 本身高熵，用 SHA-256 只是避免明文落库。 */
export const hashSessionProof = async (proof: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof)));

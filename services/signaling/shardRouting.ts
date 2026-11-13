/**
 * 信令分片路由：把 peerId 稳定映射到一片 Durable Object。
 *
 * 现状是单例 DO（`global-signaling-hub`），所有 WS 会话与口令表都在一个实例里。这里先把
 * 「同一个 peerId 永远落到同一片」这个不变量做成纯函数，让 worker 侧的路由可以先行接入：
 * `SIGNALING_SHARD_COUNT` 未配置时恒为 1，行为与单例完全一致。
 *
 * 选 rendezvous hashing 而不是取模：扩容时取模会把几乎所有键搬走（每个片都要全体重连），
 * 而 rendezvous 在 N → N+1 时只移动约 1/(N+1) 的键，且实现只是「对每个候选片算分取最大」，
 * 不需要维护虚拟节点表。
 */

/** 分片数量上限：分片是 DO 实例，数量直接决定运维与迁移面，不做无限扩张。 */
export const MAX_SIGNALING_SHARDS = 64;

/** shard 0 沿用现有单例名，保证迁移期旧数据与旧连接不动。 */
export const SIGNALING_SHARD_ZERO_NAME = 'global-signaling-hub';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a + murmur3 的 fmix32 收尾。只做 FNV 不够：候选键只差最后一个字符时，结果几乎是
 * 线性递增的（差一个常量），rendezvous 会退化成「总是选最大下标」，扩容时迁移量接近 1/2。
 * fmix32 把高位混进低位后，分数才可当作均匀随机数比较。
 */
const hashKey = (value: string): number => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

/**
 * 分片名：`shard 0` 必须是现有单例名，否则上线即全体断线。
 * 负数/小数按 0 处理（调用方只应传由 rendezvousShardIndex 产出的整数）。
 */
export const signalingShardName = (index: number): string => {
  if (!Number.isFinite(index) || index <= 0) {
    return SIGNALING_SHARD_ZERO_NAME;
  }
  return `signaling-shard-${Math.trunc(index)}`;
};

/** 从 DO 名反解分片下标；无法识别时返回 null（调用方据此判定「不是本片」）。 */
export const signalingShardIndex = (name: string | undefined | null): number | null => {
  if (!name) return null;
  if (name === SIGNALING_SHARD_ZERO_NAME) return 0;
  const match = /^signaling-shard-(\d+)$/.exec(name);
  if (!match) return null;
  const index = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
};

const normalizeShardCount = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  const count = Math.trunc(value);
  if (count < 1) return 1;
  if (count > MAX_SIGNALING_SHARDS) return MAX_SIGNALING_SHARDS;
  return count;
};

/**
 * peerId → 分片下标。同一 peerId 与同一分片数必须永远得到同一结果：注册、转发、内部投递
 * 都依赖这一点，任何随机化都会让会话「时有时无」。
 */
export const rendezvousShardIndex = (peerId: string, shardCount: number): number => {
  const count = normalizeShardCount(shardCount);
  if (count <= 1) return 0;
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < count; index += 1) {
    const score = hashKey(`${peerId}#${index}`);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
};

/**
 * 解析 `SIGNALING_SHARD_COUNT`。空值、非法值一律回落到 1（单例），绝不因为环境变量写错
 * 就把会话拆散；超出范围按边界 clamp。
 */
export const resolveSignalingShardCount = (value: unknown): number => {
  if (typeof value === 'number') return normalizeShardCount(value);
  if (typeof value !== 'string') return 1;
  const trimmed = value.trim();
  if (trimmed === '') return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return 1;
  return normalizeShardCount(parsed);
};

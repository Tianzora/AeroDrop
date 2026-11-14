import {
  SESSION_PROOF_HISTORY_LIMIT,
  SHARE_CODE_TOMBSTONE_MS,
  SIGNALING_SESSION_BINDING_MS,
  SIGNALING_SESSION_SLOT_TTL_MS,
} from '../../constants/signaling';
// 保留期定义在 constants/signaling.ts；这里重新导出，保持既有导入路径不破。
export {
  SHARE_CODE_TOMBSTONE_MS,
  SIGNALING_SESSION_BINDING_MS,
  SIGNALING_SESSION_SLOT_TTL_MS,
} from '../../constants/signaling';

// SignalingHub 的 SQL 状态机：会话绑定、分片会话槽位、分享口令表。
//
// 这里只做「SQL + 纯判定」，通过窄接口注入存储（`ctx.storage.sql` 直接满足它），
// 因此可以用「记录调用 + 预设返回」的 fake 在 node:test 里覆盖，不需要 sqlite 依赖。
// 生命周期、广播、RPC 编排留在 worker.ts。
//
// 两个不变量的位置（评审定位过的两处回归）：
// 1. 静态分享摘要只在「首次绑定」那一刻开窗，之后每次成功注册都不能续期；窗口过期后
//    把 secret_hash 写成 NULL，之后只认 proof。
// 2. 判定（planSessionAdmission）只读；proof 轮换落库（commitSessionBindingRotation）
//    必须在 registered 帧已经交给 socket 之后再调用。所以被名额/配额拒绝的注册不会
//    再动绑定表，旧连接手里的 proof 也就不会被一次失败的重连作废。

import {
  buildNextSessionProofHistory,
  shouldAcceptSessionAdmission,
  type SessionProofHistoryEntry,
} from './sessionBinding';
import type { ShareCodeRecord } from '../shareCodeRegistry';

/** `ctx.storage.sql.exec` 的最小可用形状：游标只用到 toArray / rowsWritten。 */
export type SqlCursor<T> = { toArray(): T[]; rowsWritten?: number };

export type SqlLike = {
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): SqlCursor<T>;
};


export type SessionBindingRecord = {
  secretHash: string | null;
  secretHashExpiresAt: number;
  proofHash: string;
  recentProofHashes: SessionProofHistoryEntry[];
};

export type SessionAdmissionInput = {
  peerId: string;
  existingSecretHash?: string;
  incomingSecretHash?: string;
  incomingProofHash?: string;
  now: number;
};

export type SessionAdmissionPlan =
  | { allowed: false }
  /** 未绑定任何密钥的会话（文件传输、观众、首次注册）：不轮换，registered 帧也不带 proof。 */
  | { allowed: true; needsRotation: false }
  | {
      allowed: true;
      needsRotation: true;
      /** 判定时看到的绑定摘要；commit 时绑定行可能已被改写，用它兜底。 */
      boundSecretHash: string | null;
      /**
       * 判定时绑定行里的 proof 摘要（没有绑定行为 null）。commit 用它做 CAS：
       * 一次注册可能在 await 期间被同 peerId 的后续注册接管，迟到的 commit 如果把
       * 自己的 proof 写回去，就会覆盖接管者刚签发的权威 proof。
       */
      expectedProofHash: string | null;
    };

/** 历史 proof 是 JSON 文本列；解析失败按「没有历史」处理，绝不让坏数据变成放行。 */
export const parseSessionProofHistory = (raw: string | null): SessionProofHistoryEntry[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as { proofHash?: unknown; expiresAt?: unknown };
      if (typeof candidate.proofHash !== 'string' || typeof candidate.expiresAt !== 'number') {
        return [];
      }
      return [{ proofHash: candidate.proofHash, expiresAt: candidate.expiresAt }];
    });
  } catch {
    return [];
  }
};

export const initializeSessionBindingSchema = (sql: SqlLike): void => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS signaling_session_bindings (' +
      'peer_id TEXT PRIMARY KEY, ' +
      'secret_hash TEXT, ' +
      'secret_hash_expires_at INTEGER NOT NULL DEFAULT 0, ' +
      'proof_hash TEXT NOT NULL, ' +
      "recent_hashes TEXT NOT NULL DEFAULT '[]', " +
      'updated_at INTEGER NOT NULL, ' +
      'expires_at INTEGER NOT NULL)'
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_signaling_session_bindings_expires ' +
      'ON signaling_session_bindings(expires_at)'
  );
  // 老部署的表里没有这一列：ALTER 没有 IF NOT EXISTS，先查 PRAGMA 再补。
  const columns = sql.exec<{ name: string }>("PRAGMA table_info('signaling_session_bindings')").toArray();
  if (!columns.some((column) => column.name === 'secret_hash_expires_at')) {
    sql.exec(
      'ALTER TABLE signaling_session_bindings ADD COLUMN secret_hash_expires_at INTEGER NOT NULL DEFAULT 0'
    );
  }
};

export const findSessionBinding = (
  sql: SqlLike,
  peerId: string,
  now: number
): SessionBindingRecord | null => {
  const rows = sql
    .exec<{
      secret_hash: string | null;
      secret_hash_expires_at: number;
      proof_hash: string;
      recent_hashes: string | null;
      expires_at: number;
    }>(
      'SELECT secret_hash, secret_hash_expires_at, proof_hash, recent_hashes, expires_at ' +
        'FROM signaling_session_bindings WHERE peer_id = ?',
      peerId
    )
    .toArray();
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at <= now) {
    // 过期绑定立刻清掉：否则 peerId 会被一个没人持有的会话一直锁住。
    sql.exec('DELETE FROM signaling_session_bindings WHERE peer_id = ?', peerId);
    return null;
  }
  return {
    secretHash: row.secret_hash,
    secretHashExpiresAt: Number(row.secret_hash_expires_at) || 0,
    proofHash: row.proof_hash,
    recentProofHashes: parseSessionProofHistory(row.recent_hashes),
  };
};

export const saveSessionBinding = (
  sql: SqlLike,
  input: {
    peerId: string;
    secretHash?: string | null;
    secretHashExpiresAt?: number;
    proofHash: string;
    recentProofHashes: SessionProofHistoryEntry[];
    now: number;
    ttlMs: number;
  }
): void => {
  // 顺手清理过期行：注册频率远低于查询频率，不值得单独开 alarm。
  sql.exec('DELETE FROM signaling_session_bindings WHERE expires_at <= ?', input.now);
  sql.exec(
    'INSERT INTO signaling_session_bindings ' +
      '(peer_id, secret_hash, secret_hash_expires_at, proof_hash, recent_hashes, updated_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(peer_id) DO UPDATE SET ' +
      'secret_hash = excluded.secret_hash, ' +
      'secret_hash_expires_at = excluded.secret_hash_expires_at, ' +
      'proof_hash = excluded.proof_hash, ' +
      'recent_hashes = excluded.recent_hashes, ' +
      'updated_at = excluded.updated_at, ' +
      'expires_at = excluded.expires_at',
    input.peerId,
    input.secretHash ?? null,
    input.secretHashExpiresAt ?? 0,
    input.proofHash,
    JSON.stringify(input.recentProofHashes),
    input.now,
    input.now + input.ttlMs
  );
};

/**
 * 判定一次注册：只读，不落库。把「判定」和「轮换 proof」分开，是为了让被后续名额 /
 * 配额检查拒绝的注册不会作废旧连接手里的 proof（见文件头不变量 2）。
 */
export const planSessionAdmission = (
  sql: SqlLike,
  input: SessionAdmissionInput
): SessionAdmissionPlan => {
  const binding = findSessionBinding(sql, input.peerId, input.now);
  const boundSecretHash = binding?.secretHash ?? input.existingSecretHash ?? input.incomingSecretHash;
  const admission = shouldAcceptSessionAdmission({
    boundSecretHash,
    storedProofHash: binding?.proofHash,
    recentProofHashes: binding?.recentProofHashes,
    secretHashGraceExpiresAt: binding?.secretHashExpiresAt,
    incomingSecretHash: input.incomingSecretHash,
    incomingProofHash: input.incomingProofHash,
    now: input.now,
  });
  if (admission === 'reject') {
    return { allowed: false };
  }
  if (binding === null && boundSecretHash === undefined) {
    return { allowed: true, needsRotation: false };
  }
  return {
    allowed: true,
    needsRotation: true,
    boundSecretHash: boundSecretHash ?? null,
    expectedProofHash: binding?.proofHash ?? null,
  };
};

export type SessionBindingRotation = {
  secretHash: string | null;
  secretHashExpiresAt: number;
  /** 窗口已过期，本次落库把静态摘要清成 NULL（窗口只开一次，不再续期）。 */
  secretHashCleared: boolean;
};

/**
 * 计算本次轮换要写回的摘要与窗口。
 *
 * - 首次绑定（`current === null`）：只有这一刻开窗。
 * - 已绑定过：沿用原窗口，绝不因为一次顺利注册而续期（旧实现的回归点）。
 * - 原窗口已过期：写 NULL + 0，之后只认 proof。
 */
export const resolveSessionBindingRotation = (input: {
  current: SessionBindingRecord | null;
  fallbackSecretHash?: string | null;
  now: number;
  graceMs: number;
}): SessionBindingRotation => {
  const fallback = input.fallbackSecretHash ?? null;
  if (input.current === null) {
    const secretHash = fallback;
    return {
      secretHash,
      secretHashExpiresAt: secretHash ? input.now + input.graceMs : 0,
      secretHashCleared: false,
    };
  }
  if (input.current.secretHash === null) {
    return { secretHash: null, secretHashExpiresAt: 0, secretHashCleared: false };
  }
  const expiresAt = input.current.secretHashExpiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now) {
    return { secretHash: null, secretHashExpiresAt: 0, secretHashCleared: true };
  }
  return {
    secretHash: input.current.secretHash,
    secretHashExpiresAt: expiresAt,
    secretHashCleared: false,
  };
};

/**
 * 落库一次 proof 轮换。只能在 registered 帧已经交给 socket 之后调用。
 *
 * 轮换是读改写：await 期间另一条注册可能已经换过 proof。用判定时的旧快照构造历史会把
 * 对方刚签发的那份挤掉，所以落库前重读。
 */
export type SessionBindingCommitResult = SessionBindingRotation & {
  /** true 表示本次轮换已被更晚的注册接管，什么都没写。 */
  superseded: boolean;
};

export const commitSessionBindingRotation = (
  sql: SqlLike,
  input: {
    peerId: string;
    now: number;
    proofHash: string;
    boundSecretHash?: string | null;
    /** 判定时看到的 proof 摘要；传入即开启 CAS，不一致时放弃写入。 */
    expectedProofHash?: string | null;
    graceMs: number;
    proofGraceMs: number;
    ttlMs: number;
  }
): SessionBindingCommitResult => {
  const snapshot = findSessionBinding(sql, input.peerId, input.now);
  if (input.expectedProofHash !== undefined) {
    const current = snapshot?.proofHash?.toLowerCase() ?? null;
    const expected = input.expectedProofHash?.toLowerCase() ?? null;
    if (current !== expected) {
      return {
        secretHash: snapshot?.secretHash ?? input.boundSecretHash ?? null,
        secretHashExpiresAt: snapshot?.secretHashExpiresAt ?? 0,
        secretHashCleared: snapshot === null,
        superseded: true,
      };
    }
  }
  const rotation = resolveSessionBindingRotation({
    current: snapshot,
    fallbackSecretHash: input.boundSecretHash,
    now: input.now,
    graceMs: input.graceMs,
  });
  saveSessionBinding(sql, {
    peerId: input.peerId,
    secretHash: rotation.secretHash,
    secretHashExpiresAt: rotation.secretHashExpiresAt,
    proofHash: input.proofHash,
    recentProofHashes: buildNextSessionProofHistory({
      storedProofHash: snapshot?.proofHash,
      recentProofHashes: snapshot?.recentProofHashes,
      now: input.now,
      graceMs: input.proofGraceMs,
    }),
    now: input.now,
    ttlMs: input.ttlMs,
  });
  return { ...rotation, superseded: false };
};

/**
 * 轮换落库失败时的自愈计划：把已经下发的新 proof 摘要追加进历史列表。
 *
 * 客户端已经收到 `registered` 里的新 proof，且「拿到 proof 后不再发静态摘要」——
 * 如果服务端只留旧 proof，新 proof 又不在历史里，这条连接一旦断开就再也连不回来
 * （旧 proof 在宽限期后作废、静态摘要早已不认）。所以把新 proof 当成「待生效摘要」
 * 追加进历史：判定只看 hash 是否在列表里且未过期，效果等价于轮换成功。
 *
 * 不覆盖当前的 proof_hash：写回的轮换从未成功，此刻旧 proof 仍是权威值，回滚会让
 * 客户端与服务端都失去一个已知有效的凭证。
 */
export const buildPendingSessionProofHistory = (input: {
  current: SessionBindingRecord;
  proofHash: string;
  now: number;
  ttlMs: number;
}): SessionProofHistoryEntry[] => {
  const normalized = input.proofHash.toLowerCase();
  const history = input.current.recentProofHashes.filter(
    (entry) => entry.expiresAt > input.now && entry.proofHash.toLowerCase() !== normalized
  );
  history.push({ proofHash: normalized, expiresAt: input.now + input.ttlMs });
  return history.slice(-SESSION_PROOF_HISTORY_LIMIT);
};

/**
 * 尽力写回上面的自愈计划。返回绑定行是否已经能接受新 proof。
 *
 * 没有绑定行时返回 false：那是「首次注册就没有静态摘要」的会话，历史无处可挂，
 * 它本来也不需要这条路径（下次注册会重新轮换）。
 */
export const appendPendingSessionProof = (
  sql: SqlLike,
  input: {
    peerId: string;
    proofHash: string;
    /**
     * 落库时的 CAS 期望值：判定阶段看到的权威 proof 摘要（null 表示当时还没有绑定行）。
     * 自愈补写如果发现权威 proof 已被后续注册换掉，就必须放弃，否则会把接管者的
     * proof 覆盖成一条只有「迟到那一方」知道的值。
     */
    expectedProofHash?: string | null;
    now: number;
    /** 新 proof 在历史里的有效期：要覆盖客户端重连窗口，不只是一次宽限期。 */
    proofTtlMs: number;
    /** 绑定行本身的续期，与正常轮换落库保持一致（避免把 24h 绑定缩成几分钟）。 */
    bindingTtlMs: number;
  }
): boolean => {
  const current = findSessionBinding(sql, input.peerId, input.now);
  if (current === null) return false;
  // 重试虽然超时了，但写入其实已经生效：无需再挂一份历史。
  if (current.proofHash.toLowerCase() === input.proofHash.toLowerCase()) return true;
  if (input.expectedProofHash !== undefined) {
    const expected = input.expectedProofHash?.toLowerCase() ?? null;
    if ((current.proofHash.toLowerCase() ?? null) !== expected) return false;
  }

  saveSessionBinding(sql, {
    peerId: input.peerId,
    secretHash: current.secretHash,
    secretHashExpiresAt: current.secretHashExpiresAt,
    proofHash: current.proofHash,
    recentProofHashes: buildPendingSessionProofHistory({
      current,
      proofHash: input.proofHash,
      now: input.now,
      ttlMs: input.proofTtlMs,
    }),
    now: input.now,
    ttlMs: input.bindingTtlMs,
  });
  return true;
};

/* ------------------------------------------------------------------ */
/* 分片会话槽位（全局「每客户端 N 会话」计数，权威副本在 shard 0）      */
/* ------------------------------------------------------------------ */

export const initializeSessionSlotSchema = (sql: SqlLike): void => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS signaling_session_slots (' +
      'slot_id TEXT PRIMARY KEY, ' +
      'client_key TEXT NOT NULL, ' +
      'expires_at INTEGER NOT NULL)'
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_signaling_session_slots_client ' +
      'ON signaling_session_slots(client_key)'
  );
};

/**
 * 原子语义的近似：先清过期槽位，再数一次、插一条。DO 内单线程执行，无并发窗口。
 * 同一个 slotId 已存在时是「接管续期」而不是新占名额：直接改归属与过期时间，
 * 否则接管方要先释放再领取，领取失败就把旧会话的名额白白吃掉。
 */
export const applySessionSlotReserve = (
  sql: SqlLike,
  input: { slotId: string; clientKey: string; now: number; maxSessions: number; ttlMs: number }
): boolean => {
  sql.exec('DELETE FROM signaling_session_slots WHERE expires_at <= ?', input.now);
  const existing = sql
    .exec<{ slot_id: string }>('SELECT slot_id FROM signaling_session_slots WHERE slot_id = ?', input.slotId)
    .toArray();
  if (existing.length > 0) {
    sql.exec(
      'UPDATE signaling_session_slots SET client_key = ?, expires_at = ? WHERE slot_id = ?',
      input.clientKey,
      input.now + input.ttlMs,
      input.slotId
    );
    return true;
  }
  const rows = sql
    .exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM signaling_session_slots WHERE client_key = ?',
      input.clientKey
    )
    .toArray();
  if (Number(rows[0]?.count ?? 0) >= input.maxSessions) {
    return false;
  }
  sql.exec(
    'INSERT OR REPLACE INTO signaling_session_slots (slot_id, client_key, expires_at) VALUES (?, ?, ?)',
    input.slotId,
    input.clientKey,
    input.now + input.ttlMs
  );
  return true;
};

/**
 * 释放名额。
 *
 * 必须能只删「自己那张」：并发接管时落败的一方也会走回滚，而它复用同一个 slotId，
 * 裸删会把胜出方刚拿到（并已投递 registered）的名额一起删掉——全局上限被悄悄放宽。
 * 传 clientKey 时按归属条件删除。
 */
export const applySessionSlotRelease = (
  sql: SqlLike,
  slotId: string,
  clientKey?: string
): void => {
  if (clientKey) {
    sql.exec(
      'DELETE FROM signaling_session_slots WHERE slot_id = ? AND client_key = ?',
      slotId,
      clientKey
    );
    return;
  }
  sql.exec('DELETE FROM signaling_session_slots WHERE slot_id = ?', slotId);
};

/** 常驻连接续期；槽位已被清掉（例如 TTL 过期或被别人接管）时返回 false。 */
export const applySessionSlotRenew = (
  sql: SqlLike,
  input: { slotId: string; now: number; ttlMs: number }
): boolean => {
  const cursor = sql.exec(
    'UPDATE signaling_session_slots SET expires_at = ? WHERE slot_id = ?',
    input.now + input.ttlMs,
    input.slotId
  );
  return (cursor.rowsWritten ?? 0) > 0;
};

/* ------------------------------------------------------------------ */
/* 分享口令表（只住在 shard 0）                                        */
/* ------------------------------------------------------------------ */

type ShareCodeRow = {
  code: string;
  peer_id: string;
  secret_hash: string;
  expires_at: number;
  revoke_after: number | null;
};

export const initializeShareCodeSchema = (sql: SqlLike): void => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS share_codes (' +
      'code TEXT PRIMARY KEY, ' +
      'peer_id TEXT NOT NULL, ' +
      'secret_hash TEXT NOT NULL, ' +
      'expires_at INTEGER NOT NULL, ' +
      'created_at INTEGER NOT NULL, ' +
      'revoke_after INTEGER)'
  );
  // 旧库补列：pagehide 的延迟注销需要记录待生效时间。
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(share_codes)').toArray();
  if (!columns.some((column) => column.name === 'revoke_after')) {
    sql.exec('ALTER TABLE share_codes ADD COLUMN revoke_after INTEGER');
  }
  // 注销后保留一段时间的「墓碑」：只 DELETE 活跃行会让 peerId 的归属信息消失，
  // 任何拿到过发送方 peerId 的人都能抢先用自己的 secretHash 重新绑定这个 id，
  // 之后发送方续期会一直 409 并被静默吞掉。墓碑让 24h 内的重绑定仍需原凭证。
  sql.exec(
    'CREATE TABLE IF NOT EXISTS share_code_tombstones (' +
      'peer_id TEXT PRIMARY KEY, ' +
      'code TEXT NOT NULL, ' +
      'secret_hash TEXT NOT NULL, ' +
      'revoked_at INTEGER NOT NULL)'
  );
  sql.exec(
    'CREATE INDEX IF NOT EXISTS idx_share_code_tombstones_revoked ' +
      'ON share_code_tombstones(revoked_at)'
  );
  // 分片回源会按 peer_id 查活跃口令（续期 / 重连探测），没有索引就是全表扫。
  sql.exec('CREATE INDEX IF NOT EXISTS idx_share_codes_peer_id ON share_codes(peer_id)');
};

/**
 * 清理过期口令：先补墓碑再删活跃行，最后清过期墓碑。
 *
 * 口令 TTL 与分享有效期相等，自然到期时活跃行已经不存在，而 revoke 对过期记录一律 403：
 * 不在这里补写墓碑，最常用的到期路径就完全没有归属记录。
 */
export const deleteExpiredShareCodes = (
  sql: SqlLike,
  input: { now: number; tombstoneMs: number }
): void => {
  sql.exec(
    'INSERT INTO share_code_tombstones (peer_id, code, secret_hash, revoked_at) ' +
      'SELECT peer_id, code, secret_hash, ? FROM share_codes ' +
      'WHERE expires_at <= ? OR (revoke_after IS NOT NULL AND revoke_after <= ?) ' +
      'ON CONFLICT(peer_id) DO UPDATE SET code = excluded.code, ' +
      'secret_hash = excluded.secret_hash, revoked_at = excluded.revoked_at',
    input.now,
    input.now,
    input.now
  );
  sql.exec(
    'DELETE FROM share_codes WHERE expires_at <= ? OR (revoke_after IS NOT NULL AND revoke_after <= ?)',
    input.now,
    input.now
  );
  sql.exec('DELETE FROM share_code_tombstones WHERE revoked_at <= ?', input.now - input.tombstoneMs);
};

const toShareCodeRecord = (row: ShareCodeRow): ShareCodeRecord => ({
  code: row.code,
  peerId: row.peer_id,
  secretHash: row.secret_hash,
  expiresAt: row.expires_at,
});

/**
 * 按码读活跃记录。**读路径不再写库**：以前这里每次查询都顺手跑一遍过期清理，
 * 而未认证的 `GET /api/share-code/:code` 会直接落到这里，等于让公网匿名请求在
 * shard 0 上开写事务（既放大写量，也和读的语义不符）。过期行改由写路径清理：
 * 只有登记路径（`registerShareCode`）会先 `purgeExpiredShareCodes`，而码冲突判定
 * 就在那次清理之后，所以「过期行挡住复用」的问题不会出现；撤销/恢复按 code 精确定位，
 * 过期行本来也不会命中。这里只按 `expires_at`/`revoke_after` 过滤。
 */
export const findActiveShareCode = (
  sql: SqlLike,
  input: { code: string; now: number; tombstoneMs: number }
): ShareCodeRecord | null => {
  const rows = sql
    .exec<ShareCodeRow>(
      'SELECT code, peer_id, secret_hash, expires_at, revoke_after FROM share_codes WHERE code = ?',
      input.code
    )
    .toArray();
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at <= input.now || (row.revoke_after !== null && row.revoke_after <= input.now)) {
    return null;
  }
  return toShareCodeRecord(row);
};

export const findActiveShareCodeByPeerId = (
  sql: SqlLike,
  peerId: string,
  now: number
): ShareCodeRecord | null => {
  const rows = sql
    .exec<ShareCodeRow>(
      'SELECT code, peer_id, secret_hash, expires_at, revoke_after FROM share_codes WHERE peer_id = ?',
      peerId
    )
    .toArray();
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at <= now || (row.revoke_after !== null && row.revoke_after <= now)) {
    return null;
  }
  return toShareCodeRecord(row);
};

export const findRecentTombstoneByPeerId = (
  sql: SqlLike,
  input: { peerId: string; now: number; tombstoneMs: number }
): { secretHash: string } | null => {
  const rows = sql
    .exec<{ secret_hash: string }>(
      'SELECT secret_hash FROM share_code_tombstones WHERE peer_id = ? ' +
        'AND revoked_at > ? ORDER BY revoked_at DESC LIMIT 1',
      input.peerId,
      input.now - input.tombstoneMs
    )
    .toArray();
  return rows[0] ? { secretHash: rows[0].secret_hash } : null;
};

/**
 * 登记一张码。`code` 冲突时**只允许同一 peerId 原地续期**：
 * - 别的 peerId 占着这张码 → `DO UPDATE ... WHERE peer_id = excluded.peer_id` 不命中，
 *   RETURNING 无行，调用方得到 `taken`，且旧行分毫未动；
 * - 请求方自己的旧码要续期/换摘要 → 原地更新，不需要「先删后插」。
 *
 * 之前的实现靠调用方 `deleteShareCodesForPeer` + 纯 `DO NOTHING` 来支持续期，一旦自定义码
 * 撞车就变成「旧码已删、新码没建成」，观众拿到 404、发送端重连 unauthorized。
 */
export const insertShareCode = (sql: SqlLike, record: ShareCodeRecord, now: number): boolean => {
  const inserted = sql
    .exec<{ code: string }>(
      'INSERT INTO share_codes (code, peer_id, secret_hash, expires_at, created_at) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(code) DO UPDATE SET ' +
        'secret_hash = excluded.secret_hash, expires_at = excluded.expires_at, revoke_after = NULL ' +
        'WHERE share_codes.peer_id = excluded.peer_id ' +
        'RETURNING code',
      record.code,
      record.peerId,
      record.secretHash,
      record.expiresAt,
      now
    )
    .toArray();
  return inserted.length > 0;
};

/**
 * 同一 peerId 只保留最新一张码，避免反复建码把表堆大。调用方必须在**新码落库成功之后**
 * 才调用，并传 `keepCode` 保住刚建成的那张——先删后插会在冲突失败时连旧码一起弄丢。
 */
export const deleteShareCodesByPeerId = (
  sql: SqlLike,
  peerId: string,
  keepCode?: string
): void => {
  if (keepCode === undefined) {
    sql.exec('DELETE FROM share_codes WHERE peer_id = ?', peerId);
    return;
  }
  sql.exec('DELETE FROM share_codes WHERE peer_id = ? AND code <> ?', peerId, keepCode);
};

export const deferShareCodeRevoke = (
  sql: SqlLike,
  record: ShareCodeRecord,
  revokeAfter: number
): boolean => {
  const updated = sql
    .exec<{ code: string }>(
      'UPDATE share_codes SET revoke_after = ? ' +
        'WHERE code = ? AND peer_id = ? AND secret_hash = ? RETURNING code',
      revokeAfter,
      record.code,
      record.peerId,
      record.secretHash
    )
    .toArray();
  return updated.length > 0;
};

export const resumeShareCode = (sql: SqlLike, record: ShareCodeRecord): boolean => {
  const updated = sql
    .exec<{ code: string }>(
      'UPDATE share_codes SET revoke_after = NULL ' +
        'WHERE code = ? AND peer_id = ? AND secret_hash = ? RETURNING code',
      record.code,
      record.peerId,
      record.secretHash
    )
    .toArray();
  return updated.length > 0;
};

/**
 * 注销：先写墓碑再删活跃行。即使 DELETE 失败，归属信息也不会丢。
 */
export const revokeShareCode = (sql: SqlLike, record: ShareCodeRecord, now: number): boolean => {
  sql.exec(
    'INSERT INTO share_code_tombstones (peer_id, code, secret_hash, revoked_at) ' +
      'VALUES (?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET ' +
      'code = excluded.code, secret_hash = excluded.secret_hash, revoked_at = excluded.revoked_at',
    record.peerId,
    record.code,
    record.secretHash,
    now
  );
  const deleted = sql
    .exec<{ code: string }>('DELETE FROM share_codes WHERE code = ? RETURNING code', record.code)
    .toArray();
  return deleted.length > 0;
};

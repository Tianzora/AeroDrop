import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import {
  applySessionSlotRelease,
  applySessionSlotReserve,
  applySessionSlotRenew,
  commitSessionBindingRotation,
  deferShareCodeRevoke,
  findActiveShareCode,
  findRecentTombstoneByPeerId,
  findSessionBinding,
  initializeSessionBindingSchema,
  initializeSessionSlotSchema,
  initializeShareCodeSchema,
  insertShareCode,
  planSessionAdmission,
  resumeShareCode,
  revokeShareCode,
  saveSessionBinding,
  type SqlLike,
} from './sessionStore.ts';
import type { ShareCodeRecord } from '../shareCodeRegistry';

const HOUR = 60 * 60 * 1000;

/**
 * 真实 SQLite 适配器：把 Durable Object 的 SQL 接口映射到 node:sqlite。
 * 这些测试存在的意义是让「语句本身能否执行」也被覆盖 —— 纯 fake SQL 只认前缀，
 * 列序写错、RETURNING 在 ON CONFLICT DO NOTHING 下不返回行这类错误它都看不见。
 * DO 的 `rowsWritten` 语义与 `changes` 对应；有 RETURNING 的写入按查询处理。
 */
const createSqlite = (db: DatabaseSync): SqlLike => ({
  exec<T = Record<string, unknown>>(text: string, ...params: unknown[]) {
    const statement = db.prepare(text);
    const returnsRows = /^\s*(SELECT|PRAGMA|WITH)/i.test(text) || /\bRETURNING\b/i.test(text);
    if (returnsRows) {
      const rows = statement.all(...(params as SQLInputValue[])) as T[];
      return { toArray: () => rows, rowsWritten: rows.length };
    }
    const info = statement.run(...(params as SQLInputValue[]));
    return { toArray: () => [] as T[], rowsWritten: Number(info.changes) };
  },
});

const countRows = (db: DatabaseSync, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
};

const secretHash = 'a'.repeat(64);
const proofHash = 'c'.repeat(64);

test('绑定表建表语句能被真实 SQLite 执行，老表会自动补上摘要窗口列', () => {
  const db = new DatabaseSync(':memory:');
  // 模拟没有 secret_hash_expires_at 的旧部署。
  db.exec(
    'CREATE TABLE signaling_session_bindings (' +
      'peer_id TEXT PRIMARY KEY, secret_hash TEXT, proof_hash TEXT NOT NULL, ' +
      "recent_hashes TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
  );
  db.exec("INSERT INTO signaling_session_bindings VALUES ('old-peer', NULL, 'd', '[]', 1, 2)");

  const sql = createSqlite(db);
  initializeSessionBindingSchema(sql);
  initializeSessionBindingSchema(sql);

  const columns = db
    .prepare("PRAGMA table_info('signaling_session_bindings')")
    .all()
    .map((column) => String((column as { name: string }).name));
  assert.ok(columns.includes('secret_hash_expires_at'));
  // 旧行仍在，默认值 0 表示「从未开窗」。
  const old = db
    .prepare("SELECT secret_hash_expires_at FROM signaling_session_bindings WHERE peer_id = 'old-peer'")
    .get() as { secret_hash_expires_at: number };
  assert.equal(old.secret_hash_expires_at, 0);
  db.close();
});

test('绑定写入与读取走真实 SQL，过期行在读取时被删除', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionBindingSchema(sql);

  const now = 1_000;
  saveSessionBinding(sql, {
    peerId: 'peer-1',
    secretHash,
    secretHashExpiresAt: now + 10 * 60 * 1000,
    proofHash,
    recentProofHashes: [],
    now,
    ttlMs: 24 * HOUR,
  });

  const found = findSessionBinding(sql, 'peer-1', now + 1);
  assert.equal(found?.secretHash, secretHash);
  assert.equal(found?.proofHash, proofHash);
  assert.equal(found?.secretHashExpiresAt, now + 10 * 60 * 1000);

  // 过期后读取应顺手 DELETE，而不是返回一条已过期的绑定。
  assert.equal(findSessionBinding(sql, 'peer-1', now + 24 * HOUR + 1), null);
  assert.equal(countRows(db, 'signaling_session_bindings'), 0);
  db.close();
});

test('planSessionAdmission 对真实库只读：判定不得顺手改行', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionBindingSchema(sql);
  const now = 5_000;
  saveSessionBinding(sql, {
    peerId: 'peer-2',
    secretHash,
    secretHashExpiresAt: now + 10 * 60 * 1000,
    proofHash,
    recentProofHashes: [],
    now,
    ttlMs: 24 * HOUR,
  });
  const before = db.prepare('SELECT * FROM signaling_session_bindings WHERE peer_id = ?').get('peer-2');

  const plan = planSessionAdmission(sql, {
    peerId: 'peer-2',
    incomingSecretHash: secretHash,
    now: now + 1,
  });
  assert.equal(plan.allowed, true);

  const after = db.prepare('SELECT * FROM signaling_session_bindings WHERE peer_id = ?').get('peer-2');
  assert.deepEqual(after, before);
  db.close();
});

test('绑定轮换落库在真实库上保留旧 proof，并把过期摘要清成 NULL 语义', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionBindingSchema(sql);
  const now = 10_000;
  saveSessionBinding(sql, {
    peerId: 'peer-rotate',
    secretHash,
    // 摘要窗口已经过期：轮换时必须写回 NULL/0，不能续期。
    secretHashExpiresAt: now,
    proofHash,
    recentProofHashes: [],
    now,
    ttlMs: 24 * HOUR,
  });

  const nextProofHash = 'e'.repeat(64);
  const rotation = commitSessionBindingRotation(sql, {
    peerId: 'peer-rotate',
    now: now + 1_000,
    proofHash: nextProofHash,
    boundSecretHash: secretHash,
    graceMs: 10 * 60 * 1000,
    proofGraceMs: 10 * 60 * 1000,
    ttlMs: 24 * HOUR,
  });
  assert.equal(rotation.secretHash, null);
  assert.equal(rotation.secretHashExpiresAt, 0);

  const updated = findSessionBinding(sql, 'peer-rotate', now + 2_000);
  assert.equal(updated?.proofHash, nextProofHash);
  assert.equal(updated?.secretHash, null, '过期摘要必须从绑定里清掉');
  // 旧 proof 必须留在宽限期内，否则「新 proof 还没送达就断线」会自锁。
  assert.ok(updated?.recentProofHashes.some((entry) => entry.proofHash === proofHash));
  db.close();
});

test('槽位在真实库上按 client 计数、同 slot 转移、可续期与释放', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionSlotSchema(sql);
  const ttlMs = 6 * HOUR;
  const now = 1_000;

  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-a', clientKey: 'ip:1', now, maxSessions: 2, ttlMs }),
    true
  );
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-b', clientKey: 'ip:1', now, maxSessions: 2, ttlMs }),
    true
  );
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-c', clientKey: 'ip:1', now, maxSessions: 2, ttlMs }),
    false,
    '同一个 client 超过上限必须被拒'
  );

  // 同一个 slotId 再领取是「转移/续期」，不是再占一个名额，也不应被上限挡住。
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-a', clientKey: 'ip:2', now: now + 1, maxSessions: 2, ttlMs }),
    true
  );
  const transferred = db
    .prepare("SELECT client_key FROM signaling_session_slots WHERE slot_id = 'slot-a'")
    .get() as { client_key: string };
  assert.equal(transferred.client_key, 'ip:2');
  assert.equal(countRows(db, 'signaling_session_slots'), 2);

  assert.equal(applySessionSlotRenew(sql, { slotId: 'slot-a', now: now + 2, ttlMs }), true);
  const renewed = db
    .prepare("SELECT expires_at FROM signaling_session_slots WHERE slot_id = 'slot-a'")
    .get() as { expires_at: number };
  assert.equal(renewed.expires_at, now + 2 + ttlMs);

  applySessionSlotRelease(sql, 'slot-a');
  assert.equal(countRows(db, 'signaling_session_slots'), 1);
  assert.equal(applySessionSlotRenew(sql, { slotId: 'slot-a', now: now + 3, ttlMs }), false);
  db.close();
});

test('口令表：RETURNING 语义、延迟注销与墓碑在真实库上成立', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeShareCodeSchema(sql);
  const now = 1_000;
  const record: ShareCodeRecord = {
    code: 'ABC123',
    peerId: 'peer-code',
    secretHash,
    expiresAt: now + HOUR,
  };

  assert.equal(insertShareCode(sql, record, now), true);
  assert.equal(insertShareCode(sql, record, now), false, '同码重复插入必须返回 false 而不是抛错');
  assert.equal(countRows(db, 'share_codes'), 1);

  assert.deepEqual(findActiveShareCode(sql, { code: 'ABC123', now, tombstoneMs: 24 * HOUR }), record);

  // 延迟注销：写入 revoke_after 但尚未到点，口令仍可用，且必须在宽限期内能 resume。
  assert.equal(deferShareCodeRevoke(sql, record, now + 60_000), true);
  assert.equal(resumeShareCode(sql, record), true, '宽限期内必须能 resume');
  assert.deepEqual(findActiveShareCode(sql, { code: 'ABC123', now: now + 1, tombstoneMs: 24 * HOUR }), record);

  // 注销：先写墓碑再删活跃行，两块都必须在真实库上生效。
  assert.equal(revokeShareCode(sql, record, now + 500), true);
  assert.equal(countRows(db, 'share_codes'), 0);
  assert.deepEqual(
    findRecentTombstoneByPeerId(sql, { peerId: 'peer-code', now: now + 501, tombstoneMs: 24 * HOUR }),
    { secretHash }
  );

  // 自然到期也算一次注销：findActive 清理过期行，并留下墓碑。
  const shortLived: ShareCodeRecord = { ...record, code: 'XYZ789', expiresAt: now + 10 };
  assert.equal(insertShareCode(sql, shortLived, now), true);
  assert.equal(
    findActiveShareCode(sql, { code: 'XYZ789', now: now + 11, tombstoneMs: 24 * HOUR }),
    null,
    '过期的口令不能被当成活跃口令返回'
  );
  assert.equal(countRows(db, 'share_codes'), 0);
  db.close();
});

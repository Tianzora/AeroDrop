import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlite } from '../../scripts/test-stubs/sqlite-adapter.ts';

import {
  appendPendingSessionProof,
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


test('旧部署的 share_codes 表会补上 revoke_after 列，已有行不受影响', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE share_codes (' +
      'code TEXT PRIMARY KEY, peer_id TEXT NOT NULL, secret_hash TEXT NOT NULL, ' +
      'expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
  );
  db.prepare('INSERT INTO share_codes VALUES (?, ?, ?, ?, ?)').run(
    'ABC123',
    'peer-old',
    'b'.repeat(64),
    9_999_999_999_999,
    1
  );

  const sql = createSqlite(db);
  initializeShareCodeSchema(sql);
  initializeShareCodeSchema(sql);

  const columns = db
    .prepare("PRAGMA table_info('share_codes')")
    .all()
    .map((column) => String((column as { name: string }).name));
  assert.ok(columns.includes('revoke_after'), '旧库必须能自动补列');
  const row = db
    .prepare("SELECT peer_id, revoke_after FROM share_codes WHERE code = 'ABC123'")
    .get() as { peer_id: string; revoke_after: number | null };
  assert.equal(row.peer_id, 'peer-old');
  assert.equal(row.revoke_after, null);
  db.close();
});

test('RETURNING 写入的 rowsWritten 取 changes，而不是返回的行数', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionSlotSchema(sql);
  const reserve = (clientKey: string, now: number) =>
    applySessionSlotReserve(sql, {
      slotId: 'slot-a',
      clientKey,
      now,
      maxSessions: 12,
      ttlMs: 60_000,
    });
  assert.equal(reserve('client-1', 1_000), true);
  // 同 slot 的原地转移只写一行；若 rowsWritten 用 rows.length 而不是 changes，
  // 「没写进去」也会被当成成功。
  assert.equal(reserve('client-2', 2_000), true);
  db.close();
});

test('适配器拒绝一次执行多条语句（与 DO 的 exec 语义一致）', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  assert.throws(
    () => sql.exec('CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER)'),
    /single statement/
  );
  db.close();
});


test('迟到的轮换提交不会覆盖接管者刚写入的权威 proof（CAS）', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionBindingSchema(sql);
  const base = {
    peerId: 'peer-cas',
    graceMs: 10 * 60 * 1000,
    proofGraceMs: 10 * 60 * 1000,
    ttlMs: HOUR,
  };
  const first = commitSessionBindingRotation(sql, {
    ...base,
    now: 1_000,
    proofHash: 'a'.repeat(64),
    boundSecretHash: secretHash,
    expectedProofHash: null,
  });
  assert.equal(first.superseded, false);

  // 接管者判定时读到的是 a，落库 b。
  const takeover = commitSessionBindingRotation(sql, {
    ...base,
    now: 2_000,
    proofHash: 'b'.repeat(64),
    expectedProofHash: 'a'.repeat(64),
  });
  assert.equal(takeover.superseded, false);

  // 迟到的那次提交仍然以为 a 是权威值：必须放弃写入，否则接管者的 b 会被挤进历史、
  // 十分钟后失效，接管者永久 4010。
  const late = commitSessionBindingRotation(sql, {
    ...base,
    now: 3_000,
    proofHash: 'c'.repeat(64),
    expectedProofHash: 'a'.repeat(64),
  });
  assert.equal(late.superseded, true);

  const stored = db
    .prepare("SELECT proof_hash, recent_hashes FROM signaling_session_bindings WHERE peer_id = 'peer-cas'")
    .get() as { proof_hash: string; recent_hashes: string };
  assert.equal(stored.proof_hash, 'b'.repeat(64), '权威 proof 必须还是接管者的');
  assert.equal(stored.recent_hashes.includes('c'.repeat(64)), false, '被放弃的轮换不能进历史');
  db.close();
});


test('自愈补写 pending proof 也走 CAS：接管者换了权威 proof 后不再追加', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionBindingSchema(sql);
  saveSessionBinding(sql, {
    peerId: 'peer-pending-cas',
    secretHash,
    secretHashExpiresAt: 0,
    proofHash: 'a'.repeat(64),
    recentProofHashes: [],
    now: 1_000,
    ttlMs: HOUR,
  });
  const base = { peerId: 'peer-pending-cas', now: 2_000, proofTtlMs: HOUR, bindingTtlMs: HOUR };

  // 判定时权威值是 a：这次自愈可以把 b 挂进历史。
  assert.equal(
    appendPendingSessionProof(sql, { ...base, proofHash: 'b'.repeat(64), expectedProofHash: 'a'.repeat(64) }),
    true
  );

  // 期间被别人接管并轮换到 c。
  const takeover = commitSessionBindingRotation(sql, {
    peerId: 'peer-pending-cas',
    now: 3_000,
    proofHash: 'c'.repeat(64),
    expectedProofHash: 'a'.repeat(64),
    graceMs: 10 * 60 * 1000,
    proofGraceMs: 10 * 60 * 1000,
    ttlMs: HOUR,
  });
  assert.equal(takeover.superseded, false);

  // 迟到的自愈仍然以为 a 是权威值：必须放弃，否则会把 d 写进 c 的历史。
  assert.equal(
    appendPendingSessionProof(sql, { ...base, now: 4_000, proofHash: 'd'.repeat(64), expectedProofHash: 'a'.repeat(64) }),
    false
  );

  const stored = db
    .prepare(
      "SELECT proof_hash, recent_hashes FROM signaling_session_bindings WHERE peer_id = 'peer-pending-cas'"
    )
    .get() as { proof_hash: string; recent_hashes: string };
  assert.equal(stored.proof_hash, 'c'.repeat(64));
  assert.equal(stored.recent_hashes.includes('d'.repeat(64)), false);
  db.close();
});

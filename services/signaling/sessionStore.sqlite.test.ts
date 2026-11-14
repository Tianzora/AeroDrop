import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlite } from '../../scripts/test-stubs/sqlite-adapter.ts';

import {
  appendPendingSessionProof,
  applySessionSlotRelease,
  applySessionSlotReplaceCommit,
  applySessionSlotReserve,
  applySessionSlotRenew,
  commitSessionBindingRotation,
  deferShareCodeRevoke,
  deleteShareCodesByPeerId,
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
    applySessionSlotReserve(sql, { slotId: 'slot-a', clientKey: 'ip:1', releaseToken: 'tok-a', now, maxSessions: 2, ttlMs }),
    true
  );
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-b', clientKey: 'ip:1', releaseToken: 'tok-b', now, maxSessions: 2, ttlMs }),
    true
  );
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-c', clientKey: 'ip:1', releaseToken: 'tok-c', now, maxSessions: 2, ttlMs }),
    false,
    '同一个 client 超过上限必须被拒'
  );

  // 同一个 slotId + 同一个 token：同一条连接的重试，续期且不改归属。
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-a', clientKey: 'ip:1', releaseToken: 'tok-a', now: now + 1, maxSessions: 2, ttlMs }),
    true
  );
  const retried = db
    .prepare("SELECT client_key, release_token FROM signaling_session_slots WHERE slot_id = 'slot-a'")
    .get() as { client_key: string; release_token: string };
  assert.equal(retried.client_key, 'ip:1');
  assert.equal(retried.release_token, 'tok-a');
  assert.equal(countRows(db, 'signaling_session_slots'), 2);

  // 同一个 slotId + 别的 token：拒绝，且不覆盖原归属（这正是并发接管里落败方
  // 改写胜出方名额、随后把行删掉的旧路径，必须彻底关掉）。
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-a', clientKey: 'ip:2', releaseToken: 'tok-a2', now: now + 1, maxSessions: 2, ttlMs }),
    false
  );
  const untouched = db
    .prepare("SELECT client_key, release_token FROM signaling_session_slots WHERE slot_id = 'slot-a'")
    .get() as { client_key: string; release_token: string };
  assert.equal(untouched.client_key, 'ip:1');
  assert.equal(untouched.release_token, 'tok-a');
  assert.equal(countRows(db, 'signaling_session_slots'), 2);

  assert.equal(applySessionSlotRenew(sql, { slotId: 'slot-a', now: now + 2, ttlMs }), true);
  const renewed = db
    .prepare("SELECT expires_at FROM signaling_session_slots WHERE slot_id = 'slot-a'")
    .get() as { expires_at: number };
  assert.equal(renewed.expires_at, now + 2 + ttlMs);

  // 归属不符的释放必须是空操作：并发接管里落败的一方复用同一个 slotId 回滚，
  // 裸删会把胜出方刚投递完 registered 的名额一起删掉（全局上限被悄悄放宽）。
  // 归属凭证是每连接自铸的 releaseToken，不是 clientKey（同一 NAT 出口全相同）。
  applySessionSlotRelease(sql, 'slot-a', 'tok-a2');
  assert.equal(countRows(db, 'signaling_session_slots'), 2, '别的连接不能删掉 tok-a 的名额');

  applySessionSlotRelease(sql, 'slot-a', 'tok-a');
  assert.equal(countRows(db, 'signaling_session_slots'), 1);
  assert.equal(applySessionSlotRenew(sql, { slotId: 'slot-a', now: now + 3, ttlMs }), false);
  db.close();
});

test('接管换名额：旧行靠 token 条件让出，并发接管事后只剩一条活名额', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionSlotSchema(sql);
  const ttlMs = 6 * HOUR;
  const now = 1_000;

  assert.equal(
    applySessionSlotReserve(sql, {
      slotId: 'slot-old',
      clientKey: 'ip:1',
      releaseToken: 'tok-old',
      now,
      maxSessions: 1,
      ttlMs,
    }),
    true
  );
  // 满额（1/1）时接管仍然要能进来：replaces 先把旧会话占的那一格让出来。
  assert.equal(
    applySessionSlotReserve(sql, {
      slotId: 'slot-new',
      clientKey: 'ip:1',
      releaseToken: 'tok-new',
      now,
      maxSessions: 1,
      ttlMs,
      replaces: { slotId: 'slot-old', releaseToken: 'tok-old' },
    }),
    true,
    '接管是「一个换一个」，不能因为旧会话还占着名额就把重连拒掉'
  );
  // 关键：reserve 只让出计数，旧行必须原样留着。删行要等 registered 真的投递出去
  // （commitSlotReplace）；提前删的话，接管方在名额 RPC 在途时断开就会吞掉旧会话的名额。
  assert.equal(
    countRows(db, 'signaling_session_slots'),
    2,
    'reserve 阶段不许删被顶替的旧行：接管随时可能放弃'
  );
  applySessionSlotReplaceCommit(sql, { slotId: 'slot-old', releaseToken: 'tok-old' });
  const remaining = db
    .prepare('SELECT slot_id, client_key, release_token FROM signaling_session_slots')
    .all() as unknown as { slot_id: string; client_key: string; release_token: string }[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].slot_id, 'slot-new');
  assert.equal(remaining[0].release_token, 'tok-new');

  // token 对不上的 replaces 不能删别人的名额，也不能绕过上限：那行现在归属 tok-new。
  // （旧版本这里把 replaces.slotId 指向已经消失的 slot-old，等于只测了「陈旧 replaces」，
  // 把 token 条件整个删掉也不会红。）
  assert.equal(
    applySessionSlotReserve(sql, {
      slotId: 'slot-intruder',
      clientKey: 'ip:1',
      releaseToken: 'tok-intruder',
      now,
      maxSessions: 1,
      ttlMs,
      replaces: { slotId: 'slot-new', releaseToken: 'tok-old' },
    }),
    false,
    'replaces 的 token 对不上就不能让出别人的名额，接管方必须自己撞上限'
  );
  assert.equal(countRows(db, 'signaling_session_slots'), 1);
  assert.equal(
    (db.prepare('SELECT release_token FROM signaling_session_slots').get() as { release_token: string })
      .release_token,
    'tok-new',
    '失败的那次 reserve 不许改写别人那行的归属'
  );

  // 并发接管的落败方回滚：只按自己的 token 删，删不到胜出方那一行。
  applySessionSlotRelease(sql, 'slot-new', 'tok-intruder');
  assert.equal(countRows(db, 'signaling_session_slots'), 1, '落败方不能删掉胜出方的名额');
  applySessionSlotRelease(sql, 'slot-new', 'tok-new');
  assert.equal(countRows(db, 'signaling_session_slots'), 0);
  db.close();
});

test('跨出口接管：别人的名额不能拿来抵自己的上限', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeSessionSlotSchema(sql);
  const ttlMs = 6 * HOUR;
  const now = 1_000;

  // ip:1 占满 1/1，ip:2 也是满的（它自己那一格）。ip:2 接管 ip:1 的会话时必须自己撞上限：
  // 账本按出口 IP 记账，拿别的 IP 的行去扣自己的数会让 12 会话上限变成 13。
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-a', clientKey: 'ip:1', releaseToken: 'tok-a', now, maxSessions: 1, ttlMs }),
    true
  );
  assert.equal(
    applySessionSlotReserve(sql, { slotId: 'slot-b', clientKey: 'ip:2', releaseToken: 'tok-b', now, maxSessions: 1, ttlMs }),
    true
  );
  assert.equal(
    applySessionSlotReserve(sql, {
      slotId: 'slot-b2',
      clientKey: 'ip:2',
      releaseToken: 'tok-b2',
      now,
      maxSessions: 1,
      ttlMs,
      replaces: { slotId: 'slot-a', releaseToken: 'tok-a' },
    }),
    false,
    'ip:2 已经满额，接管 ip:1 的会话不能靠扣别人的名额把自己放进来'
  );
  assert.equal(countRows(db, 'signaling_session_slots'), 2, '被拒的接管不许动 ip:1 的那一行');
  const owners = db
    .prepare('SELECT slot_id, client_key, release_token FROM signaling_session_slots ORDER BY slot_id')
    .all() as unknown as { slot_id: string; client_key: string; release_token: string }[];
  assert.deepEqual(
    owners.map((row) => [row.slot_id, row.client_key, row.release_token]),
    [
      ['slot-a', 'ip:1', 'tok-a'],
      ['slot-b', 'ip:2', 'tok-b'],
    ]
  );

  // 同一个 IP 内的接管仍然要能进来（这才是「一个换一个」的语义）。
  assert.equal(
    applySessionSlotReserve(sql, {
      slotId: 'slot-b3',
      clientKey: 'ip:2',
      releaseToken: 'tok-b3',
      now,
      maxSessions: 1,
      ttlMs,
      replaces: { slotId: 'slot-b', releaseToken: 'tok-b' },
    }),
    true
  );
  // 同上：reserve 不删旧行，成功提交后才删。
  assert.equal(countRows(db, 'signaling_session_slots'), 3);
  applySessionSlotReplaceCommit(sql, { slotId: 'slot-b', releaseToken: 'tok-b' });
  assert.equal(countRows(db, 'signaling_session_slots'), 2);
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
  // 同一个 peerId 重复登记同一张码 = 续期，必须原地更新而不是撞冲突：
  // 发送端在 TTL 边界重新登记时不能失败，也不能把行删了重建。
  const renewed: ShareCodeRecord = { ...record, expiresAt: now + 2 * HOUR };
  assert.equal(insertShareCode(sql, renewed, now + 1), true);
  assert.equal(countRows(db, 'share_codes'), 1);
  assert.deepEqual(findActiveShareCode(sql, { code: 'ABC123', now, tombstoneMs: 24 * HOUR }), renewed);

  // 延迟注销：写入 revoke_after 但尚未到点，口令仍可用，且必须在宽限期内能 resume。
  assert.equal(deferShareCodeRevoke(sql, record, now + 60_000), true);
  assert.equal(resumeShareCode(sql, record), true, '宽限期内必须能 resume');
  assert.deepEqual(findActiveShareCode(sql, { code: 'ABC123', now: now + 1, tombstoneMs: 24 * HOUR }), renewed);

  // 注销：先写墓碑再删活跃行，两块都必须在真实库上生效。
  assert.equal(revokeShareCode(sql, record, now + 500), true);
  assert.equal(countRows(db, 'share_codes'), 0);
  assert.deepEqual(
    findRecentTombstoneByPeerId(sql, { peerId: 'peer-code', now: now + 501, tombstoneMs: 24 * HOUR }),
    { secretHash }
  );

  // 自然到期：读路径只过滤、不写库（见下一条用例），过期行会留到下一次写路径 purge。
  const shortLived: ShareCodeRecord = { ...record, code: 'XYZ789', expiresAt: now + 10 };
  assert.equal(insertShareCode(sql, shortLived, now), true);
  assert.equal(
    findActiveShareCode(sql, { code: 'XYZ789', now: now + 11, tombstoneMs: 24 * HOUR }),
    null,
    '过期的口令不能被当成活跃口令返回'
  );
  assert.equal(countRows(db, 'share_codes'), 1);
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
  const reserve = (clientKey: string, now: number, releaseToken = `tok-${clientKey}`) =>
    applySessionSlotReserve(sql, {
      slotId: 'slot-a',
      clientKey,
      releaseToken,
      now,
      maxSessions: 12,
      ttlMs: 60_000,
    });
  assert.equal(reserve('client-1', 1_000), true);
  // 同一条连接重试：只更新过期时间这一行，必须返回 true。
  assert.equal(reserve('client-1', 2_000), true);
  // 而「一行都没写」必须能让调用方看出来：rowsWritten 取 changes 而不是
  // RETURNING 的行数，否则删掉别人的名额也会被当成成功。
  const noop = sql.exec('DELETE FROM signaling_session_slots WHERE slot_id = ?', 'slot-missing');
  assert.equal(noop.rowsWritten, 0, '零行写入必须报 0');
  // 别的连接拿同一个 slotId 换 token 来抢归属：拒绝，且行一个字节都不变。
  assert.equal(reserve('client-2', 3_000), false);
  const row = db
    .prepare("SELECT client_key, release_token FROM signaling_session_slots WHERE slot_id = 'slot-a'")
    .get() as { client_key: string; release_token: string };
  assert.equal(row.client_key, 'client-1');
  assert.equal(row.release_token, 'tok-client-1');
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

test('口令登记：别人的码撞车时旧行分毫未动，且删旧码时保住刚建成的那张', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeShareCodeSchema(sql);
  const now = 1_000;
  const ownerRow: ShareCodeRecord = {
    code: 'ABCDEF',
    peerId: 'peer-owner',
    secretHash: 'a'.repeat(64),
    expiresAt: now + HOUR,
  };
  assert.equal(insertShareCode(sql, ownerRow, now), true);

  // 另一个 peerId 抢同一个自定义码：必须 taken，且原行的归属/摘要/到期时间一个字都不许变。
  // 旧实现（先 deleteShareCodesByPeerId 再 DO NOTHING 插入）会在这里把 owner 的活跃码删掉，
  // 观众当场 404、发送端重连 unauthorized。
  const intruder: ShareCodeRecord = {
    code: 'ABCDEF',
    peerId: 'peer-intruder',
    secretHash: 'b'.repeat(64),
    expiresAt: now + 5 * HOUR,
  };
  assert.equal(insertShareCode(sql, intruder, now + 10), false);
  assert.equal(countRows(db, 'share_codes'), 1);
  assert.deepEqual(findActiveShareCode(sql, { code: 'ABCDEF', now, tombstoneMs: 24 * HOUR }), ownerRow);

  // 同一 peerId 换一张码成功后，才清掉它的其它旧码，并且必须保住新码。
  const fresh: ShareCodeRecord = {
    code: 'GHIJKL',
    peerId: 'peer-owner',
    secretHash: 'c'.repeat(64),
    expiresAt: now + 6 * HOUR,
  };
  assert.equal(insertShareCode(sql, fresh, now + 20), true);
  deleteShareCodesByPeerId(sql, 'peer-owner', fresh.code);
  assert.equal(findActiveShareCode(sql, { code: 'ABCDEF', now: now + 21, tombstoneMs: 24 * HOUR }), null);
  assert.deepEqual(findActiveShareCode(sql, { code: 'GHIJKL', now: now + 21, tombstoneMs: 24 * HOUR }), fresh);
  db.close();
});

test('读路径不再写库：过期行仍在表里，但 findActiveShareCode 必须过滤掉', () => {
  const db = new DatabaseSync(':memory:');
  const sql = createSqlite(db);
  initializeShareCodeSchema(sql);
  const now = 1_000;
  const expired: ShareCodeRecord = {
    code: 'EXPIRD',
    peerId: 'peer-expired',
    secretHash: 'd'.repeat(64),
    expiresAt: now - 1,
  };
  assert.equal(insertShareCode(sql, expired, now - HOUR), true);

  assert.equal(findActiveShareCode(sql, { code: 'EXPIRD', now, tombstoneMs: 24 * HOUR }), null);
  // 未认证的 GET /api/share-code/:code 会走这条路径。以前它顺手跑 DELETE，等于让匿名请求
  // 在 shard 0 开写事务；现在读就是读，行要等写路径（登记/撤销）的 purge 才清掉。
  assert.equal(countRows(db, 'share_codes'), 1);
  db.close();
});

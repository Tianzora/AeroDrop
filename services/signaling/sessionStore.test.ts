import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNALING_SESSION_BINDING_MS,
  parseSessionProofHistory,
  SIGNALING_SESSION_SLOT_TTL_MS,
  SHARE_CODE_TOMBSTONE_MS,
  applySessionSlotRelease,
  applySessionSlotRenew,
  applySessionSlotReserve,
  appendPendingSessionProof,
  buildPendingSessionProofHistory,
  commitSessionBindingRotation,
  deleteShareCodesByPeerId,
  findActiveShareCode,
  findSessionBinding,
  initializeSessionBindingSchema,
  initializeSessionSlotSchema,
  insertShareCode,
  planSessionAdmission,
  resolveSessionBindingRotation,
  saveSessionBinding,
  type SqlLike,
} from './sessionStore.ts';
import { SESSION_PROOF_GRACE_MS, SESSION_SECRET_HASH_GRACE_MS } from './sessionBinding.ts';

type BindingRow = {
  peer_id: string;
  secret_hash: string | null;
  secret_hash_expires_at: number;
  proof_hash: string;
  recent_hashes: string;
  updated_at: number;
  expires_at: number;
};

type FakeCall = { sql: string; params: unknown[] };

/**
 * 记录调用 + 预置返回的 SQL fake。
 *
 * 这里刻意不引入 sqlite：sessionStore 的输入就是「SQL 文本 + 参数」，只要 fake 认得
 * 自己关心的那几条语句，就能在 node:test 里跑真实的状态机分支。
 */
const createFakeSql = (
  handler: (call: FakeCall) => { rows?: unknown[]; rowsWritten?: number } | undefined = () => undefined
) => {
  const calls: FakeCall[] = [];
  const sql: SqlLike = {
    exec<T = Record<string, unknown>>(text: string, ...params: unknown[]) {
      const call = { sql: text, params };
      calls.push(call);
      const preset = handler(call) ?? {};
      const rows = (preset.rows ?? []) as T[];
      return { toArray: () => rows, rowsWritten: preset.rowsWritten ?? rows.length };
    },
  };
  const isWrite = (call: FakeCall): boolean => !/^\s*(SELECT|PRAGMA)/i.test(call.sql);
  return {
    sql,
    calls,
    writes: (): FakeCall[] => calls.filter(isWrite),
    statements: (): string[] => calls.map((call) => call.sql),
  };
};

/** 只模拟会话绑定表：足够覆盖建表迁移、读写、过期清理与轮换。 */
const createBindingSql = (initial: BindingRow[] = []) => {
  const bindings = new Map(initial.map((row) => [row.peer_id, row] as const));
  const fake = createFakeSql((call) => {
    const text = call.sql;
    if (text.startsWith('PRAGMA table_info')) {
      return { rows: [{ name: 'peer_id' }, { name: 'secret_hash_expires_at' }] };
    }
    if (text.startsWith('SELECT secret_hash')) {
      const row = bindings.get(String(call.params[0]));
      return { rows: row ? [row] : [] };
    }
    if (text.startsWith('DELETE FROM signaling_session_bindings WHERE expires_at <= ?')) {
      const now = Number(call.params[0]);
      for (const [peerId, row] of bindings) {
        if (row.expires_at <= now) bindings.delete(peerId);
      }
      return {};
    }
    if (text.startsWith('DELETE FROM signaling_session_bindings WHERE peer_id = ?')) {
      bindings.delete(String(call.params[0]));
      return {};
    }
    if (text.startsWith('INSERT INTO signaling_session_bindings')) {
      const [peerId, secretHash, secretHashExpiresAt, proofHash, recentHashes, now, expiresAt] =
        call.params as [string, string | null, number, string, string, number, number];
      bindings.set(peerId, {
        peer_id: peerId,
        secret_hash: secretHash,
        secret_hash_expires_at: secretHashExpiresAt,
        proof_hash: proofHash,
        recent_hashes: recentHashes,
        updated_at: now,
        expires_at: expiresAt,
      });
      return {};
    }
    return undefined;
  });
  return { ...fake, bindings };
};

const secretHash = 'a'.repeat(64);
const otherSecretHash = 'b'.repeat(64);
const proofHash = 'c'.repeat(64);
const nextProofHash = 'd'.repeat(64);

const row = (overrides: Partial<BindingRow> = {}): BindingRow => ({
  peer_id: 'peer-1',
  secret_hash: secretHash,
  secret_hash_expires_at: 1_000,
  proof_hash: proofHash,
  recent_hashes: '[]',
  updated_at: 0,
  expires_at: 10 * SIGNALING_SESSION_BINDING_MS,
  ...overrides,
});

test('parseSessionProofHistory treats corrupt history as empty and keeps only well-formed entries', () => {
  assert.deepEqual(parseSessionProofHistory(null), []);
  assert.deepEqual(parseSessionProofHistory(''), []);
  assert.deepEqual(parseSessionProofHistory('not json'), []);
  assert.deepEqual(parseSessionProofHistory('{"proofHash":"a","expiresAt":1}'), []);
  assert.deepEqual(
    parseSessionProofHistory(
      JSON.stringify([
        { proofHash: 'a', expiresAt: 1 },
        { proofHash: 'b' },
        { expiresAt: 2 },
        null,
        'x',
      ])
    ),
    [{ proofHash: 'a', expiresAt: 1 }]
  );
});

test('adds the secret_hash_expires_at column only when the old table lacks it', () => {
  const empty = createFakeSql((call) =>
    call.sql.startsWith('PRAGMA table_info') ? { rows: [{ name: 'peer_id' }] } : undefined
  );
  initializeSessionBindingSchema(empty.sql);
  assert.ok(
    empty.calls.some((call) => call.sql.startsWith('ALTER TABLE signaling_session_bindings')),
    'old deployments get the column backfilled'
  );

  const migrated = createBindingSql();
  initializeSessionBindingSchema(migrated.sql);
  assert.ok(
    !migrated.calls.some((call) => call.sql.startsWith('ALTER TABLE')),
    'new tables must not be altered again'
  );
});

test('reads a live binding and drops an expired one', () => {
  const live = createBindingSql([row()]);
  assert.deepEqual(findSessionBinding(live.sql, 'peer-1', 500), {
    secretHash,
    secretHashExpiresAt: 1_000,
    proofHash,
    recentProofHashes: [],
  });
  assert.equal(live.bindings.has('peer-1'), true);

  const expired = createBindingSql([row({ expires_at: 400 })]);
  assert.equal(findSessionBinding(expired.sql, 'peer-1', 500), null);
  assert.equal(expired.bindings.has('peer-1'), false, 'expired rows are purged, not left to lock the peerId');
});

test('planSessionAdmission is read-only and asks for rotation only for bound sessions', () => {
  const anonymous = createBindingSql();
  const anonymousPlan = planSessionAdmission(anonymous.sql, { peerId: 'peer-1', now: 1_000 });
  assert.deepEqual(anonymousPlan, { allowed: true, needsRotation: false });
  assert.equal(anonymous.writes().length, 0, 'planning must not write');

  // 首次带静态摘要的注册：这里就决定了摘要的归属与开窗时机，仍不落库。
  const firstBind = createBindingSql();
  assert.deepEqual(
    planSessionAdmission(firstBind.sql, {
      peerId: 'peer-1',
      incomingSecretHash: secretHash,
      now: 1_000,
    }),
    { allowed: true, needsRotation: true, boundSecretHash: secretHash, expectedProofHash: null }
  );
  assert.equal(firstBind.writes().length, 0, 'planning must not write');

  const bound = createBindingSql([row()]);
  const boundPlan = planSessionAdmission(bound.sql, {
    peerId: 'peer-1',
    incomingSecretHash: secretHash,
    incomingProofHash: undefined,
    now: 500,
  });
  assert.deepEqual(boundPlan, {
    allowed: true,
    needsRotation: true,
    boundSecretHash: secretHash,
    expectedProofHash: proofHash,
  });
  assert.equal(bound.writes().length, 0, 'a later quota/slot failure must not invalidate the old proof');
});

test('static digest is rejected once its window expires while the rotated proof still works', () => {
  const fake = createBindingSql([
    row({ secret_hash_expires_at: 1_000, recent_hashes: JSON.stringify([{ proofHash: nextProofHash, expiresAt: 5_000 }]) }),
  ]);

  // 窗口过期后：静态摘要不再能冒充凭证（旧实现在每次 admission 里续期，导致永不过期）。
  assert.deepEqual(
    planSessionAdmission(fake.sql, {
      peerId: 'peer-1',
      incomingSecretHash: secretHash,
      now: 1_500,
    }),
    { allowed: false }
  );

  // 同一时刻 proof 依然可用：当前 proof 与宽限期内的历史 proof 都放行。
  assert.equal(
    planSessionAdmission(fake.sql, {
      peerId: 'peer-1',
      incomingProofHash: proofHash,
      now: 1_500,
    }).allowed,
    true
  );
  assert.equal(
    planSessionAdmission(fake.sql, {
      peerId: 'peer-1',
      incomingProofHash: nextProofHash,
      now: 1_500,
    }).allowed,
    true
  );
});

test('the first binding opens the digest window and later admissions never extend it', () => {
  const fake = createBindingSql();
  const first = commitSessionBindingRotation(fake.sql, {
    peerId: 'peer-1',
    now: 10_000,
    proofHash,
    boundSecretHash: secretHash,
    graceMs: SESSION_SECRET_HASH_GRACE_MS,
    proofGraceMs: SESSION_PROOF_GRACE_MS,
    ttlMs: SIGNALING_SESSION_BINDING_MS,
  });
  assert.equal(first.secretHash, secretHash);
  assert.equal(first.secretHashExpiresAt, 10_000 + SESSION_SECRET_HASH_GRACE_MS);
  assert.equal(first.secretHashCleared, false);

  // 第二次注册（窗口内）不能把过期时间往后推。
  const second = commitSessionBindingRotation(fake.sql, {
    peerId: 'peer-1',
    now: 10_000 + 60_000,
    proofHash: nextProofHash,
    boundSecretHash: secretHash,
    graceMs: SESSION_SECRET_HASH_GRACE_MS,
    proofGraceMs: SESSION_PROOF_GRACE_MS,
    ttlMs: SIGNALING_SESSION_BINDING_MS,
  });
  assert.equal(second.secretHashExpiresAt, 10_000 + SESSION_SECRET_HASH_GRACE_MS);
  assert.equal(second.secretHashCleared, false);

  // 窗口过期后的这次轮换把摘要清成 NULL，之后只认 proof。
  const expired = commitSessionBindingRotation(fake.sql, {
    peerId: 'peer-1',
    now: 10_000 + SESSION_SECRET_HASH_GRACE_MS + 1,
    proofHash: 'e'.repeat(64),
    boundSecretHash: secretHash,
    graceMs: SESSION_SECRET_HASH_GRACE_MS,
    proofGraceMs: SESSION_PROOF_GRACE_MS,
    ttlMs: SIGNALING_SESSION_BINDING_MS,
  });
  assert.equal(expired.secretHash, null);
  assert.equal(expired.secretHashExpiresAt, 0);
  assert.equal(expired.secretHashCleared, true);
  assert.equal(fake.bindings.get('peer-1')?.secret_hash, null);
});

test('resolveSessionBindingRotation keeps an existing window and clears an expired one', () => {
  const current = { secretHash, secretHashExpiresAt: 9_000, proofHash, recentProofHashes: [] };
  assert.deepEqual(resolveSessionBindingRotation({ current, now: 1_000, graceMs: 600_000 }), {
    secretHash,
    secretHashExpiresAt: 9_000,
    secretHashCleared: false,
  });
  assert.deepEqual(resolveSessionBindingRotation({ current, now: 9_001, graceMs: 600_000 }), {
    secretHash: null,
    secretHashExpiresAt: 0,
    secretHashCleared: true,
  });
  // 已清空的行不会被重新填回摘要（fallback 只在首次绑定时生效）。
  assert.deepEqual(
    resolveSessionBindingRotation({
      current: { ...current, secretHash: null, secretHashExpiresAt: 0 },
      fallbackSecretHash: otherSecretHash,
      now: 10,
      graceMs: 600_000,
    }),
    { secretHash: null, secretHashExpiresAt: 0, secretHashCleared: false }
  );
});

test('saveSessionBinding upserts the record with a 24h binding ttl', () => {
  const fake = createBindingSql();
  saveSessionBinding(fake.sql, {
    peerId: 'peer-1',
    secretHash,
    secretHashExpiresAt: 2_000,
    proofHash,
    recentProofHashes: [],
    now: 1_000,
    ttlMs: SIGNALING_SESSION_BINDING_MS,
  });
  const stored = fake.bindings.get('peer-1');
  assert.equal(stored?.secret_hash, secretHash);
  assert.equal(stored?.secret_hash_expires_at, 2_000);
  assert.equal(stored?.expires_at, 1_000 + SIGNALING_SESSION_BINDING_MS);
});

/* ------------------------------------------------------------------ */
/* 会话槽位                                                            */
/* ------------------------------------------------------------------ */

test('slot reserve grants one seat per client, transfers an existing slot, and enforces the cap', () => {
  // 第一次：SELECT 空 → COUNT 0 → INSERT。
  const script: Array<{ rows?: unknown[]; rowsWritten?: number }> = [
    {}, // DELETE expired
    { rows: [] }, // SELECT slot
    { rows: [{ count: 0 }] }, // COUNT client
    {}, // INSERT
  ];
  let index = 0;
  const scripted: SqlLike = {
    exec<T = Record<string, unknown>>() {
      const preset = script[index++] ?? {};
      return {
        toArray: () => (preset.rows ?? []) as T[],
        rowsWritten: preset.rowsWritten ?? 0,
      };
    },
  };
  assert.equal(
    applySessionSlotReserve(scripted, {
      slotId: 'slot-a',
      clientKey: 'ip:1',
      releaseToken: 'tok-1',
      now: 0,
      maxSessions: 2,
      ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
    }),
    true
  );
  assert.equal(index, 4, 'reserve runs delete → select → count → insert');

  // 同一个 slotId + 同一个 token：同一条连接的重试，续期即可，不再数名额。
  const retryCalls: string[] = [];
  const retrySql: SqlLike = {
    exec<T = Record<string, unknown>>(text: string) {
      retryCalls.push(text);
      if (text.startsWith('SELECT slot_id')) {
        return { toArray: () => [{ slot_id: 'slot-a', release_token: 'tok-1' }] as T[] };
      }
      return { toArray: () => [] as T[] };
    },
  };
  assert.equal(
    applySessionSlotReserve(retrySql, {
      slotId: 'slot-a',
      clientKey: 'ip:1',
      releaseToken: 'tok-1',
      now: 100,
      maxSessions: 2,
      ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
    }),
    true
  );
  assert.ok(retryCalls.some((text) => text.startsWith('UPDATE signaling_session_slots')));
  assert.ok(!retryCalls.some((text) => text.startsWith('SELECT COUNT(*)')));

  // 同一个 slotId + 别的 token：拒绝，且一个字节都不改。改写归属正是并发接管里
  // 「落败方删掉胜出方名额」的成因，这条分支不允许存在。
  const foreignCalls: string[] = [];
  const foreignSql: SqlLike = {
    exec<T = Record<string, unknown>>(text: string) {
      foreignCalls.push(text);
      if (text.startsWith('SELECT slot_id')) {
        return { toArray: () => [{ slot_id: 'slot-a', release_token: 'tok-1' }] as T[] };
      }
      return { toArray: () => [] as T[] };
    },
  };
  assert.equal(
    applySessionSlotReserve(foreignSql, {
      slotId: 'slot-a',
      clientKey: 'ip:2',
      releaseToken: 'tok-2',
      now: 100,
      maxSessions: 2,
      ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
    }),
    false
  );
  assert.ok(!foreignCalls.some((text) => text.startsWith('UPDATE signaling_session_slots')));

  // 名额已满：拒绝，且不落 INSERT。
  const fullCalls: string[] = [];
  const fullSql: SqlLike = {
    exec<T = Record<string, unknown>>(text: string) {
      fullCalls.push(text);
      if (text.startsWith('SELECT slot_id')) return { toArray: () => [] as T[] };
      if (text.startsWith('SELECT COUNT(*)')) return { toArray: () => [{ count: 2 }] as T[] };
      return { toArray: () => [] as T[] };
    },
  };
  assert.equal(
    applySessionSlotReserve(fullSql, {
      slotId: 'slot-c',
      clientKey: 'ip:3',
      releaseToken: 'tok-3',
      now: 0,
      maxSessions: 2,
      ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
    }),
    false
  );
  assert.ok(!fullCalls.some((text) => text.startsWith('INSERT OR REPLACE')));
});

test('slot release 带 releaseToken 时只删自己那张：并发接管落败方不能删掉胜出方的名额', () => {
  const conditional = createFakeSql();
  applySessionSlotRelease(conditional.sql, 'slot-x', 'tok-1');
  const [call] = conditional.calls.filter((entry) =>
    entry.sql.startsWith('DELETE FROM signaling_session_slots')
  );
  assert.match(call.sql, /WHERE slot_id = \? AND release_token = \?/);
  assert.deepEqual(call.params, ['slot-x', 'tok-1']);
  // clientKey 是出口 IP：同一张 NAT 后面的所有连接都一样，拿它做归属判定等于没有判定。
  assert.doesNotMatch(call.sql, /client_key/);

  // 不传 token 时保持旧语义（服务端内部兜底释放），否则 TTL 清理之外的回收路径会漏。
  const unconditional = createFakeSql();
  applySessionSlotRelease(unconditional.sql, 'slot-x');
  const [plain] = unconditional.calls.filter((entry) =>
    entry.sql.startsWith('DELETE FROM signaling_session_slots')
  );
  assert.doesNotMatch(plain.sql, /client_key/);
});

test('slot release is idempotent and renew reports a missing slot', () => {
  const fake = createFakeSql();
  assert.doesNotThrow(() => applySessionSlotRelease(fake.sql, 'missing-slot'));
  assert.doesNotThrow(() => applySessionSlotRelease(fake.sql, 'missing-slot'));
  applySessionSlotRelease(fake.sql, 'missing-slot');
  const deletes = fake.calls.filter((call) => call.sql.startsWith('DELETE FROM signaling_session_slots'));
  assert.equal(deletes.length, 3, 'release never throws on an already-released slot');

  const nothingUpdated = createFakeSql(() => ({ rowsWritten: 0 }));
  assert.equal(
    applySessionSlotRenew(nothingUpdated.sql, {
      slotId: 'gone',
      now: 1_000,
      ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
    }),
    false
  );
  const updated = createFakeSql(() => ({ rowsWritten: 1 }));
  assert.equal(
    applySessionSlotRenew(updated.sql, {
      slotId: 'live',
      now: 1_000,
      ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
    }),
    true
  );
});

test('slot schema is created once and includes the client index', () => {
  const fake = createFakeSql();
  initializeSessionSlotSchema(fake.sql);
  const statements = fake.statements();
  assert.ok(statements.some((text) => text.includes('CREATE TABLE IF NOT EXISTS signaling_session_slots')));
  assert.ok(statements.some((text) => text.includes('idx_signaling_session_slots_client')));
});

/* ------------------------------------------------------------------ */
/* 口令表                                                              */
/* ------------------------------------------------------------------ */

test('findActiveShareCode returns a live row and hides a revoked or expired one', () => {
  const active = createFakeSql((call) => {
    if (call.sql.startsWith('SELECT code')) {
      return {
        rows: [{ code: '123456', peer_id: 'peer-1', secret_hash: secretHash, expires_at: 5_000, revoke_after: null }],
      };
    }
    return undefined;
  });
  assert.deepEqual(
    findActiveShareCode(active.sql, { code: '123456', now: 1_000, tombstoneMs: SHARE_CODE_TOMBSTONE_MS }),
    { code: '123456', peerId: 'peer-1', secretHash, expiresAt: 5_000 }
  );

  const revoked = createFakeSql((call) =>
    call.sql.startsWith('SELECT code')
      ? {
          rows: [
            { code: '123456', peer_id: 'peer-1', secret_hash: secretHash, expires_at: 5_000, revoke_after: 900 },
          ],
        }
      : undefined
  );
  assert.equal(
    findActiveShareCode(revoked.sql, { code: '123456', now: 1_000, tombstoneMs: SHARE_CODE_TOMBSTONE_MS }),
    null,
    'revoke_after 已生效的行不可再被查询到'
  );

  const expired = createFakeSql((call) =>
    call.sql.startsWith('SELECT code')
      ? {
          rows: [{ code: '123456', peer_id: 'peer-1', secret_hash: secretHash, expires_at: 900, revoke_after: null }],
        }
      : undefined
  );
  assert.equal(
    findActiveShareCode(expired.sql, { code: '123456', now: 1_000, tombstoneMs: SHARE_CODE_TOMBSTONE_MS }),
    null
  );
});

test('insertShareCode reports a code collision instead of overwriting', () => {
  const inserted = createFakeSql(() => ({ rows: [{ code: '123456' }] }));
  assert.equal(
    insertShareCode(inserted.sql, { code: '123456', peerId: 'peer-1', secretHash, expiresAt: 5_000 }, 1_000),
    true
  );

  const collided = createFakeSql(() => ({ rows: [] }));
  assert.equal(
    insertShareCode(collided.sql, { code: '123456', peerId: 'peer-1', secretHash, expiresAt: 5_000 }, 1_000),
    false
  );
  // 冲突时旧行必须分毫未动：只允许同一 peerId 原地续期（WHERE share_codes.peer_id = excluded.peer_id），
  // 否则「别人的码」会被抢占，或「自己的旧码」被无声删除。
  const collisionSql = collided.calls[0].sql;
  assert.ok(collisionSql.includes('ON CONFLICT(code) DO UPDATE'));
  assert.ok(collisionSql.includes('WHERE share_codes.peer_id = excluded.peer_id'));
});

test('deleteShareCodesByPeerId keeps the freshly allocated code when asked', () => {
  const sql = createFakeSql(() => ({ rows: [] }));
  deleteShareCodesByPeerId(sql.sql, 'peer-1', '654321');
  assert.equal(sql.calls.at(-1)?.sql, 'DELETE FROM share_codes WHERE peer_id = ? AND code <> ?');
  assert.deepEqual(sql.calls.at(-1)?.params, ['peer-1', '654321']);

  deleteShareCodesByPeerId(sql.sql, 'peer-1');
  assert.equal(sql.calls.at(-1)?.sql, 'DELETE FROM share_codes WHERE peer_id = ?');
});

/* ------------------------------------------------------------------ */
/* 落库失败后的 pending proof 自愈                                      */
/* ------------------------------------------------------------------ */

test('buildPendingSessionProofHistory keeps the live entries and appends the delivered proof', () => {
  const current = {
    secretHash,
    secretHashExpiresAt: 2_000,
    proofHash,
    recentProofHashes: [
      { proofHash: 'e'.repeat(64), expiresAt: 900 }, // 已过期
      { proofHash: 'f'.repeat(64), expiresAt: 8_000 },
    ],
  };

  const history = buildPendingSessionProofHistory({
    current,
    proofHash: nextProofHash.toUpperCase(),
    now: 1_000,
    ttlMs: SIGNALING_SESSION_BINDING_MS,
  });

  assert.deepEqual(history, [
    { proofHash: 'f'.repeat(64), expiresAt: 8_000 },
    // 统一小写：判定侧按 lowercase 比较，写进历史的大小写不能成为第二个分支。
    { proofHash: nextProofHash, expiresAt: 1_000 + SIGNALING_SESSION_BINDING_MS },
  ]);
});

test('buildPendingSessionProofHistory replaces a re-appended proof instead of duplicating it', () => {
  const history = buildPendingSessionProofHistory({
    current: {
      secretHash,
      secretHashExpiresAt: 0,
      proofHash,
      recentProofHashes: [{ proofHash: nextProofHash, expiresAt: 2_000 }],
    },
    proofHash: nextProofHash,
    now: 1_000,
    ttlMs: SIGNALING_SESSION_BINDING_MS,
  });

  assert.deepEqual(history, [{ proofHash: nextProofHash, expiresAt: 1_000 + SIGNALING_SESSION_BINDING_MS }]);
});

test('appendPendingSessionProof lets the delivered proof reconnect after a failed commit', () => {
  const fake = createBindingSql([row()]);
  assert.equal(
    appendPendingSessionProof(fake.sql, {
      peerId: 'peer-1',
      proofHash: nextProofHash,
      now: 5_000,
      proofTtlMs: SIGNALING_SESSION_BINDING_MS,
      bindingTtlMs: SIGNALING_SESSION_BINDING_MS,
    }),
    true
  );

  // 掉线的客户端手里只有新 proof：判定必须放行，否则这条会话永远回不来。
  assert.deepEqual(
    planSessionAdmission(fake.sql, { peerId: 'peer-1', incomingProofHash: nextProofHash, now: 6_000 }),
    {
      allowed: true,
      needsRotation: true,
      boundSecretHash: secretHash,
      expectedProofHash: proofHash,
    }
  );

  const stored = fake.bindings.get('peer-1');
  // 当前 proof 仍是权威值：这次轮换从未落库，回滚会让双方都丢掉已知有效的凭证。
  assert.equal(stored?.proof_hash, proofHash);
  assert.equal(stored?.secret_hash, secretHash);
  assert.equal(stored?.expires_at, 5_000 + SIGNALING_SESSION_BINDING_MS);
  assert.deepEqual(parseSessionProofHistory(stored?.recent_hashes ?? null), [
    { proofHash: nextProofHash, expiresAt: 5_000 + SIGNALING_SESSION_BINDING_MS },
  ]);
});

test('appendPendingSessionProof is a no-op when the rotation already landed', () => {
  const fake = createBindingSql([row({ proof_hash: nextProofHash })]);
  assert.equal(
    appendPendingSessionProof(fake.sql, {
      peerId: 'peer-1',
      proofHash: nextProofHash,
      now: 5_000,
      proofTtlMs: SIGNALING_SESSION_BINDING_MS,
      bindingTtlMs: SIGNALING_SESSION_BINDING_MS,
    }),
    true
  );
  // 只读：重试虽然超时了，但写入其实已经生效，再挂一份历史等于给攻击面多加一个 hash。
  assert.deepEqual(fake.writes(), []);
});

test('appendPendingSessionProof reports false without a binding row', () => {
  const fake = createBindingSql();
  assert.equal(
    appendPendingSessionProof(fake.sql, {
      peerId: 'peer-1',
      proofHash: nextProofHash,
      now: 5_000,
      proofTtlMs: SIGNALING_SESSION_BINDING_MS,
      bindingTtlMs: SIGNALING_SESSION_BINDING_MS,
    }),
    false
  );
  assert.deepEqual(fake.writes(), []);
});

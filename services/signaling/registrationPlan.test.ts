import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySignalingSessionRace,
  planSignalingRegistration,
  SIGNALING_BINDING_UNAVAILABLE_RETRY_AFTER_SECONDS,
  type SignalingRegistrationAction,
} from './registrationPlan.ts';

const kinds = (actions: SignalingRegistrationAction[]) => actions.map((action) => action.kind);

test('rejects a conflicting admission before touching any session quorum', () => {
  const actions = planSignalingRegistration({
    existingSession: 'takeover',
    race: 'none',
    admission: 'rejected',
    seat: { kind: 'acquire' },
    shardCount: 3,
    pendingRotation: false,
  });

  // 拒绝路径必须是唯一动作：先领名额再拒绝会漏掉释放，旧连接的 proof 也会被作废。
  assert.deepEqual(actions, [{ kind: 'reject-conflict', reason: 'identity' }]);
});

test('aborts a raced registration instead of ejecting the winner', () => {
  const actions = planSignalingRegistration({
    existingSession: 'none',
    race: 'different',
    admission: 'allowed',
    seat: { kind: 'acquire' },
    shardCount: 1,
    pendingRotation: true,
  });

  // 输了竞争说明别人已经落定；此时 eject 会把对方刚注册的 socket 从 map 里顶掉。
  assert.deepEqual(actions, [{ kind: 'reject-conflict', reason: 'race' }]);
});

test('reserves quorum before ejecting the old socket on takeover', () => {
  const actions = planSignalingRegistration({
    existingSession: 'takeover',
    race: 'same',
    admission: 'allowed',
    seat: { kind: 'transfer' },
    shardCount: 3,
    pendingRotation: true,
  });

  assert.deepEqual(kinds(actions), [
    'reserve-global-slot',
    'reserve-seat',
    'eject-existing',
    'send-registered',
    'commit-binding',
  ]);
  // 席位转移不该被当成「新领」：转移动走了旧 socket 的计数，失败路径才不用回滚。
  assert.deepEqual(actions[1], { kind: 'reserve-seat', mode: 'transfer' });
});

test('keeps singleton registrations on the in-memory limiter', () => {
  const actions = planSignalingRegistration({
    existingSession: 'none',
    race: 'none',
    admission: 'allowed',
    seat: { kind: 'acquire' },
    shardCount: 1,
    pendingRotation: false,
  });

  // 单例 DO 没有 shard 0 全局表，多一步 RPC 只会凭空多一条失败路径。
  assert.deepEqual(kinds(actions), ['reserve-seat', 'send-registered']);
});

test('skips the commit when no proof rotation was issued', () => {
  const actions = planSignalingRegistration({
    existingSession: 'none',
    race: 'none',
    admission: 'allowed',
    seat: { kind: 'acquire' },
    shardCount: 2,
    pendingRotation: false,
  });

  assert.equal(kinds(actions).includes('commit-binding'), false);
});

test('classifies the reloaded session owner against the planned one', () => {
  const socket = { id: 'planned' };

  assert.equal(classifySignalingSessionRace({ planned: undefined, current: undefined }), 'none');
  assert.equal(classifySignalingSessionRace({ planned: socket, current: socket }), 'same');
  assert.equal(
    classifySignalingSessionRace({ planned: socket, current: { id: 'winner' } }),
    'different',
  );
  // 判定时没有连接、落定前被别的连接抢注：这也是竞争，不能当成首个连接放过去。
  assert.equal(
    classifySignalingSessionRace({ planned: undefined, current: { id: 'winner' } }),
    'different',
  );
});

test('asks the client to retry instead of holding a half-open upgrade', () => {
  assert.equal(SIGNALING_BINDING_UNAVAILABLE_RETRY_AFTER_SECONDS, 5);
});

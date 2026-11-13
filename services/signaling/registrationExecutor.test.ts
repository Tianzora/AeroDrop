import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRegistrationPlan, type RegistrationExecutionPorts } from './registrationExecutor.ts';
import type { SignalingRegistrationAction } from './registrationPlan.ts';

const rateLimitedResponse = () => new Response(null, { status: 200 });

const createPorts = (overrides: Partial<RegistrationExecutionPorts> = {}) => {
  const calls: string[] = [];
  const ports: RegistrationExecutionPorts = {
    rejectConflict: async () => {
      calls.push('rejectConflict');
      return new Response(null, { status: 200 });
    },
    reserveGlobalSlot: async () => {
      calls.push('reserveGlobalSlot');
      return 'slot-1';
    },
    acquireSeat: () => {
      calls.push('acquireSeat');
      return true;
    },
    rollbackQuota: async () => {
      calls.push('rollbackQuota');
    },
    rejectRaced: async () => {
      calls.push('rejectRaced');
      return null;
    },
    ejectExisting: () => {
      calls.push('ejectExisting');
    },
    sendRegistered: async () => {
      calls.push('sendRegistered');
    },
    sendRateLimited: () => {
      calls.push('sendRateLimited');
      return rateLimitedResponse();
    },
    ...overrides,
  };
  return { ports, calls };
};

const happyPlan: SignalingRegistrationAction[] = [
  { kind: 'reserve-global-slot' },
  { kind: 'reserve-seat', mode: 'acquire' },
  { kind: 'eject-existing' },
  { kind: 'send-registered' },
  { kind: 'commit-binding' },
];

test('按 plan 顺序执行：领名额与席位都发生在驱逐旧 socket 之前', async () => {
  const { ports, calls } = createPorts();
  const result = await executeRegistrationPlan(happyPlan, ports);
  assert.deepEqual(result, { kind: 'done' });
  assert.deepEqual(calls, [
    'reserveGlobalSlot',
    'rejectRaced',
    'acquireSeat',
    'rejectRaced',
    'rejectRaced',
    'ejectExisting',
    'rejectRaced',
    'sendRegistered',
  ]);
});

test('全局名额满额时直接回 4029，不领席位、不驱逐旧 socket、不发 registered', async () => {
  const { ports, calls } = createPorts({
    reserveGlobalSlot: async () => {
      calls.push('reserveGlobalSlot');
      return null;
    },
  });
  const result = await executeRegistrationPlan(happyPlan, ports);
  assert.equal(result.kind, 'respond');
  assert.equal(calls.includes('ejectExisting'), false);
  assert.equal(calls.includes('sendRegistered'), false);
  assert.equal(calls.includes('sendRateLimited'), true);
});

test('席位领不到时先回滚刚领到的全局名额，再回 4029', async () => {
  const { ports, calls } = createPorts({
    acquireSeat: () => {
      calls.push('acquireSeat');
      return false;
    },
  });
  const result = await executeRegistrationPlan(happyPlan, ports);
  assert.equal(result.kind, 'respond');
  const rollbackIndex = calls.indexOf('rollbackQuota');
  const rejectIndex = calls.indexOf('sendRateLimited');
  assert.ok(rollbackIndex >= 0, '必须回滚名额，否则一次失败的重连会永久吃掉一个名额');
  assert.ok(rollbackIndex < rejectIndex, '先回滚再拒绝');
  assert.equal(calls.includes('ejectExisting'), false);
});

test('await 之后发现竞争：回滚并直接冲突，绝不驱逐赢家', async () => {
  let raced = 0;
  const { ports, calls } = createPorts({
    rejectRaced: async () => {
      calls.push('rejectRaced');
      raced += 1;
      return raced === 1 ? new Response(null, { status: 200 }) : null;
    },
  });
  const result = await executeRegistrationPlan(happyPlan, ports);
  assert.equal(result.kind, 'respond');
  assert.equal(calls.includes('ejectExisting'), false);
  assert.equal(calls.includes('sendRegistered'), false);
});

test('只在单例模式跑（无全局槽位）时也能走到 registered', async () => {
  const { ports, calls } = createPorts();
  const actions: SignalingRegistrationAction[] = [
    { kind: 'reserve-seat', mode: 'transfer' },
    { kind: 'send-registered' },
  ];
  const result = await executeRegistrationPlan(actions, ports);
  assert.deepEqual(result, { kind: 'done' });
  assert.deepEqual(calls, ['rejectRaced', 'sendRegistered'], 'transfer 不领取新席位');
});

test('身份拒绝（reject-conflict）是第一个动作：不动名额、不清会话表', async () => {
  const { ports, calls } = createPorts();
  const actions: SignalingRegistrationAction[] = [{ kind: 'reject-conflict', reason: 'identity' }];
  const result = await executeRegistrationPlan(actions, ports);
  assert.equal(result.kind, 'respond');
  assert.deepEqual(calls, ['rejectConflict']);
});

test('commit-binding 不产生额外副作用：落库顺序只住在 sendRegistered 的实现里', async () => {
  const { ports, calls } = createPorts();
  const result = await executeRegistrationPlan(
    [{ kind: 'send-registered' }, { kind: 'commit-binding' }],
    ports
  );
  assert.deepEqual(result, { kind: 'done' });
  assert.deepEqual(calls, ['rejectRaced', 'sendRegistered']);
});

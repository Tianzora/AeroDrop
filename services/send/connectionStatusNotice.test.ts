import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTION_STATUS_NOTICE_MS,
  createConnectionStatusController,
  createConnectionStatusNotice,
  isConnectionStatusNoticeActive,
  resolveConnectionStatus,
  shouldApplyRoutineConnectionStatus,
} from './connectionStatusNotice.ts';

const NOW = 1_000_000;
const NOTICE_TEXT = '分享已失效，进行中的传输不受影响，新设备无法加入';

test('会话提示写入后，常规轮询在窗口内被抑制、窗口过期后恢复', () => {
  const controller = createConnectionStatusController();

  assert.deepEqual(controller.announce(NOTICE_TEXT, NOW), { apply: true, status: NOTICE_TEXT });

  // 3 秒一次的连接数统计正是复评指出的覆盖来源：窗口内一律不许写状态行。
  for (const offset of [3_000, 9_000, 21_000, CONNECTION_STATUS_NOTICE_MS - 1]) {
    const update = controller.routine('已连接 2 个设备', NOW + offset);
    assert.equal(update.apply, false, `窗口内 ${offset}ms 的常规统计不该覆盖提示`);
    assert.equal(update.status, NOTICE_TEXT);
  }

  // 窗口过期：常规统计重新接管，提示不会长期霸占状态行。
  assert.deepEqual(controller.routine('已连接 2 个设备', NOW + CONNECTION_STATUS_NOTICE_MS), {
    apply: true,
    status: '已连接 2 个设备',
  });
});

test('恢复/重开时 announce 空串立刻放行常规值（open/resume/start/stop 同一条路）', () => {
  const controller = createConnectionStatusController();
  controller.announce(NOTICE_TEXT, NOW);

  assert.deepEqual(controller.announce('', NOW + 1_000), { apply: true, status: '' });
  assert.equal(controller.isNoticeActive(NOW + 1_000), false);
  assert.deepEqual(controller.routine('已连接 1 个设备', NOW + 1_000), {
    apply: true,
    status: '已连接 1 个设备',
  });
});

test('提示窗口不因常规写入续期：从写入时刻起算，过期即让位', () => {
  const controller = createConnectionStatusController();
  controller.announce(NOTICE_TEXT, NOW);
  controller.routine('已连接 2 个设备', NOW + 1_000);
  controller.routine('已连接 2 个设备', NOW + 20_000);

  assert.equal(controller.isNoticeActive(NOW + CONNECTION_STATUS_NOTICE_MS - 1), true);
  assert.equal(controller.isNoticeActive(NOW + CONNECTION_STATUS_NOTICE_MS), false);
  assert.equal(controller.routine('', NOW + CONNECTION_STATUS_NOTICE_MS).apply, true);
});

test('过期的提示不会残留成状态行文案', () => {
  const controller = createConnectionStatusController();
  controller.announce(NOTICE_TEXT, NOW);

  assert.deepEqual(controller.routine('', NOW + CONNECTION_STATUS_NOTICE_MS + 60_000), {
    apply: true,
    status: '',
  });
});

test('纯函数语义：窗口边界与最终文案', () => {
  const notice = createConnectionStatusNotice(NOTICE_TEXT, NOW);
  assert.equal(notice.expiresAt, NOW + CONNECTION_STATUS_NOTICE_MS);
  assert.equal(isConnectionStatusNoticeActive(notice, NOW), true);
  assert.equal(isConnectionStatusNoticeActive(notice, NOW + CONNECTION_STATUS_NOTICE_MS), false);
  assert.equal(isConnectionStatusNoticeActive(null, NOW), false);

  assert.equal(shouldApplyRoutineConnectionStatus(notice, NOW + 3_000), false);
  assert.equal(shouldApplyRoutineConnectionStatus(notice, NOW + CONNECTION_STATUS_NOTICE_MS), true);
  assert.equal(resolveConnectionStatus(notice, '已连接 2 个设备', NOW + 3_000), NOTICE_TEXT);
  assert.equal(
    resolveConnectionStatus(notice, '已连接 2 个设备', NOW + CONNECTION_STATUS_NOTICE_MS),
    '已连接 2 个设备',
  );
});

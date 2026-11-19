import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoomShareLeave,
  createRoomShareRequest,
  createRoomShareState,
  isRoomShareControl,
  planRoomShareRequest,
} from './roomShareControl';

test('isRoomShareControl 只接受房间共享控制帧，不把聊天消息当控制帧', () => {
  assert.equal(isRoomShareControl(createRoomShareRequest('start')), true);
  assert.equal(isRoomShareControl(createRoomShareState('peer-b')), true);
  assert.equal(isRoomShareControl(createRoomShareLeave()), true);
  assert.equal(
    isRoomShareControl({ id: 'm1', fromPeerId: 'peer-b', ts: 1, text: 'hello' }),
    false,
  );
  assert.equal(isRoomShareControl({ type: 'share-request', action: 'steal' }), false);
  assert.equal(isRoomShareControl(null), false);
});

test('空闲时任意成员都能开始共享', () => {
  const plan = planRoomShareRequest({
    action: 'start',
    fromPeerId: 'peer-b',
    currentActiveSharerId: null,
    localPeerId: 'peer-a',
    localIsSharing: false,
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.nextActiveSharerId, 'peer-b');
  assert.equal(plan.stopLocalShare, false);
});

test('start 遇到别人占用时拒绝，绝不静默抢占', () => {
  const plan = planRoomShareRequest({
    action: 'start',
    fromPeerId: 'peer-b',
    currentActiveSharerId: 'peer-a',
    localPeerId: 'peer-a',
    localIsSharing: true,
  });
  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, 'occupied');
  assert.equal(plan.nextActiveSharerId, 'peer-a');
});

test('takeover 让本地正在共享的房主先停采集，再切给发起者', () => {
  const plan = planRoomShareRequest({
    action: 'takeover',
    fromPeerId: 'peer-b',
    currentActiveSharerId: 'peer-a',
    localPeerId: 'peer-a',
    localIsSharing: true,
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.nextActiveSharerId, 'peer-b');
  assert.equal(plan.stopLocalShare, true);
});

test('takeover 替换远端 sharer 时只摘旧画面，不动本地采集', () => {
  const plan = planRoomShareRequest({
    action: 'takeover',
    fromPeerId: 'peer-c',
    currentActiveSharerId: 'peer-b',
    localPeerId: 'peer-a',
    localIsSharing: false,
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.nextActiveSharerId, 'peer-c');
  assert.equal(plan.stopLocalShare, false);
  assert.equal(plan.stopWatchingRemote, true);
});

test('stop 只接受当前 sharer，过期请求不会停掉新共享', () => {
  const stale = planRoomShareRequest({
    action: 'stop',
    fromPeerId: 'peer-a',
    currentActiveSharerId: 'peer-b',
    localPeerId: 'peer-a',
    localIsSharing: false,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale-stop');
  assert.equal(stale.nextActiveSharerId, 'peer-b');

  const current = planRoomShareRequest({
    action: 'stop',
    fromPeerId: 'peer-b',
    currentActiveSharerId: 'peer-b',
    localPeerId: 'peer-a',
    localIsSharing: false,
  });
  assert.equal(current.accepted, true);
  assert.equal(current.nextActiveSharerId, null);
});
test('离房控制帧可被识别，房主只按真实连接来源清理 ShareSlot', () => {
  assert.deepEqual(createRoomShareLeave(), { type: 'share-leave' });
  assert.equal(isRoomShareControl({ type: 'share-leave' }), true);
});

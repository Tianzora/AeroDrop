import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODE_ORDER,
  resolveSwipeTarget,
  SWIPE_TUNING,
  SwipeTracker,
  type SwipeStartInput,
} from './swipeNavigation.ts';

const VIEWPORT = 390;

function start(overrides: Partial<SwipeStartInput> = {}): SwipeStartInput {
  return {
    pointerType: 'touch',
    clientX: 200,
    clientY: 400,
    timeStamp: 0,
    viewportWidth: VIEWPORT,
    ...overrides,
  };
}

test('mouse 拖拽不进入滑动判定', () => {
  const tracker = new SwipeTracker();
  assert.equal(tracker.begin(start({ pointerType: 'mouse' })), false);
  assert.equal(tracker.isTracking, false);
});

test('屏幕左右边缘死区留给系统返回手势', () => {
  const tracker = new SwipeTracker();
  assert.equal(tracker.begin(start({ clientX: SWIPE_TUNING.edgeDeadZonePx })), false);
  assert.equal(tracker.begin(start({ clientX: VIEWPORT - SWIPE_TUNING.edgeDeadZonePx })), false);
  assert.equal(tracker.begin(start({ clientX: SWIPE_TUNING.edgeDeadZonePx + 1 })), true);
});

test('纵向为主的拖动判成滚动，不翻页', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start());
  tracker.move(204, 520);
  assert.equal(tracker.end(204, 600), null);
});

test('斜 45° 的拖动不算横向滑动', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start());
  tracker.move(260, 460);
  assert.equal(tracker.end(260, 600), null);
});

test('小位移慢速滑动不翻页', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start());
  tracker.move(160, 402);
  assert.equal(tracker.end(160, 900), null);
});

test('走够屏宽 18% 的慢速滑动翻到下一页', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start());
  tracker.move(212, 402);
  tracker.move(120, 404);
  assert.equal(tracker.end(120, 900), 'next');
});

test('向右推回上一页', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start({ clientX: 150 }));
  tracker.move(200, 402);
  tracker.move(280, 404);
  assert.equal(tracker.end(280, 900), 'prev');
});

test('快速甩动 40px 也能翻页', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start({ timeStamp: 1000 }));
  tracker.move(180, 402);
  assert.equal(tracker.end(160, 1050), 'next');
});

test('方向锁定后不会回退成滚动，但位移不够仍然不翻页', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start());
  tracker.move(240, 402);
  tracker.move(238, 470);
  assert.equal(tracker.end(238, 900), null);
});

test('cancel 之后不再结算上一次手势', () => {
  const tracker = new SwipeTracker();
  tracker.begin(start());
  tracker.move(120, 402);
  tracker.cancel();
  assert.equal(tracker.end(60, 200), null);
});

test('首尾标签不会回环', () => {
  assert.deepEqual([...MODE_ORDER], ['send', 'receive', 'screen']);
  assert.equal(resolveSwipeTarget('send', 'prev'), null);
  assert.equal(resolveSwipeTarget('send', 'next'), 'receive');
  assert.equal(resolveSwipeTarget('receive', 'next'), 'screen');
  assert.equal(resolveSwipeTarget('screen', 'next'), null);
  assert.equal(resolveSwipeTarget('screen', 'prev'), 'receive');
});

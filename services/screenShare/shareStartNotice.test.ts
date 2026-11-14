import test from 'node:test';
import assert from 'node:assert/strict';

import { createShareStartNotice } from './shareStartNotice.ts';

test('没有待发提示时 takeOnReady 返回 null（可安全重复调用）', () => {
  const notice = createShareStartNotice();
  assert.equal(notice.takeOnReady(), null);
  assert.equal(notice.takeOnReady(), null);
});

test('排队后只在第一次 ready 时产出「屏幕共享已开始」，恢复连接不再重复提示', () => {
  // 反证点：把 pending 清空那行删掉，第二次 takeOnReady 会再弹一次「已开始」，
  // 'signaling:restored' 就会被说成一次新的开始。
  const notice = createShareStartNotice();
  notice.queue('（含系统声音）');
  assert.equal(notice.takeOnReady(), '屏幕共享已开始（含系统声音）');
  assert.equal(notice.takeOnReady(), null);
});

test('分享结束/失败时 clear 丢弃待发提示，避免下一轮冒出来', () => {
  const notice = createShareStartNotice();
  notice.queue('');
  notice.clear();
  assert.equal(notice.takeOnReady(), null);
});

test('重新排队会覆盖上一轮没发出去的提示', () => {
  const notice = createShareStartNotice();
  notice.queue('（含系统声音）');
  notice.queue('');
  assert.equal(notice.takeOnReady(), '屏幕共享已开始');
});

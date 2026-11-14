import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorBoundary } from '../components/ErrorBoundary';
import { PWAInstallPrompt } from '../components/PWAInstallPrompt';

// 覆盖率分母守卫只认「报告里出现的文件」，而报告只包含被加载过的模块。
// 这两个组件在 Node 里本来就能加载，却没有任何组件测试 import 它们，于是长期
// 躲在整个分母之外。这条冒烟测试的唯一职责就是把它们拉进分母，并顺手守住
// 「模块顶层不能开始读 window/document」这条隐形契约（一旦破，这里立刻红）。
test('DOM-agnostic components stay importable outside the browser', () => {
  assert.equal(typeof ErrorBoundary, 'function');
  assert.equal(typeof PWAInstallPrompt, 'function');
});

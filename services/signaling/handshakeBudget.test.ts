import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SIGNALING_HANDSHAKE_LOOKUPS_PER_WINDOW,
  SIGNALING_HANDSHAKE_WINDOW_MS,
  createSignalingHandshakeBudget,
  getSignalingHandshakeRetryAfterSeconds,
} from './handshakeBudget.ts';

test('握手预算：窗口内允许到上限，超出后拒绝并给出重试秒数', () => {
  const budget = createSignalingHandshakeBudget({ maxLookupsPerWindow: 3, windowMs: 1000 });
  const now = 1_000;

  assert.equal(budget.consume('ip:1.2.3.4', now).allowed, true);
  assert.equal(budget.consume('ip:1.2.3.4', now).allowed, true);
  assert.equal(budget.consume('ip:1.2.3.4', now).allowed, true);

  const denied = budget.consume('ip:1.2.3.4', now);
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000);
    assert.ok(getSignalingHandshakeRetryAfterSeconds(denied.retryAfterMs) >= 1);
  }

  // 换一个客户端不受影响：预算按出口 IP 计，不按 isolate 合计。
  assert.equal(budget.consume('ip:5.6.7.8', now).allowed, true);
});

test('握手预算：窗口过去后重新放行', () => {
  const budget = createSignalingHandshakeBudget({ maxLookupsPerWindow: 1, windowMs: 1000 });
  assert.equal(budget.consume('ip:1.2.3.4', 0).allowed, true);
  assert.equal(budget.consume('ip:1.2.3.4', 500).allowed, false);
  assert.equal(budget.consume('ip:1.2.3.4', 1000).allowed, true);
});

test('默认预算能覆盖一次页面打开的多连接重连，但挡不住循环握手', () => {
  const budget = createSignalingHandshakeBudget();
  const now = 10_000;
  let allowed = 0;
  for (let attempt = 0; attempt < MAX_SIGNALING_HANDSHAKE_LOOKUPS_PER_WINDOW; attempt += 1) {
    if (budget.consume('ip:1.2.3.4', now).allowed) allowed += 1;
  }
  assert.equal(allowed, MAX_SIGNALING_HANDSHAKE_LOOKUPS_PER_WINDOW);
  assert.equal(budget.consume('ip:1.2.3.4', now).allowed, false);
  // 一个窗口之后必须恢复，否则正常用户会被永久挡在门外。
  assert.equal(budget.consume('ip:1.2.3.4', now + SIGNALING_HANDSHAKE_WINDOW_MS).allowed, true);
});

test('跟踪表有上限，不会因为伪造大量来源 IP 无限增长', () => {
  const budget = createSignalingHandshakeBudget({ maxTrackedClients: 4, windowMs: 1000 });
  for (let index = 0; index < 50; index += 1) {
    budget.consume(`ip:10.0.0.${index}`, 1000 + index);
  }
  assert.ok(budget.getTrackedClientCount() <= 8, `tracked=${budget.getTrackedClientCount()}`);
});

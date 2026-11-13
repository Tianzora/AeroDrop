import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBooleanFlag,
  parseNullableNumber,
  parsePositiveInt,
  resolveSignalingClientKey,
} from './requestContext.ts';

test('derives the client key only from the Cloudflare-injected header', () => {
  const withCf = new Headers({ 'CF-Connecting-IP': '203.0.113.7' });
  assert.equal(resolveSignalingClientKey(withCf), 'ip:203.0.113.7');

  const trimmed = new Headers({ 'CF-Connecting-IP': '  203.0.113.7  ' });
  assert.equal(resolveSignalingClientKey(trimmed), 'ip:203.0.113.7');
});

test('ignores spoofable forwarding headers when the CF header is absent', () => {
  // 非 CF 环境下 XFF 完全由调用方控制：回退到它等于允许「换 IP 绕过限流」。
  const spoofed = new Headers({
    'X-Forwarded-For': '198.51.100.9, 10.0.0.1',
    'X-Real-IP': '198.51.100.9',
    Forwarded: 'for=198.51.100.9',
  });
  assert.equal(resolveSignalingClientKey(spoofed), 'ip:unknown');
  assert.equal(resolveSignalingClientKey(new Headers()), 'ip:unknown');

  const emptyCf = new Headers({ 'CF-Connecting-IP': '   ' });
  assert.equal(resolveSignalingClientKey(emptyCf), 'ip:unknown');
});

test('parses positive integer env values with fallback', () => {
  assert.equal(parsePositiveInt('12', 3), 12);
  assert.equal(parsePositiveInt('1', 3), 1);
  assert.equal(parsePositiveInt(undefined, 3), 3);
  assert.equal(parsePositiveInt('', 3), 3);
  assert.equal(parsePositiveInt('abc', 3), 3);
  assert.equal(parsePositiveInt('0', 3), 3);
  assert.equal(parsePositiveInt('-5', 3), 3);
  // parseInt 会截断小数；这里保持与旧实现一致的宽松语义。
  assert.equal(parsePositiveInt('7.9', 3), 7);
});

test('parses boolean flags and non-negative numbers leniently', () => {
  assert.equal(parseBooleanFlag('1'), true);
  assert.equal(parseBooleanFlag('true'), true);
  assert.equal(parseBooleanFlag('0'), false);
  assert.equal(parseBooleanFlag('yes'), false);

  assert.equal(parseNullableNumber('42'), 42);
  assert.equal(parseNullableNumber('0'), 0);
  assert.equal(parseNullableNumber('-1'), null);
  assert.equal(parseNullableNumber('nope'), null);
  assert.equal(parseNullableNumber(null), null);
});

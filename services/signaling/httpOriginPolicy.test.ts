// 同源门的行为快照。这些断言不是「设计意图」，而是 src/worker.ts 入口当前的真实判定：
// 入口层的 403 全部由它产生，写反时下面的用例必须红。
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedSameOriginRequest } from './httpOriginPolicy.ts';

const ORIGIN = 'https://drop.example';

const request = (headers: Record<string, string> = {}, init: { method?: string; url?: string } = {}): Request =>
  new Request(init.url ?? `${ORIGIN}/ws-signaling?peerId=PEER-00000001`, {
    method: init.method ?? 'GET',
    headers,
  });

test('同源：Origin 与请求 URL 的 origin 相等', () => {
  assert.equal(isAllowedSameOriginRequest(request({ Origin: ORIGIN })), true);
});

test('缺 Origin 且无 Referer / Sec-Fetch-Site：拒绝', () => {
  assert.equal(isAllowedSameOriginRequest(request()), false);
});

test('Origin 不匹配：拒绝', () => {
  assert.equal(isAllowedSameOriginRequest(request({ Origin: 'https://evil.example' })), false);
  // 端口不同也是不同 origin。
  assert.equal(isAllowedSameOriginRequest(request({ Origin: 'https://drop.example:8443' })), false);
});

test('Origin: null（沙箱 iframe / opaque origin）不当作同源', () => {
  assert.equal(isAllowedSameOriginRequest(request({ Origin: 'null' })), false);
});

test('OPTIONS 预检与其它方法同一套判定：只看 Origin，没有方法豁免', () => {
  assert.equal(isAllowedSameOriginRequest(request({ Origin: ORIGIN }, { method: 'OPTIONS' })), true);
  assert.equal(isAllowedSameOriginRequest(request({ Origin: 'https://evil.example' }, { method: 'OPTIONS' })), false);
  // 不带 Origin 的预检同样被拒（没有可用的同源证据）。
  assert.equal(isAllowedSameOriginRequest(request({}, { method: 'OPTIONS' })), false);
});

test('无 Origin 时用 Referer 的 origin 兜底', () => {
  assert.equal(isAllowedSameOriginRequest(request({ Referer: `${ORIGIN}/share?code=123456` })), true);
  assert.equal(isAllowedSameOriginRequest(request({ Referer: 'https://evil.example/page' })), false);
  // 非法 Referer 不能让判定崩掉，也不能放行。
  assert.equal(isAllowedSameOriginRequest(request({ Referer: 'not-a-url' })), false);
});

test('Origin 命中即放行，不会被跨站 Referer 否决（Origin 优先）', () => {
  assert.equal(
    isAllowedSameOriginRequest(request({ Origin: ORIGIN, Referer: 'https://evil.example/page' })),
    true
  );
});

test('既无 Origin 也无可用 Referer 时，只信 Sec-Fetch-Site 的 same-origin / same-site', () => {
  assert.equal(isAllowedSameOriginRequest(request({ 'Sec-Fetch-Site': 'same-origin' })), true);
  assert.equal(isAllowedSameOriginRequest(request({ 'Sec-Fetch-Site': 'same-site' })), true);
  assert.equal(isAllowedSameOriginRequest(request({ 'Sec-Fetch-Site': 'cross-site' })), false);
  assert.equal(isAllowedSameOriginRequest(request({ 'Sec-Fetch-Site': 'none' })), false);
});

test('有跨站 Referer 时 Sec-Fetch-Site 不能翻案', () => {
  assert.equal(
    isAllowedSameOriginRequest(
      request({ Referer: 'https://evil.example/page', 'Sec-Fetch-Site': 'same-origin' })
    ),
    false
  );
});

test('判定基准是请求自身 URL 的 origin，不是硬编码域名', () => {
  assert.equal(
    isAllowedSameOriginRequest(request({ Origin: 'http://127.0.0.1:8787' }, { url: 'http://127.0.0.1:8787/api/share-code' })),
    true
  );
  assert.equal(
    isAllowedSameOriginRequest(request({ Origin: 'http://127.0.0.1:8788' }, { url: 'http://127.0.0.1:8787/api/share-code' })),
    false
  );
});

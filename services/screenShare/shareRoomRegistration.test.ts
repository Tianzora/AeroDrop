import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createScreenSharePeerId,
  describeScreenShareRoomFailure,
  formatScreenSharePeerId,
  registerScreenShareRoom,
} from './shareRoomRegistration.ts';

const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

test('房号由服务端可接受的随机 peerId 派生，不再是 6 位可枚举短码', () => {
  const peerId = createScreenSharePeerId();
  assert.match(peerId, PEER_ID_PATTERN);
  assert.ok(peerId.startsWith('AERO-'));
  // 旧格式是 AERO- + 6 位；新格式熵更高。
  assert.equal(peerId.length, 'AERO-'.length + 18);
  assert.notEqual(createScreenSharePeerId(), peerId);
});

test('格式化是确定性的：同一份熵总是同一个 id，不同熵不同 id', () => {
  const entropy = new Uint8Array([0, 1, 15, 16, 255, 128, 7, 9, 10]);
  assert.equal(formatScreenSharePeerId(entropy), 'AERO-00010f10ff8007090a');
  assert.equal(formatScreenSharePeerId(entropy), formatScreenSharePeerId(entropy));
  assert.notEqual(
    formatScreenSharePeerId(entropy),
    formatScreenSharePeerId(new Uint8Array([0, 1, 15, 16, 255, 128, 7, 9, 11])),
  );
});

test('登记失败文案区分占用/限流/网络，不直出状态码', () => {
  assert.equal(describeScreenShareRoomFailure('taken'), '共享房间号已被占用，请重新开始共享');
  assert.equal(describeScreenShareRoomFailure('rate-limited'), '创建共享房间过于频繁，请稍后再试');
  assert.equal(describeScreenShareRoomFailure('failed'), '共享房间登记失败，请检查网络后重试');
  assert.equal(describeScreenShareRoomFailure('whatever'), '共享房间登记失败，请检查网络后重试');
});

test('Node 环境下没有浏览器 fetch 覆盖点：登记失败也必须落在 failed 状态而不是抛异常', async () => {
  // 这里的目的是保证「登记失败」是可判定的返回值（调用方据此进终态），不是 reject。
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response('nope', { status: 503 });
  }) as typeof fetch;
  try {
    const result = await registerScreenShareRoom({ peerId: 'AERO-0123456789abcdef01' });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.message, '共享房间登记失败，请检查网络后重试');
    }
    assert.deepEqual(calls, ['/api/share-code']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

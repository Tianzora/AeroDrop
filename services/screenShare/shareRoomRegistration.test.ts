import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createScreenSharePeerId,
  describeScreenShareRoomFailure,
  formatScreenSharePeerId,
  isTerminalScreenShareRoomFailure,
  registerScreenShareRoom,
  revokeScreenShareRoomBeacon,
} from './shareRoomRegistration.ts';

import { CONNECTION_TIMINGS } from '../../constants/transfer.ts';

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
      assert.equal(result.reason, 'failed');
    }
    assert.deepEqual(calls, ['/api/share-code']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const withFetch = async (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(input, init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('登记失败把服务端原因带出来：占用/限流/网络不能都塌成一句「重试」', async () => {
  await withFetch(
    async () => new Response('', { status: 409 }),
    async () => {
      const result = await registerScreenShareRoom({ peerId: 'AERO-0123456789abcdef01' });
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') {
        assert.equal(result.reason, 'taken');
        assert.equal(result.message, '共享房间号已被占用，请重新开始共享');
      }
    },
  );

  await withFetch(
    async () =>
      new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
    async () => {
      const result = await registerScreenShareRoom({ peerId: 'AERO-0123456789abcdef02' });
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') {
        assert.equal(result.reason, 'rate-limited');
        assert.equal(result.message, '创建共享房间过于频繁，请稍后再试');
        assert.equal(result.retryAfterMs, 7_000);
      }
    },
  );
});

test('只有限流是终态：占用/网络还有自愈空间，不该立刻杀掉整个分享', () => {
  assert.equal(isTerminalScreenShareRoomFailure('rate-limited'), true);
  assert.equal(isTerminalScreenShareRoomFailure('taken'), false);
  assert.equal(isTerminalScreenShareRoomFailure('failed'), false);
});

test('页面卸载时的撤销用 keepalive 抢发：普通 fetch 会被文档销毁直接取消', async () => {
  const room = {
    peerId: 'AERO-0123456789abcdef03',
    code: '123456',
    secret: 'secret-value',
    secretHash: 'hash-value',
    expiresAt: Date.now() + 60_000,
  };

  await withFetch(
    async () => new Response('{}', { status: 200 }),
    async (calls) => {
      assert.equal(revokeScreenShareRoomBeacon(room), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/api/share-code/123456/revoke');
      assert.equal(calls[0].init?.method, 'POST');
      assert.equal(calls[0].init?.keepalive, true);
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
        peerId: room.peerId,
        secretHash: room.secretHash,
      });
    },
  );

  await withFetch(
    async () => new Response('{}', { status: 200 }),
    async (calls) => {
      assert.equal(revokeScreenShareRoomBeacon(null), false);
      assert.equal(calls.length, 0, '没有房号时不该发出空撤销');
    },
  );
});

test('登记超时被单独报出来：服务端 8s 不响应要落成可操作终态，不是一次普通网络失败', async () => {
  // 真挂住的 fetch：只有 AbortSignal 才能让它结束。以前没有超时，initializePeer 会永远停在
  // await 上，单飞闸门不释放，界面永久停在「正在连接服务器」——这条用例守住那条回归。
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), '/api/share-code');
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        aborted = true;
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (init?.signal?.aborted) {
        fail();
        return;
      }
      init?.signal?.addEventListener('abort', fail, { once: true });
    });
  }) as typeof fetch;
  try {
    const started = Date.now();
    const result = await registerScreenShareRoom({ peerId: 'AERO-0123456789abcdef01' });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.reason, 'timeout');
      assert.equal(result.message, '共享服务长时间无响应，请检查网络后重新开始共享');
    }
    assert.equal(aborted, true);
    assert.ok(Date.now() - started >= CONNECTION_TIMINGS.SHARE_CODE_REGISTER_TIMEOUT_MS - 200);
    // 超时不是终态：还能换链路重试；但它必须和「网络抖动」区分开，否则界面会无限重排。
    assert.equal(isTerminalScreenShareRoomFailure('timeout'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

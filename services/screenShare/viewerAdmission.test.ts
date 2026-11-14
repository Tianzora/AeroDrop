import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canAdmitViewer,
  deliverShareFull,
  planViewerAdmission,
  type ShareFullConnection,
  type ShareFullMessage,
} from './viewerAdmission.ts';

// 空场可以接纳
assert.equal(canAdmitViewer({ activeViewers: 0, pendingViewers: 0, maxViewers: 6 }), true);
// 已有 5 人 + 1 人正在 answer → 名额已满，不能再接纳（并发超员的根因）
assert.equal(canAdmitViewer({ activeViewers: 5, pendingViewers: 1, maxViewers: 6 }), false);
// 只有 pending 也算占用名额
assert.equal(canAdmitViewer({ activeViewers: 0, pendingViewers: 6, maxViewers: 6 }), false);
// 未达上限仍可接纳
assert.equal(canAdmitViewer({ activeViewers: 3, pendingViewers: 2, maxViewers: 6 }), true);
// 异常输入按 0 处理，不能因为 NaN 把名额算成可用或永久占满
assert.equal(canAdmitViewer({ activeViewers: Number.NaN, pendingViewers: 0, maxViewers: 6 }), true);
assert.equal(canAdmitViewer({ activeViewers: -3, pendingViewers: 0, maxViewers: 6 }), true);

const FULL = { activeViewers: 6, pendingViewers: 0, maxViewers: 6 };

type FakeConnection = ShareFullConnection & {
  sent: ShareFullMessage[];
  closed: boolean;
  fireOpen: () => void;
  fireError: () => void;
};

const createFakeConnection = (open: boolean): FakeConnection => {
  const listeners: Record<'open' | 'error', Array<() => void>> = { open: [], error: [] };
  const connection: FakeConnection = {
    open,
    sent: [],
    closed: false,
    send(message) {
      if (!connection.open) throw new Error('Connection is not open');
      connection.sent.push(message);
    },
    on(event, listener) {
      listeners[event].push(listener);
    },
    close() {
      connection.closed = true;
    },
    fireOpen() {
      connection.open = true;
      listeners.open.forEach((listener) => listener());
    },
    fireError() {
      listeners.error.forEach((listener) => listener());
    },
  };
  return connection;
};

test('未满时接纳并占一个 pending 名额：answer 的 round-trip 里人数也要算进去', () => {
  const plan = planViewerAdmission({
    activeViewers: 5,
    pendingViewers: 0,
    maxViewers: 6,
    tracked: false,
    dataChannel: 'absent',
  });

  assert.deepEqual(plan, { kind: 'admit', reserveSeat: true });
});

test('已经在 pending/active 里的 peer 再来一条 call：不再额外占名额', () => {
  const plan = planViewerAdmission({
    ...FULL,
    tracked: true,
    dataChannel: 'open',
  });

  assert.deepEqual(plan, { kind: 'admit', reserveSeat: false });
});

test('满员且数据连接已登记：走这条已 open 的连接告知 share-full', () => {
  const plan = planViewerAdmission({ ...FULL, tracked: false, dataChannel: 'open' });
  assert.deepEqual(plan, { kind: 'reject-share-full', delivery: 'open-connection' });
  if (plan.kind !== 'reject-share-full') return;

  const connection = createFakeConnection(true);
  const delivered = deliverShareFull(plan.delivery, { connection, connect: null, peerId: 'viewer-1' });

  assert.equal(delivered, true);
  assert.deepEqual(connection.sent, [{ type: 'share-full' }]);
});

test('数据连接还在建立：等它 open 再发，不能直接 send 抛错', () => {
  const plan = planViewerAdmission({ ...FULL, tracked: false, dataChannel: 'pending' });
  assert.deepEqual(plan, { kind: 'reject-share-full', delivery: 'pending-connection' });
  if (plan.kind !== 'reject-share-full') return;

  const connection = createFakeConnection(false);
  const delivered = deliverShareFull(plan.delivery, { connection, connect: null, peerId: 'viewer-1' });

  assert.equal(delivered, true);
  assert.deepEqual(connection.sent, []);
  connection.fireOpen();
  assert.deepEqual(connection.sent, [{ type: 'share-full' }]);
});

test('数据连接还没登记：用 peer 反向建连告知，否则观众只会等到「连接超时」', () => {
  const plan = planViewerAdmission({ ...FULL, tracked: false, dataChannel: 'absent' });
  assert.deepEqual(plan, { kind: 'reject-share-full', delivery: 'new-connection' });
  if (plan.kind !== 'reject-share-full') return;

  const requested: string[] = [];
  const reverse = createFakeConnection(false);
  let closedAfterSend = false;
  const delivered = deliverShareFull(plan.delivery, {
    connection: null,
    connect: (peerId) => {
      requested.push(peerId);
      return reverse;
    },
    peerId: 'viewer-7',
  });

  assert.equal(delivered, true);
  assert.deepEqual(requested, ['viewer-7']);
  assert.deepEqual(reverse.sent, []);
  reverse.fireOpen();
  assert.deepEqual(reverse.sent, [{ type: 'share-full' }]);
  closedAfterSend = reverse.closed;
  assert.equal(closedAfterSend, true, '反向连接只为一句话，发完就该关掉');
});

test('反向建连失败/拿不到 peer 时不影响分享：返回 false 而不是抛错', () => {
  const noPeer = deliverShareFull('new-connection', { connection: null, connect: null, peerId: 'viewer-8' });
  assert.equal(noPeer, false);

  const throwing = deliverShareFull('new-connection', {
    connection: null,
    connect: () => { throw new Error('peer destroyed'); },
    peerId: 'viewer-8',
  });
  assert.equal(throwing, false);

  const errorPath = createFakeConnection(false);
  assert.doesNotThrow(() => deliverShareFull('new-connection', {
    connection: null,
    connect: () => errorPath,
    peerId: 'viewer-9',
  }));
  errorPath.fireError();
  assert.deepEqual(errorPath.sent, []);
  assert.equal(errorPath.closed, true);
});

test('连接已关闭时不会假装发出去了：调用方据此决定要不要再走反向连接', () => {
  const connection = createFakeConnection(false);
  const delivered = deliverShareFull('open-connection', { connection, connect: null, peerId: 'viewer-1' });

  assert.equal(delivered, false);
  assert.deepEqual(connection.sent, []);
});

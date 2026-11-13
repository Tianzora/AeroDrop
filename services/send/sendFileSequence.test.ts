import test from 'node:test';
import assert from 'node:assert/strict';
import type { DataConnection } from '../peerRuntime';
import { ReceiveCreditTimeoutError } from './receiveCredit';
import {
  runSendFileSequence,
  type SendFileSequenceDeps,
  type SendSequenceState,
} from './sendFileSequence';

type ControlMessage = { type: string; payload?: Record<string, unknown> };

type SentRecord = { kind: 'control'; message: ControlMessage } | { kind: 'chunk'; byteLength: number };

type FakeConn = {
  peer: string;
  open: boolean;
  closed: number;
  sent: SentRecord[];
  /** 每次真正尝试写入的二进制尺寸，包含被拒收的那一次。 */
  attempts: number[];
  send: (message: unknown) => void;
  close: () => void;
  peerConnection: {
    connectionState: string;
    sctp: { maxMessageSize: number } | undefined;
  };
};

const PEER_ID = 'peer-1';

const createConn = (options: { failBinaryOnce?: boolean } = {}): FakeConn => {
  let binarySends = 0;
  const conn: FakeConn = {
    peer: PEER_ID,
    open: true,
    closed: 0,
    sent: [],
    attempts: [],
    peerConnection: { connectionState: 'connected', sctp: { maxMessageSize: 65536 } },
    send(message: unknown) {
      if (typeof message === 'object' && message !== null && 'type' in message) {
        conn.sent.push({ kind: 'control', message: message as ControlMessage });
        return;
      }
      binarySends += 1;
      conn.attempts.push((message as Uint8Array).byteLength);
      if (options.failBinaryOnce && binarySends === 1) {
        // 复现“协商上限被报高、真实 SCTP 拒收”的一次性失败。
        throw new TypeError('message too large for data channel');
      }
      conn.sent.push({ kind: 'chunk', byteLength: (message as Uint8Array).byteLength });
    },
    close() {
      conn.open = false;
      conn.closed += 1;
    },
  };
  return conn;
};

const createState = (): SendSequenceState => ({
  peerTransferEpoch: new Map([[PEER_ID, 0]]),
  activeSendingPeers: new Set(),
  activeSendConn: new Map(),
  pendingSendPeers: new Set(),
  activeConnections: new Set(),
  peerAdaptiveFlow: new Map(),
  peerNegotiatedChunkCap: new Map(),
  peerReceiveCredit: new Map(),
  peerHasProgressSync: new Set(),
  peerSyncStartAt: new Map(),
  peerSyncBaseBytes: new Map(),
  peerProgress: new Map(),
  peerRealtimeSpeed: new Map(),
  peerAverageSpeed: new Map(),
  peerTransferredBytes: new Map(),
  peerTotalBytes: new Map(),
  peerAwaitingFinalizeAck: new Set(),
});

type FakeCreditGate = {
  sentOverallBytes: number;
  recordSent: (byteCount: number) => void;
  snapshot: () => { sentOverallBytes: number };
  waitForAvailable: () => Promise<number>;
  cancel: (reason: string | Error) => void;
  waitCalls: number;
};

const createCreditGate = (
  overrides: {
    waitForAvailable?: (gate: FakeCreditGate) => Promise<number>;
  } = {},
): FakeCreditGate => {
  const gate: FakeCreditGate = {
    sentOverallBytes: 0,
    waitCalls: 0,
    recordSent(byteCount: number) {
      gate.sentOverallBytes += byteCount;
    },
    snapshot() {
      return { sentOverallBytes: gate.sentOverallBytes };
    },
    async waitForAvailable() {
      gate.waitCalls += 1;
      if (overrides.waitForAvailable) return overrides.waitForAvailable(gate);
      return 1024 * 1024;
    },
    cancel() {},
  };
  return gate;
};

const makeFile = (bytes: number, name = 'payload.bin'): File => {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) data[i] = i % 251;
  return new File([data], name);
};

type Harness = {
  conn: FakeConn;
  state: SendSequenceState;
  notifications: Array<{ message: string; type: string }>;
  transfers: { started: number; finished: number };
  deps: SendFileSequenceDeps;
  sessionId: { current: number };
};

const createHarness = (options: {
  files: File[];
  startFileIndex?: number;
  startByteOffset?: number;
  failBinaryOnce?: boolean;
  creditGate?: FakeCreditGate;
}): Harness => {
  const conn = createConn({ failBinaryOnce: options.failBinaryOnce });
  const state = createState();
  const creditGate = options.creditGate ?? createCreditGate();
  state.peerReceiveCredit.set(PEER_ID, creditGate as never);
  state.activeConnections.add(conn as unknown as DataConnection);

  const notifications: Array<{ message: string; type: string }> = [];
  const transfers = { started: 0, finished: 0 };
  const sessionId = { current: 7 };

  const deps: SendFileSequenceDeps = {
    conn: conn as unknown as DataConnection,
    files: options.files,
    startFileIndex: options.startFileIndex,
    startByteOffset: options.startByteOffset,
    peerEpoch: 0,
    sessionId: sessionId.current,
    getSessionId: () => sessionId.current,
    state,
    decodeFileName: (name: string) => name,
    notify: (message: string, type: 'success' | 'info' | 'error') => {
      notifications.push({ message, type });
    },
    refreshConnectionStats: () => {},
    setCurrentFileIndex: () => {},
    getTelemetry: () => null,
    getPeerName: () => '接收端',
    incrementActiveTransfers: () => {
      transfers.started += 1;
    },
    decrementActiveTransfers: () => {
      transfers.finished += 1;
    },
  };

  return { conn, state, notifications, transfers, deps, sessionId };
};

const chunkBytes = (conn: FakeConn): number =>
  conn.sent.reduce((total, record) => total + (record.kind === 'chunk' ? record.byteLength : 0), 0);

const controlTypes = (conn: FakeConn): string[] =>
  conn.sent.flatMap((record) => (record.kind === 'control' ? [record.message.type] : []));

test('runSendFileSequence sends a whole file and completes the sequence', async () => {
  const file = makeFile(200_000);
  const harness = createHarness({ files: [file] });

  await runSendFileSequence(harness.deps);

  assert.equal(chunkBytes(harness.conn), file.size);
  assert.deepEqual(controlTypes(harness.conn), ['FILE_START', 'FILE_COMPLETE', 'ALL_FILES_COMPLETE']);
  const complete = harness.conn.sent.find(
    (record) => record.kind === 'control' && record.message.type === 'FILE_COMPLETE',
  );
  assert.ok(complete && complete.kind === 'control');
  assert.equal((complete.message.payload as { hashedBytes: number }).hashedBytes, file.size);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.transfers.started, 1);
  assert.equal(harness.transfers.finished, 0);
  assert.equal(harness.state.activeSendingPeers.has(PEER_ID), false);
  assert.equal(harness.state.activeSendConn.has(PEER_ID), false);
  assert.equal(harness.state.peerAwaitingFinalizeAck.has(PEER_ID), true);
  assert.equal(harness.state.peerProgress.get(PEER_ID), 99);
});

test('runSendFileSequence retries with a smaller chunk when a message is rejected as too large', async () => {
  const file = makeFile(120_000);
  const harness = createHarness({ files: [file], failBinaryOnce: true });

  await runSendFileSequence(harness.deps);

  // 被拒的那一片必须从同一偏移换小片重发：总字节数仍然等于文件大小（不重不漏）。
  assert.equal(chunkBytes(harness.conn), file.size);
  const attempts = harness.conn.attempts;
  assert.ok(attempts.length >= 2);
  assert.ok(attempts[1] < attempts[0]);
  // 学到的协商上限要记住，避免后续继续按超限尺寸读。
  const negotiatedCap = harness.state.peerNegotiatedChunkCap.get(PEER_ID);
  assert.ok(negotiatedCap !== undefined && negotiatedCap <= attempts[1]);
  assert.deepEqual(controlTypes(harness.conn), ['FILE_START', 'FILE_COMPLETE', 'ALL_FILES_COMPLETE']);
  assert.equal(harness.notifications.length, 0);
});

test('runSendFileSequence aborts once a newer epoch takes over the peer', async () => {
  const file = makeFile(200_000);
  const harness = createHarness({ files: [file] });
  const originalSend = harness.conn.send;
  harness.conn.send = (message: unknown) => {
    originalSend(message);
    // 第一片发出后立刻有新的重连序列顶替当前 epoch。
    if (!('type' in (message as object))) {
      harness.state.peerTransferEpoch.set(PEER_ID, 1);
    }
  };

  await runSendFileSequence(harness.deps);

  assert.equal(controlTypes(harness.conn).includes('ALL_FILES_COMPLETE'), false);
  assert.equal(controlTypes(harness.conn).includes('FILE_COMPLETE'), false);
  assert.ok(chunkBytes(harness.conn) < file.size);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.conn.closed, 0);
  // 旧序列退出时要归还自己那次计数，否则 UI 会一直显示“正在发送”。
  assert.equal(harness.transfers.finished, 1);
  assert.equal(harness.state.activeSendingPeers.has(PEER_ID), false);
});

test('runSendFileSequence reports a stalled peer and closes the connection on credit timeout', async () => {
  const file = makeFile(64_000);
  const creditGate = createCreditGate({
    waitForAvailable: async () => {
      throw new ReceiveCreditTimeoutError(12_000);
    },
  });
  const harness = createHarness({ files: [file], creditGate });

  await runSendFileSequence(harness.deps);

  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /超过 12 秒没有响应/);
  assert.equal(harness.notifications[0].type, 'error');
  assert.equal(harness.conn.closed, 1);
  assert.equal(harness.transfers.finished, 1);
});

test('runSendFileSequence keeps waiting when the peer is reconnecting instead of failing', async () => {
  const file = makeFile(64_000);
  const harness = createHarness({ files: [file] });
  const creditGate = harness.state.peerReceiveCredit.get(PEER_ID) as unknown as FakeCreditGate;
  let calls = 0;
  creditGate.waitForAvailable = async () => {
    calls += 1;
    if (calls === 1) {
      // ICE restart 期间连接不是 connected：这是可自愈的抖动，不应该报错关连接。
      harness.conn.peerConnection.connectionState = 'disconnected';
      throw new ReceiveCreditTimeoutError(12_000);
    }
    harness.conn.peerConnection.connectionState = 'connected';
    return 1024 * 1024;
  };

  await runSendFileSequence(harness.deps);

  assert.ok(calls >= 2);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.conn.closed, 0);
  assert.equal(chunkBytes(harness.conn), file.size);
});

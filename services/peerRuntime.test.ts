import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONNECTION_TIMINGS } from '../constants/transfer.ts';
import {
  WS_BASE_PROTOCOL,
  decodeWsCredentials,
  parseWsProtocols,
  pickAcceptedProtocol,
} from './signaling/wsCredentialTransport.ts';

import { getSignalingBase } from './peerRuntime.ts';

class FakeDataChannel {
  public static instances: FakeDataChannel[] = [];
  public readyState: 'open' | 'closed' = 'open';
  public binaryType = 'arraybuffer';
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor() {
    FakeDataChannel.instances.push(this);
  }

  send(): void {}

  close(): void {
    if (this.readyState === 'closed') {
      return;
    }
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakeRTCPeerConnection {
  public static instances: FakeRTCPeerConnection[] = [];
  public onicecandidate: ((event: { candidate: null }) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;
  public onicegatheringstatechange: (() => void) | null = null;
  public onsignalingstatechange: (() => void) | null = null;
  public ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public iceGatheringState: RTCIceGatheringState = 'new';
  public signalingState: RTCSignalingState = 'stable';
  public restartIceCalls = 0;
  public createOfferOptions: Array<RTCOfferOptions | undefined> = [];

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(): FakeDataChannel {
    return new FakeDataChannel();
  }

  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.createOfferOptions.push(options);
    return Promise.resolve({ type: 'offer', sdp: 'fake-offer' });
  }

  restartIce(): void {
    this.restartIceCalls += 1;
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public static OPEN = 1;
  public static CONNECTING = 0;
  public static CLOSED = 3;
  public readyState = FakeWebSocket.CONNECTING;
  public sent: string[] = [];
  public onopen: (() => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols: string[] = []
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

/**
 * 假 window 计时器：记录 setTimeout 的延迟与回调，让测试能精确驱动退避/宽限期。
 * 同时替换 WebSocket / RTCPeerConnection 假实现，restore() 负责还原全局对象。
 */
const installFakeTimers = () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;
  const scheduledTimeouts: Array<{ id: number; fn: () => void; delayMs: number }> = [];
  let nextTimerId = 1;

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout: (fn: () => void, delayMs?: number) => {
      const id = nextTimerId++;
      scheduledTimeouts.push({ id, fn, delayMs: delayMs ?? 0 });
      return id;
    },
    clearTimeout: (id: number) => {
      const index = scheduledTimeouts.findIndex((entry) => entry.id === id);
      if (index >= 0) scheduledTimeouts.splice(index, 1);
    },
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

  return {
    scheduledTimeouts,
    restore: () => {
      globalThis.window = originalWindow;
      globalThis.WebSocket = originalWebSocket;
      globalThis.RTCPeerConnection = originalRtcPeerConnection;
    },
  };
};

test('outgoing offers fail fast when signaling closes before registration', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const connection = peer.connect('target-peer');

    const connectionErrors: string[] = [];
    connection.on('error', (error) => {
      connectionErrors.push(error.type);
    });

    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].close(1006, 'closed-before-registration');

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(connectionErrors, ['disconnected']);
    assert.equal(connection.open, false);

    peer.destroy();
  } finally {
    restore();
  }
});

test('pre-registration signaling failures stay handled even without pending offers', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].close(1006, 'closed-before-registration');

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(peerErrors, ['disconnected']);
    assert.deepEqual(unhandledRejections, []);

    peer.destroy();
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    restore();
  }
});

test('data channel errors close the connection so pending transfer waiters can be released', async () => {
  FakeDataChannel.instances.length = 0;
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const connection = peer.connect('target-peer');
    const errors: string[] = [];
    let closeCount = 0;
    connection.on('error', (error) => errors.push(error.type));
    connection.on('close', () => {
      closeCount += 1;
    });

    assert.equal(FakeDataChannel.instances.length, 1);
    FakeDataChannel.instances[0].onerror?.();

    assert.deepEqual(errors, ['webrtc-error']);
    assert.equal(closeCount, 1);
    assert.equal(FakeDataChannel.instances[0].readyState, 'closed');
    assert.equal(connection.open, false);

    peer.destroy();
  } finally {
    restore();
  }
});

test("transport 'disconnected' 先等宽限期，避免把可自愈的抖动当成断链", async () => {
  FakeDataChannel.instances.length = 0;
  FakeWebSocket.instances.length = 0;
  FakeRTCPeerConnection.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  const graceTimers = () =>
    scheduledTimeouts.filter(
      (entry) => entry.delayMs === CONNECTION_TIMINGS.TRANSPORT_DISCONNECTED_GRACE_MS,
    );

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    peer.connect('target-peer');

    const peerConnection = FakeRTCPeerConnection.instances[0];
    assert.ok(peerConnection);

    peerConnection.connectionState = 'disconnected';
    peerConnection.onconnectionstatechange?.();

    assert.equal(peerConnection.connectionState, 'disconnected');
    assert.equal(graceTimers().length, 1);

    peerConnection.connectionState = 'connected';
    peerConnection.onconnectionstatechange?.();
    assert.equal(graceTimers().length, 0);

    peerConnection.connectionState = 'disconnected';
    peerConnection.onconnectionstatechange?.();
    assert.equal(graceTimers().length, 1);

    graceTimers()[0].fn();
    assert.equal(peerConnection.connectionState, 'closed');

    peer.destroy();
  } finally {
    restore();
  }
});

test('服务端用终态 close code 关闭信令时停止重连，并把原因交给上层', async () => {
  FakeWebSocket.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    FakeWebSocket.instances[0].close(4029, 'Too many sessions');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 4029 表示这一层已被服务端拒绝（每 IP 会话数超限），重连不会自愈。
    assert.deepEqual(peerErrors, ['rate-limited']);
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(FakeWebSocket.instances.length, 1);

    peer.destroy();
  } finally {
    restore();
  }
});

test('4010（会话密钥不匹配）是终态：不重连', async () => {
  FakeWebSocket.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    FakeWebSocket.instances[0].close(4010, 'Signaling session conflict');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 4010 是分享端自定义的「这次接管被拒」信号：继续重连只会反复被拒或互踢。
    assert.deepEqual(peerErrors, ['session-conflict']);
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(FakeWebSocket.instances.length, 1);

    peer.destroy();
  } finally {
    restore();
  }
});

test('4011（被新连接顶替）是终态：不重连', async () => {
  FakeWebSocket.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    FakeWebSocket.instances[0].close(4011, 'Peer ID taken over');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(peerErrors, ['unavailable-id']);
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(FakeWebSocket.instances.length, 1);

    peer.destroy();
  } finally {
    restore();
  }
});

test('1008（消息过多）是瞬态拥塞，仍按退避重连', async () => {
  FakeWebSocket.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });

    FakeWebSocket.instances[0].close(1008, 'Too many signaling messages');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reconnectTimers = scheduledTimeouts.filter((entry) => entry.delayMs === 1_000);
    assert.equal(reconnectTimers.length, 1);

    reconnectTimers[0].fn();
    assert.equal(FakeWebSocket.instances.length, 2);

    peer.destroy();
  } finally {
    restore();
  }
});

test('收到终态 error（peerId 被顶替）后主动断开信令且不再重连', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        code: 'unavailable-id',
        message: 'Peer ID taken over by a newer connection',
      }),
    });

    // 主动关闭，避免「已被顶替」的连接继续占着服务端的会话名额。
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.deepEqual(peerErrors, ['unavailable-id']);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // 终态错误不触发重连。
    assert.equal(FakeWebSocket.instances.length, 1);

    peer.destroy();
  } finally {
    restore();
  }
});

test('凭证走子协议而不是 URL：摘要不出现在 query 里，peerId 仍保留', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const sessionSecretHash = 'a'.repeat(64);
    const boundPeer = new WorkerSignaledPeer({ debug: 0, sessionSecretHash });
    const first = FakeWebSocket.instances[0];

    // 凭证进 URL 会随请求行进接入日志/代理日志：泄漏的 proof 足以把原持有者挤成 4010。
    assert.equal(new URL(first.url).searchParams.has('sessionSecretHash'), false);
    assert.equal(new URL(first.url).searchParams.has('token'), false);
    assert.ok(new URL(first.url).searchParams.get('peerId'), 'peerId 不是秘密，仍留在 URL');
    assert.deepEqual(
      decodeWsCredentials(parseWsProtocols(first.protocols.join(', '))),
      { sessionSecretHash }
    );
    assert.equal(pickAcceptedProtocol(first.protocols), WS_BASE_PROTOCOL, '必须带可回显的非秘密协议');
    boundPeer.destroy();

    // 文件传输 / 观众端不传摘要：载荷里不能出现该字段，否则服务端接管判定输入被改写。
    const plainPeer = new WorkerSignaledPeer({ debug: 0 });
    const second = FakeWebSocket.instances[1];
    assert.equal(new URL(second.url).searchParams.has('sessionSecretHash'), false);
    assert.deepEqual(decodeWsCredentials(second.protocols), {});
    plainPeer.destroy();
  } finally {
    restore();
  }
});

test('服务端下发的 sessionProof 轮换后替换静态摘要，并出现在重连的握手头里', async () => {
  FakeWebSocket.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const sessionSecretHash = 'a'.repeat(64);
    const proof = 'b'.repeat(64);
    const peer = new WorkerSignaledPeer({ debug: 0, sessionSecretHash });

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onmessage?.({
      data: JSON.stringify({ type: 'registered', peerId: 'AERO-ABC123', sessionProof: proof }),
    });

    // 正常掉线 → 按退避重连。
    socket.close(1006, 'abnormal close');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnectTimers = scheduledTimeouts.filter((entry) => entry.delayMs === 1_000);
    assert.equal(reconnectTimers.length, 1);
    reconnectTimers[0].fn();
    assert.equal(FakeWebSocket.instances.length, 2);

    const reconnect = FakeWebSocket.instances[1];
    assert.equal(new URL(reconnect.url).searchParams.has('sessionProof'), false);
    // 首次注册之后静态 bearer 不再重复出现：服务端只认 proof。
    assert.deepEqual(decodeWsCredentials(reconnect.protocols), { sessionProof: proof });

    peer.destroy();
  } finally {
    restore();
  }
});

test('session-conflict 是终态：断开且不再重连，recoveryState 标记为 rejected', async () => {
  FakeWebSocket.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0, sessionSecretHash: 'a'.repeat(64) });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        code: 'session-conflict',
        message: 'Session is bound to another connection',
      }),
    });

    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.deepEqual(peerErrors, ['session-conflict']);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // 没有密钥的重连会被服务端反复拒绝；继续退避重连就是「改了但没生效」的互踢现场。
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(peer.signalingRecoveryState(), 'rejected');
    // 自动恢复接口也必须停手，由上层提示用户重新开始共享。
    assert.equal(peer.retrySignaling(), false);
    assert.equal(FakeWebSocket.instances.length, 1);

    peer.destroy();
  } finally {
    restore();
  }
});

test('终态拒绝之后，显式重连会重新获得自动重连能力', async () => {
  FakeWebSocket.instances.length = 0;
  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    peer.on('error', () => {});

    const first = FakeWebSocket.instances[0];
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    first.close(4029, 'Too many sessions');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 终态：自动重连必须停手，否则就是用户看到的「一直重连」。
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(scheduledTimeouts.length, 0);

    // 自动恢复接口不能反复撞终态：额度与标记都该挡住它，由调用方换一条信令会话。
    assert.equal(peer.retrySignaling(), false);
    assert.equal(FakeWebSocket.instances.length, 1);

    // 显式重连（用户重试）要能重新给一次机会，而不是被永久判死。
    peer.reconnect();
    assert.equal(FakeWebSocket.instances.length, 2);

    const second = FakeWebSocket.instances[1];
    second.readyState = FakeWebSocket.OPEN;
    second.onopen?.();
    second.close(1006, 'network dropped');
    assert.equal(scheduledTimeouts.filter((entry) => entry.delayMs === 1_000).length, 1);

    peer.destroy();
  } finally {
    restore();
  }
});

test('信令退避重连达到次数上限后停止重试，并把原因交给上层', async () => {
  FakeWebSocket.instances.length = 0;
  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peerErrors: string[] = [];
    const peer = new WorkerSignaledPeer({ debug: 0 });
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    const maxAttempts = CONNECTION_TIMINGS.MAX_SIGNALING_RECONNECT_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.readyState = FakeWebSocket.OPEN;
      socket.onopen?.();
      socket.close(1006, 'signaling unreachable');

      const timer = scheduledTimeouts[0];
      assert.ok(timer, `第 ${attempt + 1} 次退避应该有重连计时器`);
      scheduledTimeouts.length = 0;
      timer.fn();
    }

    assert.equal(FakeWebSocket.instances.length, maxAttempts + 1);

    // 最后一次仍然失败：不能再起新 socket，也不该无限等下去。
    const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    last.readyState = FakeWebSocket.OPEN;
    last.onopen?.();
    last.close(1006, 'signaling unreachable');

    assert.equal(peerErrors.at(-1), 'disconnected');
    assert.equal(FakeWebSocket.instances.length, maxAttempts + 1);
    assert.equal(scheduledTimeouts.length, 0);

    peer.destroy();
  } finally {
    restore();
  }
});

test("媒体连接的 'disconnected' 也走宽限期，且 close 只上报一次", async () => {
  const { scheduledTimeouts, restore } = installFakeTimers();
  const originalMediaStream = (globalThis as typeof globalThis & { MediaStream?: unknown }).MediaStream;
  (globalThis as typeof globalThis & { MediaStream?: unknown }).MediaStream = class FakeMediaStream {
    getTracks() {
      return [];
    }

    addTrack() {}
  } as unknown as typeof MediaStream;

  try {
    const { MediaConnection } = await import('./peerRuntime.ts');
    const peerConnection = new FakeRTCPeerConnection();
    const provider = {
      logConnectionEvent: () => {},
      removeConnection: () => {},
      forwardIceCandidate: () => {},
      forwardAnswer: () => {},
    } as unknown as ConstructorParameters<typeof MediaConnection>[0];
    const connection = new MediaConnection(
      provider,
      'viewer-peer',
      'media-connection-1',
      peerConnection as unknown as RTCPeerConnection
    );

    const closeEvents: string[] = [];
    connection.on('close', () => {
      closeEvents.push('close');
    });
    const graceTimers = () =>
      scheduledTimeouts.filter(
        (entry) => entry.delayMs === CONNECTION_TIMINGS.TRANSPORT_DISCONNECTED_GRACE_MS
      );

    peerConnection.connectionState = 'disconnected';
    peerConnection.onconnectionstatechange?.();
    assert.equal(peerConnection.connectionState, 'disconnected');
    assert.equal(graceTimers().length, 1);

    peerConnection.connectionState = 'connected';
    peerConnection.onconnectionstatechange?.();
    assert.equal(graceTimers().length, 0);

    peerConnection.connectionState = 'disconnected';
    peerConnection.onconnectionstatechange?.();
    graceTimers()[0].fn();
    assert.equal(peerConnection.connectionState, 'closed');
    assert.equal(closeEvents.length, 1);

    // pc.close() 之后可能再触发一次状态变化，不应该重复上报 close。
    peerConnection.onconnectionstatechange?.();
    connection.close();
    assert.equal(closeEvents.length, 1);
  } finally {
    (globalThis as typeof globalThis & { MediaStream?: unknown }).MediaStream = originalMediaStream;
    restore();
  }
});

test('自动恢复用的 retrySignaling 受信令重连预算约束，不像显式 reconnect 那样清零', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const maxAttempts = CONNECTION_TIMINGS.MAX_SIGNALING_RECONNECT_ATTEMPTS;
    const outcomes: boolean[] = [];

    for (let index = 0; index < maxAttempts + 3; index += 1) {
      FakeWebSocket.instances.at(-1)?.close(1006, 'flaky-network');
      outcomes.push(peer.retrySignaling());
    }

    // 预算用尽后必须拒绝再建 socket，也不能因为「又来一次」就回到 0。
    assert.equal(outcomes.at(-1), false);
    const socketsAtExhaustion = FakeWebSocket.instances.length;
    assert.equal(peer.retrySignaling(), false);
    assert.equal(FakeWebSocket.instances.length, socketsAtExhaustion);
    assert.ok(socketsAtExhaustion <= maxAttempts + 2);

    peer.destroy();
  } finally {
    restore();
  }
});

test('queues offers while signaling is down and flushes them after reconnect', async () => {
  FakeWebSocket.instances.length = 0;
  FakeRTCPeerConnection.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const restored: string[] = [];
    peer.on('signaling:restored', (peerId) => restored.push(peerId));

    const first = FakeWebSocket.instances[0];
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    first.onmessage?.({ data: JSON.stringify({ type: 'registered', peerId: 'peer-a' }) });

    first.close(1006, 'network dropped');
    const reconnectTimer = scheduledTimeouts.find((entry) => entry.delayMs === 1_000);
    assert.ok(reconnectTimer);
    reconnectTimer.fn();

    // 断线期间发起的新连接只能先把 offer 放进队列。
    peer.connect('target-b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = FakeWebSocket.instances[1];
    assert.deepEqual(second.sent, []);

    second.readyState = FakeWebSocket.OPEN;
    second.onopen?.();
    second.onmessage?.({ data: JSON.stringify({ type: 'registered', peerId: 'peer-a' }) });

    const sentTypes = second.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
    assert.ok(sentTypes.includes('offer'));
    assert.deepEqual(restored, ['peer-a']);

    peer.destroy();
  } finally {
    restore();
  }
});

test('ICE restart re-offers with restartIce and extends the close deadline', async () => {
  FakeWebSocket.instances.length = 0;
  FakeRTCPeerConnection.instances.length = 0;

  const { scheduledTimeouts, restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'registered', peerId: 'peer-a' }) });

    peer.connect('target-peer');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const peerConnection = FakeRTCPeerConnection.instances[0];
    peerConnection.connectionState = 'disconnected';
    peerConnection.onconnectionstatechange?.();

    const restartTimer = scheduledTimeouts.find(
      (entry) => entry.delayMs === CONNECTION_TIMINGS.TRANSPORT_ICE_RESTART_DELAY_MS
    );
    assert.ok(restartTimer);

    restartTimer.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(peerConnection.restartIceCalls, 1);
    assert.deepEqual(peerConnection.createOfferOptions.at(-1), { iceRestart: true });
    assert.ok(
      socket.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === 'offer'),
      'restart offer should be forwarded over signaling'
    );
    assert.ok(
      scheduledTimeouts.some(
        (entry) => entry.delayMs === CONNECTION_TIMINGS.TRANSPORT_ICE_RESTART_GRACE_MS
      ),
      'restart should get a fresh close deadline'
    );

    peer.destroy();
  } finally {
    restore();
  }
});

test('signalingRecoveryState separates reconnectable states from terminal ones', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });

    assert.equal(peer.signalingRecoveryState(), 'connecting');

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    assert.equal(peer.signalingRecoveryState(), 'connected');

    socket.close(4029, 'Too many sessions');
    assert.equal(peer.signalingRecoveryState(), 'rejected');

    peer.destroy();
    assert.equal(peer.signalingRecoveryState(), 'destroyed');
  } finally {
    restore();
  }
});

test('rate-limited 的 error 信封把 retryAfterMs 透给上层，供倒计时使用', async () => {
  FakeWebSocket.instances.length = 0;

  const { restore } = installFakeTimers();

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const caught: { type: string; retryAfterMs?: number; limit?: string }[] = [];
    peer.on('error', (error) => {
      caught.push({ type: error.type, retryAfterMs: error.retryAfterMs, limit: error.limit });
    });

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        code: 'rate-limited',
        message: 'Too many connection requests',
        connectionId: 'conn-1',
        retryAfterMs: 42_000,
        limit: 'offer',
      }),
    });

    assert.deepEqual(caught, [{ type: 'rate-limited', retryAfterMs: 42_000, limit: 'offer' }]);

    // 没有该字段时不能凭空造一个（客户端据此回退到静默期兜底）。
    const other = new WorkerSignaledPeer({ debug: 0 });
    const plain: (number | undefined)[] = [];
    other.on('error', (error) => {
      plain.push(error.retryAfterMs);
      assert.equal(error.limit, undefined, '没标层级时不能凭空造一个');
    });
    const otherSocket = FakeWebSocket.instances[1];
    otherSocket.readyState = FakeWebSocket.OPEN;
    otherSocket.onmessage?.({
      data: JSON.stringify({ type: 'error', code: 'server-error', message: 'boom' }),
    });
    assert.deepEqual(plain, [undefined]);

    peer.destroy();
    other.destroy();
  } finally {
    restore();
  }
});

// 模块顶层如果又出现 `window.location.origin`，这条会红：子进程没有 window 也没有
// WebSocket，import 成功才说明这条 import 链（Receiver / ScreenShare / Sender 都要走
// 它）重新变回「可以在 Node 里被测试」。本进程里模块已缓存，删 window 再 import
// 证明不了初始化顺序，所以用干净子进程。
test('模块在没有任何浏览器全局的 Node 进程里可以 import', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const loader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
  const stubs = pathToFileURL(resolve(repoRoot, 'scripts/test-stubs/register.mjs')).href;
  const result = spawnSync(
    process.execPath,
    ['--import', loader, '--import', stubs, '--input-type=module', '-e', "await import('./services/peerRuntime.ts');"],
    { cwd: repoRoot, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
});

test('信令基址惰性求值：没有 window 时为空串，有 window 时用页面 origin', () => {
  const globalScope = globalThis as unknown as { window?: Window };
  const originalWindow = globalScope.window;
  try {
    globalScope.window = undefined;
    assert.equal(getSignalingBase(), '');

    globalScope.window = { location: { origin: 'http://127.0.0.1:3000' } } as unknown as Window;
    assert.equal(getSignalingBase(), 'http://127.0.0.1:3000');
  } finally {
    globalScope.window = originalWindow;
  }
});

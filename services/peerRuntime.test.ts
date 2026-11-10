import assert from 'node:assert/strict';
import test from 'node:test';

import { CONNECTION_TIMINGS } from '../constants/transfer.ts';

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

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(): FakeDataChannel {
    return new FakeDataChannel();
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'fake-offer' });
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
  public onopen: (() => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

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

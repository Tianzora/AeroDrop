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

test('outgoing offers fail fast when signaling closes before registration', async () => {
  FakeWebSocket.instances.length = 0;

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test('pre-registration signaling failures stay handled even without pending offers', async () => {
  FakeWebSocket.instances.length = 0;

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test('data channel errors close the connection so pending transfer waiters can be released', async () => {
  FakeDataChannel.instances.length = 0;
  FakeWebSocket.instances.length = 0;

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test("transport 'disconnected' 先等宽限期，避免把可自愈的抖动当成断链", async () => {
  FakeDataChannel.instances.length = 0;
  FakeWebSocket.instances.length = 0;
  FakeRTCPeerConnection.instances.length = 0;

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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test('服务端用终态 close code 关闭信令时停止重连，并把原因交给上层', async () => {
  FakeWebSocket.instances.length = 0;

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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test('1008（消息过多）是瞬态拥塞，仍按退避重连', async () => {
  FakeWebSocket.instances.length = 0;

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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test('收到终态 error（peerId 被顶替）后主动断开信令且不再重连', async () => {
  FakeWebSocket.instances.length = 0;

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

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
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

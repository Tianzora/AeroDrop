import { expect, test } from '@playwright/test';

const setupSenderHarness = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(() => {
    type ReceiverScenario = {
      peerId: string;
      deviceName: string;
      sessionId: string;
    };

    class FakeConnection {
      public peer: string;
      public provider: FakePeer;
      public peerConnection: null = null;
      public open = false;
      public dataChannel = {
        readyState: 'open',
        bufferedAmount: 0,
      };
      private closed = false;
      private listeners = new Map<string, Array<(...args: any[]) => void>>();

      constructor(provider: FakePeer, peerId: string) {
        this.provider = provider;
        this.peer = peerId;
      }

      on(event: string, listener: (...args: any[]) => void) {
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(listener);
        this.listeners.set(event, bucket);
        return this;
      }

      send(_message: any) {
        // Sender-side E2E only needs control-channel messages to be accepted.
      }

      openNow() {
        if (this.closed || this.open) return;
        this.open = true;
        this.emit('open');
      }

      remoteData(message: any) {
        if (this.closed) return;
        this.emit('data', message);
      }

      close() {
        this.remoteClose();
      }

      remoteClose() {
        if (this.closed) return;
        this.closed = true;
        this.open = false;
        this.dataChannel.readyState = 'closed';
        this.emit('close');
      }

      private emit(event: string, ...args: any[]) {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    }

    class FakePeer {
      public destroyed = false;
      public connections: Record<string, FakeConnection[]> = {};
      private listeners = new Map<string, Array<(...args: any[]) => void>>();
      private id: string;

      constructor(idOrOptions?: string | Record<string, unknown>) {
        this.id = typeof idOrOptions === 'string' ? idOrOptions : `fake-peer-${Date.now()}`;
        peerRegistry.set(this.id, this);
        queueMicrotask(() => {
          if (this.destroyed) return;
          this.emit('open', this.id);
        });
      }

      on(event: string, listener: (...args: any[]) => void) {
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(listener);
        this.listeners.set(event, bucket);
        return this;
      }

      connect(targetPeerId: string) {
        const connection = new FakeConnection(this, targetPeerId);
        this.connections[targetPeerId] = [connection];
        queueMicrotask(() => {
          connection.openNow();
        });
        return connection;
      }

      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        peerRegistry.delete(this.id);
      }

      reconnect() {
        if (this.destroyed) return;
        queueMicrotask(() => {
          this.emit('open', this.id);
        });
      }

      emitIncomingConnection(receiver: ReceiverScenario) {
        const connection = new FakeConnection(this, receiver.peerId);
        this.connections[receiver.peerId] = [connection];
        this.emit('connection', connection);
        queueMicrotask(() => {
          connection.openNow();
          connection.remoteData({
            type: 'DEVICE_INFO',
            payload: {
              deviceName: receiver.deviceName,
              sessionId: receiver.sessionId,
            },
          });
        });
        activeConnections.set(receiver.peerId, connection);
        return connection;
      }

      private emit(event: string, ...args: any[]) {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    }

    const peerRegistry = new Map<string, FakePeer>();
    const activeConnections = new Map<string, FakeConnection>();

    (window as Window & { __AERODROP_E2E__?: unknown }).__AERODROP_E2E__ = {
      getIceConfigOverride: () => ({
        iceServers: [{ urls: 'stun:example.org:3478' }],
        secure: true,
        iceCandidatePoolSize: 1,
        iceTransportPolicy: 'all',
        hasTurn: false,
        relayRecommended: false,
        relayReason: null,
        fetchLatencyMs: 0,
      }),
      createPeerRuntimeModule: () => ({
        default: FakePeer,
      }),
      // 口令服务在 vite preview 下不可用：用固定 6 位码替代。
      createShareCodeOverride: ({ code }: { code?: string }) => ({
        code: code ?? '444444',
        expiresAt: Date.now() + 3_600_000,
      }),
      resolveShareCodeOverride: (code: string) => ({
        peerId: `peer-${code}`,
        expiresAt: Date.now() + 3_600_000,
      }),
    };

    (window as Window & { __AERODROP_E2E_DRIVER__?: unknown }).__AERODROP_E2E_DRIVER__ = {
      hasPeer(_code: string) {
        return peerRegistry.size > 0;
      },
      connectReceiver(_code: string, receiver: ReceiverScenario) {
        const peer = Array.from(peerRegistry.values()).at(-1);
        if (!peer) {
          return false;
        }
        peer.emitIncomingConnection(receiver);
        return true;
      },
      disconnectReceiver(peerId: string) {
        activeConnections.get(peerId)?.remoteClose();
      },
    };
  });
};

const hasSharePeer = async (page: import('@playwright/test').Page, code: string) =>
  page.evaluate(([shareCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.hasPeer(shareCode);
  }, [code]);

const connectReceiver = async (
  page: import('@playwright/test').Page,
  code: string,
  receiver: { peerId: string; deviceName: string; sessionId: string }
) =>
  page.evaluate(([shareCode, nextReceiver]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.connectReceiver(shareCode, nextReceiver);
  }, [code, receiver]);

const disconnectReceiver = async (page: import('@playwright/test').Page, peerId: string) =>
  page.evaluate(([targetPeerId]) => {
    (window as any).__AERODROP_E2E_DRIVER__.disconnectReceiver(targetPeerId);
  }, [peerId]);

const chooseFileAndConfigureShare = async (
  page: import('@playwright/test').Page,
  code: string
) => {
  await page.goto('/');
  await page.locator('#file-upload').setInputFiles({
    name: `file-${code}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`sender-${code}`),
  });
  await page.locator('input[type="text"][inputmode="numeric"]').fill(code);
  await page.getByRole('button', { name: '创建分享' }).click();
};

test.beforeEach(async ({ page }) => {
  await setupSenderHarness(page);
  await page.route('**/api/network-check**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        isRisk: false,
        reason: null,
        details: '',
        isp: 'E2E',
        country: 'CN',
      }),
    });
  });
  await page.route('**/api/ping', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain;charset=UTF-8',
      body: 'pong',
    });
  });
});

const getShareCodeCard = (page: import('@playwright/test').Page, code: string) =>
  page.getByText(code, { exact: true });

test('stopping and quickly recreating a share does not let stale cleanup kill the new peer', async ({ page }) => {
  await chooseFileAndConfigureShare(page, '333333');
  await expect(getShareCodeCard(page, '333333')).toBeVisible();

  await page.getByRole('button', { name: '停止分享' }).click();

  await page.locator('#file-upload').setInputFiles({
    name: 'file-4444.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('sender-4444'),
  });
  await page.locator('input[type="text"][inputmode="numeric"]').fill('444444');
  await page.getByRole('button', { name: '创建分享' }).click();

  await expect(getShareCodeCard(page, '444444')).toBeVisible();
  await page.waitForTimeout(200);
  await expect.poll(async () => hasSharePeer(page, '444444')).toBe(true);

  await connectReceiver(page, '444444', {
    peerId: 'receiver-restart-a',
    deviceName: 'Receiver Restart',
    sessionId: 'session-restart-a',
  });

  await expect(page.getByText('Receiver Restart')).toBeVisible();
  await expect(page.getByText('设备传输列表 (1)')).toBeVisible();
});

test('multi-receiver list stays stable when one logical receiver reconnects', async ({ page }) => {
  await chooseFileAndConfigureShare(page, '555555');
  await expect(getShareCodeCard(page, '555555')).toBeVisible();

  await connectReceiver(page, '555555', {
    peerId: 'receiver-a-1',
    deviceName: 'Receiver A',
    sessionId: 'session-a',
  });
  await connectReceiver(page, '555555', {
    peerId: 'receiver-b-1',
    deviceName: 'Receiver B',
    sessionId: 'session-b',
  });

  await expect(page.getByText('设备传输列表 (2)')).toBeVisible();
  await expect(page.getByText('Receiver A')).toBeVisible();
  await expect(page.getByText('Receiver B')).toBeVisible();
  await expect(page.getByText('已连接 2 个设备')).toBeVisible();

  await disconnectReceiver(page, 'receiver-a-1');
  await connectReceiver(page, '555555', {
    peerId: 'receiver-a-2',
    deviceName: 'Receiver A',
    sessionId: 'session-a',
  });

  await expect(page.getByText('设备传输列表 (2)')).toBeVisible();
  await expect(page.getByText('已连接 2 个设备')).toBeVisible();
  await expect(page.getByText('Receiver A')).toHaveCount(1);
  await expect(page.getByText('Receiver B')).toHaveCount(1);
});

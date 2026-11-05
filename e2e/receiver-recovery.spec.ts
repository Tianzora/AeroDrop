import { expect, test } from '@playwright/test';

const setupReceiverHarness = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(() => {
    type Scenario = {
      code: string;
      deviceName: string;
      metadata: {
        files: Array<{ name: string; size: number; type: string; lastModified: number }>;
        totalSize: number;
        protocolVersion: number;
      };
      holdNextOpen: boolean;
      connectionCount: number;
      connectionPolicies: RTCIceTransportPolicy[];
      sentMessages: any[];
      latestConnection: FakeConnection | null;
      pendingConnections: FakeConnection[];
    };

    class FakeConnection {
      public peer: string;
      public provider: FakePeer;
      public peerConnection: null = null;
      public open = false;
      private closed = false;
      private listeners = new Map<string, Array<(...args: any[]) => void>>();

      constructor(provider: FakePeer, private readonly scenario: Scenario) {
        this.provider = provider;
        this.peer = `sender-${scenario.code}`;
        this.scheduleOpen();
      }

      on(event: string, listener: (...args: any[]) => void) {
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(listener);
        this.listeners.set(event, bucket);
        return this;
      }

      send(message: any) {
        this.scenario.sentMessages.push(message);
        if (message?.type === 'ROUTE_PROBE') {
          queueMicrotask(() => {
            this.emit('data', {
              type: 'ROUTE_READY',
              payload: {
                receiverSessionId: message.payload.receiverSessionId,
                attemptId: message.payload.attemptId,
              },
            });
          });
          return;
        }

        if (message?.type === 'ROUTE_COMMIT') {
          queueMicrotask(() => {
            this.emit('data', {
              type: 'DEVICE_INFO',
              payload: { deviceName: this.scenario.deviceName },
            });
            this.emit('data', {
              type: 'METADATA',
              payload: this.scenario.metadata,
            });
          });
        }
      }

      close() {
        this.remoteClose();
      }

      openNow() {
        if (this.closed || this.open) return;
        this.open = true;
        this.emit('open');
      }

      remoteClose() {
        if (this.closed) return;
        this.closed = true;
        this.open = false;
        this.emit('close');
      }

      remoteData(data: any) {
        if (this.closed) return;
        this.emit('data', data);
      }

      private scheduleOpen() {
        if (this.scenario.holdNextOpen) {
          this.scenario.holdNextOpen = false;
          this.scenario.pendingConnections.push(this);
          return;
        }

        queueMicrotask(() => {
          this.openNow();
        });
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
      private iceTransportPolicy: RTCIceTransportPolicy;

      constructor(idOrOptions?: string | Record<string, any>, maybeOptions?: Record<string, any>) {
        this.id = typeof idOrOptions === 'string' ? idOrOptions : `fake-peer-${Date.now()}`;
        const options = typeof idOrOptions === 'string' ? maybeOptions : idOrOptions;
        this.iceTransportPolicy = options?.config?.iceTransportPolicy ?? 'all';
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
        const code = targetPeerId.replace(/^(?:aerodrop-|peer-)/, '');
        const scenario = ensureScenario(code);
        scenario.connectionCount += 1;
        scenario.connectionPolicies.push(this.iceTransportPolicy);
        const connection = new FakeConnection(this, scenario);
        scenario.latestConnection = connection;
        this.connections[targetPeerId] = [connection];
        return connection;
      }

      destroy() {
        this.destroyed = true;
      }

      reconnect() {
        if (this.destroyed) return;
        queueMicrotask(() => {
          this.emit('open', this.id);
        });
      }

      private emit(event: string, ...args: any[]) {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    }

    const scenarios = new Map<string, Scenario>();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    });

    const ensureScenario = (code: string): Scenario => {
      let scenario = scenarios.get(code);
      if (!scenario) {
        scenario = {
          code,
          deviceName: `Sender ${code}`,
          metadata: {
            files: [
              {
                name: `file-${code}.txt`,
                size: 2 * 1024 * 1024,
                type: 'text/plain',
                lastModified: 0,
              },
            ],
            totalSize: 2 * 1024 * 1024,
            protocolVersion: 4,
          },
          holdNextOpen: false,
          connectionCount: 0,
          connectionPolicies: [],
          sentMessages: [],
          latestConnection: null,
          pendingConnections: [],
        };
        scenarios.set(code, scenario);
      }
      return scenario;
    };

    (window as Window & { __AERODROP_E2E__?: unknown }).__AERODROP_E2E__ = {
      getIceConfigOverride: () => ({
        iceServers: [{
          urls: 'turn:example.org:3478?transport=tcp',
          username: 'e2e',
          credential: 'e2e',
        }],
        secure: true,
        iceCandidatePoolSize: 1,
        iceTransportPolicy: 'all',
        hasTurn: true,
        relayRecommended: false,
        relayReason: null,
        fetchLatencyMs: 0,
      }),
      createPeerRuntimeModule: () => ({
        default: FakePeer,
      }),
      // 口令服务在 vite preview 下不可用：任何 6 位码都映射到固定的假对端。
      createShareCodeOverride: ({ code }: { code?: string }) => ({
        code: code ?? '111111',
        expiresAt: Date.now() + 3_600_000,
      }),
      resolveShareCodeOverride: (code: string) => ({
        peerId: `peer-${code}`,
        expiresAt: Date.now() + 3_600_000,
      }),
    };

    (window as Window & { __AERODROP_E2E_DRIVER__?: unknown }).__AERODROP_E2E_DRIVER__ = {
      setScenario(code: string, overrides?: Partial<Omit<Scenario, 'code' | 'connectionCount' | 'latestConnection'>>) {
        const scenario = ensureScenario(code);
        Object.assign(scenario, overrides ?? {});
      },
      holdNextOpen(code: string) {
        ensureScenario(code).holdNextOpen = true;
      },
      openLatest(code: string) {
        const scenario = ensureScenario(code);
        const pending = scenario.pendingConnections.pop();
        pending?.openNow();
      },
      disconnectLatest(code: string) {
        ensureScenario(code).latestConnection?.remoteClose();
      },
      getConnectionCount(code: string) {
        return ensureScenario(code).connectionCount;
      },
      getConnectionPolicies(code: string) {
        return ensureScenario(code).connectionPolicies;
      },
      getResumeRequests(code: string) {
        return ensureScenario(code).sentMessages.filter((message) => message?.type === 'RESUME_REQUEST');
      },
      sendCommittedChunk(code: string, byteLength: number) {
        const scenario = ensureScenario(code);
        const connection = scenario.latestConnection;
        connection?.remoteData({
          type: 'FILE_START',
          payload: {
            fileIndex: 0,
            fileName: scenario.metadata.files[0].name,
            fileSize: scenario.metadata.files[0].size,
            fileType: scenario.metadata.files[0].type,
          },
        });
        connection?.remoteData(new Uint8Array(byteLength).buffer);
      },
      getPersistedProgress(code: string) {
        return ensureScenario(code).sentMessages
          .filter((message) => message?.type === 'TRANSFER_PROGRESS')
          .map((message) => message.payload.overallTransferredBytes);
      },
    };
  });
};

const setScenario = async (page: import('@playwright/test').Page, code: string) => {
  await page.evaluate(([scenarioCode]) => {
    (window as any).__AERODROP_E2E_DRIVER__.setScenario(scenarioCode);
  }, [code]);
};

const disconnectLatest = async (page: import('@playwright/test').Page, code: string) => {
  await page.evaluate(([scenarioCode]) => {
    (window as any).__AERODROP_E2E_DRIVER__.disconnectLatest(scenarioCode);
  }, [code]);
};

const holdNextOpen = async (page: import('@playwright/test').Page, code: string) => {
  await page.evaluate(([scenarioCode]) => {
    (window as any).__AERODROP_E2E_DRIVER__.holdNextOpen(scenarioCode);
  }, [code]);
};

const openLatest = async (page: import('@playwright/test').Page, code: string) => {
  await page.evaluate(([scenarioCode]) => {
    (window as any).__AERODROP_E2E_DRIVER__.openLatest(scenarioCode);
  }, [code]);
};

const getConnectionCount = async (page: import('@playwright/test').Page, code: string) => {
  return page.evaluate(([scenarioCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.getConnectionCount(scenarioCode);
  }, [code]);
};

const getConnectionPolicies = async (page: import('@playwright/test').Page, code: string) => {
  return page.evaluate(([scenarioCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.getConnectionPolicies(scenarioCode);
  }, [code]);
};

const getResumeRequests = async (page: import('@playwright/test').Page, code: string) => {
  return page.evaluate(([scenarioCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.getResumeRequests(scenarioCode);
  }, [code]);
};

const sendCommittedChunk = async (
  page: import('@playwright/test').Page,
  code: string,
  byteLength: number,
) => {
  await page.evaluate(([scenarioCode, size]) => {
    (window as any).__AERODROP_E2E_DRIVER__.sendCommittedChunk(scenarioCode, size);
  }, [code, byteLength] as const);
};

const getPersistedProgress = async (page: import('@playwright/test').Page, code: string) => {
  return page.evaluate(([scenarioCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.getPersistedProgress(scenarioCode);
  }, [code]);
};

const openReceiverAndEnterCode = async (
  page: import('@playwright/test').Page,
  code: string
) => {
  await page.goto('/');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill(code);
};

const enterCodeWithKeypad = async (
  page: import('@playwright/test').Page,
  code: string
) => {
  for (const digit of code) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
};

test.beforeEach(async ({ page }) => {
  await setupReceiverHarness(page);
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

const getReadyToReceiveButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /确认并下载|继续下载/ });

test('receiver auto-recovers after a disconnect and returns to resumable state', async ({ page }) => {
  await page.goto('/');
  await setScenario(page, '111111');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('111111');

  await expect(getReadyToReceiveButton(page)).toBeVisible();

  await disconnectLatest(page, '111111');

  await expect(page.getByText('连接中断，正在尝试恢复...')).toBeVisible();
  await expect(page.getByText('第 1 次自动重连中，请保持此页面打开，无需重新输入口令。')).toBeVisible();

  await expect(page.getByRole('button', { name: '继续下载' })).toBeVisible();
  await expect.poll(async () => getConnectionCount(page, '111111')).toBe(2);
});

test('stalled persisted progress reconnects through relay and resumes from the committed offset', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await setScenario(page, '444444');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('444444');

  await expect(page.getByRole('button', { name: '确认并下载' })).toBeVisible();
  await page.getByRole('button', { name: '确认并下载' }).click();
  await expect(page.getByText('当前文件进度')).toBeVisible();

  const committedBytes = 1024 * 1024;
  await sendCommittedChunk(page, '444444', committedBytes);
  await expect.poll(async () => getPersistedProgress(page, '444444')).toContain(committedBytes);

  await page.clock.fastForward(14_000);

  await expect.poll(async () => getConnectionCount(page, '444444')).toBe(2);
  await expect.poll(async () => getConnectionPolicies(page, '444444')).toEqual(['all', 'relay']);
  await expect.poll(async () => getResumeRequests(page, '444444')).toEqual([
    {
      type: 'RESUME_REQUEST',
      payload: {
        fileIndex: 0,
        byteOffset: committedBytes,
        silent: false,
        receiveWindowBytes: 2 * 1024 * 1024,
      },
    },
  ]);
});

test('cancel during reconnect clears stale timers and allows a clean reconnect', async ({ page }) => {
  await page.goto('/');
  await setScenario(page, '222222');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('222222');

  await expect(page.getByRole('button', { name: '确认并下载' })).toBeVisible();

  await disconnectLatest(page, '222222');
  await expect(page.getByText('连接中断，正在尝试恢复...')).toBeVisible();

  await page.getByRole('button', { name: /停止重连|取消/ }).click({ force: true });
  await expect(page.getByRole('button', { name: '0', exact: true })).toBeVisible();
  await expect(page.getByText('连接中断，正在尝试恢复...')).toHaveCount(0);

  await enterCodeWithKeypad(page, '222222');
  await expect(getReadyToReceiveButton(page)).toBeVisible();

  await page.waitForTimeout(1200);
  await expect(getReadyToReceiveButton(page)).toBeVisible();
  await expect.poll(async () => getConnectionCount(page, '222222')).toBe(2);
});

test('cancelled receive stays idle even if a stale reconnect connection opens later', async ({ page }) => {
  await page.goto('/');
  await setScenario(page, '333333');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('333333');

  await expect(page.getByRole('button', { name: '确认并下载' })).toBeVisible();

  await holdNextOpen(page, '333333');
  await disconnectLatest(page, '333333');
  await expect(page.getByText('连接中断，正在尝试恢复...')).toBeVisible();
  await expect.poll(async () => getConnectionCount(page, '333333')).toBe(2);

  await page.getByRole('button', { name: /停止重连|取消/ }).click({ force: true });
  await expect(page.getByRole('button', { name: '0', exact: true })).toBeVisible();

  await openLatest(page, '333333');

  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: '0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /确认并下载|继续下载/ })).toHaveCount(0);
  await expect(page.getByText('连接中断，正在尝试恢复...')).toHaveCount(0);
});

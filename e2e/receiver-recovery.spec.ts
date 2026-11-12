import { expect, test } from '@playwright/test';
import { CONNECTION_TIMINGS } from '../constants/transfer';

// 与 components/Receiver.tsx 的 scheduleFastReconnect 一致：第 n 次重试延迟
// min(BASE * 2^(n-1), MAX)，次数上限 RECEIVER_MAX_CONNECT_RETRY。
const FAST_RETRY_INTERVALS = Array.from(
  { length: CONNECTION_TIMINGS.RECEIVER_MAX_CONNECT_RETRY },
  (_, index) =>
    Math.min(
      CONNECTION_TIMINGS.RECEIVER_FAST_RETRY_BASE_MS * 2 ** index,
      CONNECTION_TIMINGS.RECEIVER_FAST_RETRY_MAX_MS
    )
);
const EXPECTED_ATTEMPT_CONNECTIONS = 1 + CONNECTION_TIMINGS.RECEIVER_MAX_CONNECT_RETRY;

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
      /** 每次连接 open 后立刻被远端 close，且不回 ROUTE_READY / ROUTE_COMMIT / METADATA。 */
      autoCloseOnOpen: boolean;
      connectionCount: number;
      /** 每次 connect() 的 Date.now()，用于量测重连间隔。 */
      connectionTimes: number[];
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
        // 「open 后立刻断开」抖动场景：对端从不应答任何控制面消息。
        if (this.scenario.autoCloseOnOpen) return;
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
          if (this.scenario.autoCloseOnOpen) this.remoteClose();
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
        scenario.connectionTimes.push(Date.now());
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
          autoCloseOnOpen: false,
          connectionCount: 0,
          connectionTimes: [],
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
      getConnectionTimes(code: string) {
        return ensureScenario(code).connectionTimes.slice();
      },
      getSentMessageTypes(code: string) {
        const counts: Record<string, number> = {};
        for (const message of ensureScenario(code).sentMessages) {
          const type = typeof message?.type === 'string' ? message.type : 'binary';
          counts[type] = (counts[type] ?? 0) + 1;
        }
        return counts;
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

const setScenarioWith = async (
  page: import('@playwright/test').Page,
  code: string,
  overrides: Record<string, unknown>,
) => {
  await page.evaluate(([scenarioCode, scenarioOverrides]) => {
    (window as any).__AERODROP_E2E_DRIVER__.setScenario(scenarioCode, scenarioOverrides);
  }, [code, overrides] as const);
};

const getConnectionTimes = async (page: import('@playwright/test').Page, code: string) => {
  return page.evaluate(([scenarioCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.getConnectionTimes(scenarioCode);
  }, [code]) as Promise<number[]>;
};

const getSentMessageTypes = async (page: import('@playwright/test').Page, code: string) => {
  return page.evaluate(([scenarioCode]) => {
    return (window as any).__AERODROP_E2E_DRIVER__.getSentMessageTypes(scenarioCode);
  }, [code]) as Promise<Record<string, number>>;
};

const getBodyText = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.body.innerText);

/**
 * 逐段推进 fake clock，直到条件成立。clock.install() 之后 fastForward 每个到期
 * timer 最多触发一次，嵌套 timer（重连 -> 建连 -> 握手）必须靠 runFor 连续推进。
 */
const advanceClockUntil = async (
  page: import('@playwright/test').Page,
  check: () => Promise<boolean>,
  { maxSteps = 40, stepMs = 300 } = {},
) => {
  for (let step = 0; step < maxSteps; step += 1) {
    if (await check()) return true;
    await page.clock.runFor(stepMs);
    await page.waitForTimeout(25); // 让 React 提交与微任务落地
  }
  return check();
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
  await expect(page.getByText('第 1 次自动重连中，请保持此页面打开，无需重新输入口令')).toBeVisible();

  await expect(page.getByRole('button', { name: '继续下载' })).toBeVisible();
  await expect.poll(async () => getConnectionCount(page, '111111')).toBe(2);
});

test('stalled persisted progress reconnects without forcing relay, then falls back to relay on the second stall', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await setScenario(page, '444444');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('444444');

  await expect(page.getByRole('button', { name: '确认并下载' })).toBeVisible();
  await page.getByRole('button', { name: '确认并下载' }).click();
  await expect(page.getByRole('progressbar', { name: '传输进度' })).toBeVisible();

  const committedBytes = 1024 * 1024;
  await sendCommittedChunk(page, '444444', committedBytes);
  await expect.poll(async () => getPersistedProgress(page, '444444')).toContain(committedBytes);

  await page.clock.fastForward(14_000);

  await expect.poll(async () => getConnectionCount(page, '444444')).toBe(2);
  // 第一次停滞先按原路径（all）重试，避免一次抖动就把整场传输锁死在中继上。
  await expect.poll(async () => getConnectionPolicies(page, '444444')).toEqual(['all', 'all']);
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

  await page.clock.fastForward(14_000);
  await expect.poll(async () => getConnectionCount(page, '444444')).toBe(3);
  await expect.poll(async () => getConnectionPolicies(page, '444444')).toEqual(['all', 'all', 'relay']);
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

test('open-then-close churn exhausts the fast reconnect budget instead of looping forever', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await page.goto('/');
  // 每次新连接 open 后立刻被远端关闭：不 ROUTE_COMMIT、不发送 METADATA，
  // 即「连上即断」的最坏抖动。修复前 retryCountRef 在 open 时清零，这种抖动
  // 会以恒定 700ms 间隔无限重连。
  await setScenarioWith(page, '555555', { autoCloseOnOpen: true });
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('555555');

  await expect.poll(async () => getConnectionCount(page, '555555'), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  // 快速重试预算用满：间隔见 FAST_RETRY_INTERVALS（指数退避到上限）。
  await page.clock.runFor(30_000);
  await expect.poll(async () => getConnectionCount(page, '555555')).toBe(EXPECTED_ATTEMPT_CONNECTIONS);
  await page.waitForTimeout(100);

  const times = await getConnectionTimes(page, '555555');
  const deltas = times.slice(1).map((time, index) => time - times[index]);
  const sentTypes = await getSentMessageTypes(page, '555555');
  // 预算耗尽后必须收口成 ERROR，而不是停在「正在建立点对点通道...」。
  // 判定点在 services/connectionPolicy.ts 的 shouldAbandonExhaustedFastReconnect，
  // 由 Receiver 的 conn.on('close') 里 `connRef.current !== conn` 分支调用。
  // hasTurn=true 且仍在等待对端 ⇒ 文案是「请检查口令」那条，而非 committed 上限的「连接已断开」。
  await expect(page.getByText('连接已断开，请检查口令是否正确后重试')).toBeVisible();
  await expect(page.getByText(/正在建立点对点通道/)).toHaveCount(0);

  const bodyText = await getBodyText(page);

  await test.info().attach('fast-reconnect-budget-report.json', {
    body: JSON.stringify({ deltas, sentTypes, bodyTail: bodyText.slice(-500) }, null, 2),
    contentType: 'application/json',
  });
  console.log('[fast-reconnect] deltas(ms):', JSON.stringify(deltas));
  console.log('[fast-reconnect] sentTypes:', JSON.stringify(sentTypes));
  console.log('[fast-reconnect] bodyTail:', bodyText.slice(-300));

  // 1 次首连 + RECEIVER_MAX_CONNECT_RETRY 次重试；间隔必须指数退避到上限，而不是恒定 700ms。
  // 首段 timer 可能是在真实时间流动时触发的，允许 ±100ms 抖动。
  expect(deltas).toHaveLength(FAST_RETRY_INTERVALS.length);
  deltas.forEach((delta, index) => {
    expect(Math.abs(delta - FAST_RETRY_INTERVALS[index])).toBeLessThanOrEqual(100);
  });
  expect(sentTypes.ROUTE_PROBE).toBe(EXPECTED_ATTEMPT_CONNECTIONS);

  // ERROR 之后不得再起新连接：再推 30s，连接数与 ROUTE_PROBE 都不增长。
  await page.clock.runFor(30_000);
  await page.waitForTimeout(100);
  expect(await getConnectionCount(page, '555555')).toBe(EXPECTED_ATTEMPT_CONNECTIONS);
  expect((await getSentMessageTypes(page, '555555')).ROUTE_PROBE).toBe(EXPECTED_ATTEMPT_CONNECTIONS);
});

test('committed reconnect budget caps at 3 attempts and then reports an error', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await setScenario(page, '888888');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('888888');

  await expect(getReadyToReceiveButton(page)).toBeVisible();

  const banner = page.getByText(/第 \d+ 次自动重连中/);
  const attempts: number[] = [];
  const connectionCounts: number[] = [];

  for (let round = 1; round <= 3; round += 1) {
    const connectionsBefore = await getConnectionCount(page, '888888');
    await disconnectLatest(page, '888888');

    await expect(banner).toBeVisible({ timeout: 15_000 });
    const bannerText = (await banner.innerText()).trim();
    const attempt = Number(/第 (\d+) 次自动重连中/.exec(bannerText)?.[1]);
    attempts.push(attempt);

    // 重连成功并再次收到 METADATA 的唯一外部信号：重连文案消失、连接数 +1。
    await expect.poll(async () => getConnectionCount(page, '888888'), { timeout: 15_000 })
      .toBe(connectionsBefore + 1);
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    connectionCounts.push(await getConnectionCount(page, '888888'));
  }

  // 第 4 次断连：已连续 3 次不稳定，不再重连，直接进入 ERROR。
  const connectionsBeforeCap = await getConnectionCount(page, '888888');
  await disconnectLatest(page, '888888');
  await expect(page.getByText('连接已断开')).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveCount(0);

  await page.waitForTimeout(2_000);
  const connectionsAfterCap = await getConnectionCount(page, '888888');
  const bodyText = await getBodyText(page);

  await test.info().attach('committed-reconnect-budget-report.json', {
    body: JSON.stringify({ attempts, connectionCounts, connectionsAfterCap, bodyTail: bodyText.slice(-500) }, null, 2),
    contentType: 'application/json',
  });
  console.log('[committed-reconnect] attempts:', JSON.stringify(attempts), 'counts:', JSON.stringify(connectionCounts));
  console.log('[committed-reconnect] bodyTail:', bodyText.slice(-300));

  expect(attempts).toEqual([1, 2, 3]);
  expect(connectionCounts).toEqual([2, 3, 4]);
  expect(connectionsAfterCap).toBe(connectionsBeforeCap);
});

test('a connection that stays stable for 15s refreshes the reconnect budget', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await page.goto('/');
  await setScenario(page, '777777');
  await page.getByRole('button', { name: '接收' }).click();
  await page.locator('input[type="text"]').fill('777777');

  await expect(getReadyToReceiveButton(page)).toBeVisible();

  const banner = page.getByText(/第 \d+ 次自动重连中/);
  const expectBannerAttempt = async (attempt: number) => {
    await expect(
      page.getByText(`第 ${attempt} 次自动重连中，请保持此页面打开，无需重新输入口令`),
    ).toBeVisible({ timeout: 15_000 });
  };
  const waitForReconnect = async (expectedConnections: number) => {
    const settled = await advanceClockUntil(page, async () => {
      return (await getConnectionCount(page, '777777')) === expectedConnections
        && (await banner.count()) === 0;
    });
    expect(settled).toBe(true);
  };

  // 连续 3 次「连上即断」：预算依次用掉 1、2、3，最后一次重连成功。
  for (let round = 1; round <= 3; round += 1) {
    await disconnectLatest(page, '777777');
    await expectBannerAttempt(round);
    await waitForReconnect(round + 1);
  }

  // 稳定存活超过 RECEIVER_RECONNECT_BUDGET_STABLE_MS(15s) 后再断：预算应清零，
  // 从第 1 次重新开始。若上限是「整场 3 次」，这里会直接进入 ERROR 而不是重连。
  await page.clock.runFor(16_000);
  await page.waitForTimeout(50);
  await disconnectLatest(page, '777777');
  await expectBannerAttempt(1);
  await waitForReconnect(5);
  await expect(page.getByText('连接已断开')).toHaveCount(0);
});

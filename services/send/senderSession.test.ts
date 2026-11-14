import assert from 'node:assert/strict';
import test from 'node:test';

import { P2P_PROTOCOL_VERSION, type FileMetadata } from '../../types/index.ts';
import type {
  SenderSessionClock,
  SenderSessionDeps,
  SenderSessionHost,
} from './senderSession.ts';
import type { IceConfigResult } from '../stunService.ts';
import { getPeerRuntimeErrorMessage, SHARE_SIGNALING_LOST_MESSAGE } from '../connectionGuidance.ts';

// peerRuntime.ts 在模块顶层读 window.location.origin，Node 测试里必须先补最小 DOM 桩，
// 再用动态 import 加载被测模块（与 peerRuntime.test.ts 的做法一致）。
// 监听器登记表：dispose 是否真的解绑 pagehide/pageshow/visibilitychange 要靠它断言。
const domListeners = new Set<string>();
const globals = globalThis as typeof globalThis & {
  window?: unknown;
  document?: unknown;
};
globals.window ??= ({
  location: { origin: 'http://127.0.0.1:3401' },
  addEventListener: (type: string) => { domListeners.add(`window:${type}`); },
  removeEventListener: (type: string) => { domListeners.delete(`window:${type}`); },
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: number) => clearTimeout(handle),
  setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
  clearInterval: (handle: number) => clearInterval(handle),
} as unknown) as typeof window;
globals.document ??= ({
  visibilityState: 'visible',
  addEventListener: (type: string) => { domListeners.add(`document:${type}`); },
  removeEventListener: (type: string) => { domListeners.delete(`document:${type}`); },
} as unknown) as Document;
const { createSenderSession } = await import('./senderSession.ts');

const iceConfig: IceConfigResult = {
  iceServers: [],
  secure: true,
  iceCandidatePoolSize: 0,
  iceTransportPolicy: 'all',
  hasTurn: true,
  relayRecommended: false,
  relayReason: null,
  fetchLatencyMs: 5,
};

const metadata: FileMetadata = { files: [], totalSize: 0 };

class FakeClock implements SenderSessionClock {
  public time = 0;
  private nextId = 1;
  private readonly intervals = new Map<number, { callback: () => void; period: number; due: number }>();
  private readonly timeouts = new Map<number, { callback: () => void; due: number }>();

  now(): number {
    return this.time;
  }

  setInterval(callback: () => void, period: number): number {
    const id = this.nextId++;
    this.intervals.set(id, { callback, period, due: this.time + period });
    return id;
  }

  clearInterval(handle: number): void {
    this.intervals.delete(handle);
  }

  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, due: this.time + delay });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timeouts.delete(handle);
  }

  get intervalCount(): number {
    return this.intervals.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (let guard = 0; guard < 10_000; guard += 1) {
      let nextAt = Number.POSITIVE_INFINITY;
      for (const timer of this.timeouts.values()) nextAt = Math.min(nextAt, timer.due);
      for (const timer of this.intervals.values()) nextAt = Math.min(nextAt, timer.due);
      if (nextAt > target) break;
      this.time = nextAt;
      for (const [id, timer] of [...this.timeouts.entries()]) {
        if (timer.due <= this.time) {
          this.timeouts.delete(id);
          timer.callback();
        }
      }
      for (const timer of this.intervals.values()) {
        if (timer.due <= this.time) {
          timer.due = this.time + timer.period;
          timer.callback();
        }
      }
    }
    this.time = target;
  }
}

class FakePeer {
  public static instances: FakePeer[] = [];
  public destroyed = false;
  public readonly id: string;
  public readonly options: unknown;
  public readonly iceServersUpdates: unknown[] = [];
  private readonly listeners = new Map<string, Array<(payload?: unknown) => void>>();

  constructor(id: string, options: unknown) {
    this.id = id;
    this.options = options;
    FakePeer.instances.push(this);
  }

  on(event: string, callback: (payload?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
  }

  emit(event: string, payload?: unknown): void {
    for (const callback of this.listeners.get(event) ?? []) callback(payload);
  }

  updateIceServers(servers: unknown): void {
    this.iceServersUpdates.push(servers);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

interface HostLog {
  phases: Array<{ phase: string; message?: string }>;
  preparingStages: string[];
  shareCodes: string[];
  remainingTimes: string[];
  notifications: Array<{ message: string; type: string }>;
  events: string[];
  peerErrors: unknown[];
  sessionLost: number;
  shareEnded: number;
  connectionFailures: string[];
  /** 状态行文案的写入顺序：用来断言「有在途传输时降级提示而不是 error」 */
  connectionStatuses: string[];
  /** 持久降级位（口令已作废）的写入顺序：这条不能靠 30 秒提示兜住 */
  shareRevoked: Array<string | null>;
  /** 关键回调顺序，用来断言「先走完整停止流程，再写 error 态」。 */
  order: string[];
  metadata: FileMetadata | null;
  phase(): string;
}

const createHost = () => {
  let peer: FakePeer | null = null;
  const log: HostLog = {
    phases: [],
    preparingStages: [],
    shareCodes: [],
    remainingTimes: [],
    notifications: [],
    events: [],
    peerErrors: [],
    sessionLost: 0,
    shareEnded: 0,
    connectionFailures: [],
    connectionStatuses: [],
    shareRevoked: [],
    order: [],
    metadata: null,
    phase: () => log.phases[log.phases.length - 1]?.phase ?? '',
  };
  let activeTransfers = 0;
  let activeConnections = 0;
  let unavailable = false;
  const host: SenderSessionHost = {
    attachPeer: (next) => { peer = next as unknown as FakePeer; },
    getPeer: () => peer as never,
    destroyPeer: (next) => {
      (next as unknown as FakePeer).destroy();
      if (peer === (next as unknown as FakePeer)) peer = null;
    },
    setPhase: (phase, message) => {
      log.phases.push({ phase, message });
      log.order.push(`phase:${phase}`);
    },
    setPreparingStage: (stage) => { log.preparingStages.push(stage); },
    setShareCode: (code) => { log.shareCodes.push(code); },
    setRemainingTime: (text) => { log.remainingTimes.push(text); },
    setConnectionStatus: (status) => { log.connectionStatuses.push(status); },
    setShareRevoked: (message) => { log.shareRevoked.push(message); },
    setMetadata: (next) => { log.metadata = next; },
    notify: (message, type) => { log.notifications.push({ message, type }); },
    getActiveTransfers: () => activeTransfers,
    getActiveConnectionCount: () => activeConnections,
    isUnavailable: () => unavailable,
    onIceConfig: () => {},
    markSignalingOpen: () => {},
    markConnectionSuccess: () => {},
    markConnectionFailure: (reason) => { log.connectionFailures.push(reason); },
    markSessionEvent: (event) => { log.events.push(event); },
    logPeerError: (error) => { log.peerErrors.push(error); },
    onShareEnded: () => {
      log.shareEnded += 1;
      log.order.push('shareEnded');
    },
    onSessionLost: () => { log.sessionLost += 1; },
  };
  return {
    host,
    log,
    peer: () => peer,
    setActiveTransfers: (value: number) => { activeTransfers = value; },
    setActiveConnections: (value: number) => { activeConnections = value; },
    setUnavailable: (value: boolean) => { unavailable = value; },
  };
};

const createDeps = (
  overrides: Partial<SenderSessionDeps> = {},
): { deps: Partial<SenderSessionDeps>; clock: FakeClock; requestCalls: Array<Record<string, unknown>>; revokeCalls: Array<Record<string, unknown>>; resumeCalls: Array<Record<string, unknown>>; beacons: string[] } => {
  const clock = new FakeClock();
  const requestCalls: Array<Record<string, unknown>> = [];
  const revokeCalls: Array<Record<string, unknown>> = [];
  const resumeCalls: Array<Record<string, unknown>> = [];
  const beacons: string[] = [];
  const deps: Partial<SenderSessionDeps> = {
    clock,
    getIceConfig: async () => iceConfig,
    loadPeerRuntime: async () => ({ default: FakePeer as never }),
    createPeerId: () => 'peer-test-id',
    requestShareCode: async (input) => {
      requestCalls.push(input as unknown as Record<string, unknown>);
      return {
        status: 'ok',
        code: 'TEST01',
        expiresAt: 0,
        peerId: input.peerId,
        secret: 'secret-0123456789abcdef',
        secretHash: 'a'.repeat(64),
      };
    },
    revokeShareSession: async (input) => {
      revokeCalls.push(input as unknown as Record<string, unknown>);
      return true;
    },
    resumeShareSession: async (input) => {
      resumeCalls.push(input as unknown as Record<string, unknown>);
      return true;
    },
    sendPauseBeacon: (url, body) => {
      beacons.push(`${url} ${body}`);
      return true;
    },
    ...overrides,
  };
  return { deps, clock, requestCalls, revokeCalls, resumeCalls, beacons };
};

test('start 登记成功后把带约束的 metadata 交给 host，open 后进入 waiting 并显示倒计时', async () => {
  const { host, log, peer } = createHost();
  const { deps, requestCalls } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '1h' });

  assert.deepEqual(log.phases.map((entry) => entry.phase), ['preparing']);
  assert.deepEqual(log.preparingStages, ['fetching_ice', 'connecting_signaling']);
  assert.equal(requestCalls.length, 1);
  assert.equal(requestCalls[0].ttlSeconds, 3600);
  assert.equal(log.metadata?.protocolVersion, P2P_PROTOCOL_VERSION);
  assert.equal(log.metadata?.constraints?.expiresAt, 3_600_000);

  peer()?.emit('open');
  assert.equal(log.phase(), 'waiting');
  assert.deepEqual(log.shareCodes, ['TEST01']);
  assert.equal(log.remainingTimes[0], '01:00:00');
});

test('登记被占用时不建信令 peer，直接给出可操作文案', async () => {
  const { host, log, peer } = createHost();
  const { deps } = createDeps({ requestShareCode: async () => ({ status: 'taken' }) });
  const session = createSenderSession(host, deps);
  const peersBefore = FakePeer.instances.length;

  await session.start({ metadata, expiryOption: '1h' });

  assert.equal(log.phase(), 'error');
  assert.equal(log.phases[log.phases.length - 1].message, '该口令已被占用，请换一个');
  assert.equal(peer(), null);
  assert.equal(FakePeer.instances.length, peersBefore);
});

test('「永久」档登记后按 renewalInterval 续期，复用同一 peerId/secret', async () => {
  const { host, log, peer } = createHost();
  const { deps, clock, requestCalls } = createDeps({ renewalIntervalMs: 1_000 });
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: 'never' });
  peer()?.emit('open');
  assert.equal(log.remainingTimes[0], '永久有效');

  clock.advance(1_000);
  await Promise.resolve();

  assert.equal(requestCalls.length, 2);
  assert.equal(requestCalls[1].requestedCode, 'TEST01');
  assert.equal(requestCalls[1].ttlSeconds, 86_400);
  assert.equal(requestCalls[1].secret, 'secret-0123456789abcdef');
});

test('TTL 到期且没有在途传输时停止分享并进入 error', async () => {
  const { host, log, peer } = createHost();
  const { deps, clock, revokeCalls } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  const startedPeer = peer();
  startedPeer?.emit('open');
  clock.advance(600_000);
  await Promise.resolve();

  assert.equal(log.remainingTimes[log.remainingTimes.length - 1], '已过期');
  assert.equal(log.phase(), 'error');
  assert.equal(log.phases[log.phases.length - 1].message, '分享时间已结束');
  assert.equal(revokeCalls.length, 1);
  assert.equal(startedPeer?.destroyed, true);
  // 到期必须交回组件走完整的 stopSharing，再写 error；否则等待页会留着已注销的口令。
  assert.equal(log.shareEnded, 1);
  assert.ok(log.order.indexOf('shareEnded') < log.order.lastIndexOf('phase:error'));
});

test('TTL 到期但有在途传输时只注销口令，不中断传输', async () => {
  const { host, log, peer, setActiveTransfers } = createHost();
  const { deps, clock, revokeCalls } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');
  setActiveTransfers(1);
  clock.advance(600_000);
  await Promise.resolve();

  assert.equal(revokeCalls.length, 1);
  assert.deepEqual(log.notifications.map((entry) => entry.message), ['分享已过期，当前传输将继续完成']);
  assert.ok(log.events.includes('share_expired_transfer_continues'));
  assert.notEqual(log.phase(), 'error');
  assert.equal(peer()?.destroyed, false);
});

test('pause 发出延迟注销 beacon，resume 失败时提示并回传 onSessionLost', async () => {
  const { host, log, peer } = createHost();
  let resumeAttempts = 0;
  const { deps, beacons } = createDeps({
    resumeShareSession: async () => {
      resumeAttempts += 1;
      return false;
    },
  });
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '1h' });
  peer()?.emit('open');

  session.pause();
  assert.equal(beacons.length, 1);
  assert.match(beacons[0], /^\/api\/share-code\/TEST01\/revoke /);
  assert.match(beacons[0], /"graceMs":60000/);

  await session.resume();

  assert.equal(resumeAttempts, 1);
  assert.deepEqual(log.notifications.map((entry) => entry.message), ['分享已失效，请重新创建']);
  assert.equal(log.sessionLost, 1);
});

test('resume 失败但仍有在途传输时不走 onSessionLost', async () => {
  const { host, log, peer, setActiveTransfers } = createHost();
  const { deps } = createDeps({ resumeShareSession: async () => false });
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '1h' });
  peer()?.emit('open');
  setActiveTransfers(1);

  session.pause();
  await session.resume();

  // 走 onSessionLost 会触发 stopSharing 并广播 TRANSFER_CANCELLED，把还能跑完的
  // 传输直接掐断；延迟注销窗口过期只应该影响「新观众还能不能加入」。
  assert.deepEqual(log.notifications.map((entry) => entry.message), [
    '分享已失效，当前传输不受影响；需要继续分享请重新创建',
  ]);
  assert.equal(log.notifications[0].type, 'info');
  assert.equal(log.remainingTimes.includes('已失效'), true);
  assert.equal(log.sessionLost, 0);
  assert.equal(peer()?.destroyed, false);
});

test('暂停期间页面恢复且 resume 成功时不打扰用户', async () => {
  const { host, log, peer } = createHost();
  const { deps, resumeCalls } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '1h' });
  peer()?.emit('open');

  session.pause();
  await session.resume();

  assert.equal(resumeCalls.length, 1);
  assert.deepEqual(log.notifications, []);
  assert.equal(log.sessionLost, 0);
});

test('stop 之后迟到的登记会被静默注销，不写回 host', async () => {
  const { host, log } = createHost();
  const deferred: { resolve: ((value: unknown) => void) | null } = { resolve: null };
  const { deps, revokeCalls } = createDeps({
    requestShareCode: () => new Promise((resolve) => { deferred.resolve = resolve; }) as never,
  });
  const session = createSenderSession(host, deps);

  const started = session.start({ metadata, expiryOption: '1h' });
  await Promise.resolve();
  await Promise.resolve();
  session.stop();
  deferred.resolve?.({
    status: 'ok',
    code: 'LATE01',
    expiresAt: 0,
    peerId: 'peer-test-id',
    secret: 'secret-0123456789abcdef',
    secretHash: 'b'.repeat(64),
  });
  await started;

  assert.equal(log.shareCodes.length, 0);
  assert.equal(log.phase() !== 'waiting', true);
  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0].code, 'LATE01');
});

test('信令建连超时会复用已登记的口令重试，耗尽后注销并提示', async () => {
  const { host, log } = createHost();
  const { deps, clock, requestCalls, revokeCalls } = createDeps();
  const session = createSenderSession(host, deps);
  const peersBefore = FakePeer.instances.length;

  await session.start({ metadata, expiryOption: '1h' });
  const firstPeer = FakePeer.instances[peersBefore];
  assert.ok(firstPeer);

  clock.advance(10_000);
  await Promise.resolve();
  await Promise.resolve();

  // 重试复用同一 peerId/secret，不能再打一次登记接口（那会多烧一次口令预算）。
  assert.equal(requestCalls.length, 1);
  assert.equal(firstPeer.destroyed, true);
  const secondPeer = FakePeer.instances[peersBefore + 1];
  assert.ok(secondPeer);
  assert.equal(secondPeer.id, 'peer-test-id');
  assert.equal(log.events.filter((event) => event === 'signaling_open_timeout').length, 1);

  clock.advance(10_000);
  // 最终失败要等 release() 的 DELETE 落地后才写 error，这里多放几个微任务。
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();

  assert.equal(log.events.filter((event) => event === 'signaling_open_timeout').length, 2);
  assert.equal(revokeCalls.length, 1);
  assert.equal(log.phase(), 'error');
  assert.equal(log.phases[log.phases.length - 1].message, '准备传输节点超时，请重试');
});

test('登记返回时组件已标记不可用：注销口令且不建信令 peer', async () => {
  const { host, log, setUnavailable } = createHost();
  const { deps, revokeCalls } = createDeps({
    requestShareCode: async (input) => {
      setUnavailable(true);
      return {
        status: 'ok',
        code: 'GONE01',
        expiresAt: 0,
        peerId: input.peerId,
        secret: 'secret-0123456789abcdef',
        secretHash: 'c'.repeat(64),
      };
    },
  });
  const session = createSenderSession(host, deps);
  const peersBefore = FakePeer.instances.length;

  await session.start({ metadata, expiryOption: '1h' });

  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0].code, 'GONE01');
  assert.equal(log.shareCodes.length, 0);
  assert.equal(FakePeer.instances.length, peersBefore);
});

test('stop 与 dispose 清掉全部定时器和生命周期监听', async () => {
  const { host, peer } = createHost();
  const { deps, clock } = createDeps();
  const session = createSenderSession(host, deps);

  session.attachLifecycleListeners();
  assert.equal(domListeners.size, 3);

  await session.start({ metadata, expiryOption: '1h' });
  peer()?.emit('open');
  assert.ok(clock.intervalCount > 0, '倒计时应在跑');

  session.stop();
  await Promise.resolve();
  assert.equal(clock.intervalCount, 0);

  session.dispose();
  assert.equal(domListeners.size, 0);
});

test('重连被拒进入 configuring 后停掉 TTL 倒计时，不会把重试表单清空', async () => {
  const { host, log, peer } = createHost();
  const { deps, clock } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');
  const intervalsAfterOpen = clock.intervalCount;
  assert.ok(intervalsAfterOpen > 0);

  peer()?.emit('error', { type: 'unavailable-id' });
  assert.equal(log.phase(), 'configuring');
  assert.deepEqual(log.connectionFailures, ['code_unavailable']);
  // 只该少掉倒计时这一个；ICE 刷新在口令仍登记时继续跑。
  assert.equal(clock.intervalCount, intervalsAfterOpen - 1);

  clock.advance(600_000);
  await Promise.resolve();
  assert.equal(log.shareEnded, 0);
  assert.notEqual(log.phase(), 'error');
});

test('信令层明确拒绝后进入 error 并停掉倒计时', async () => {
  const { host, log, peer } = createHost();
  const { deps, clock, revokeCalls } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');

  peer()?.emit('error', { type: 'rate-limited' });
  await Promise.resolve();

  assert.deepEqual(log.connectionFailures, ['rate_limited']);
  assert.equal(log.phases[log.phases.length - 1].message, getPeerRuntimeErrorMessage('rate-limited'));
  assert.equal(revokeCalls.length, 1);
  assert.equal(clock.intervalCount, 0);

  clock.advance(600_000);
  await Promise.resolve();
  assert.equal(log.shareEnded, 0, '已经 error 了就不该再触发「分享已结束」');
  assert.equal(log.phases[log.phases.length - 1].message, getPeerRuntimeErrorMessage('rate-limited'));
});

test('network 类错误不改变状态，倒计时继续并在到期时正常结束', async () => {
  const { host, log, peer } = createHost();
  const { deps, clock } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');

  peer()?.emit('error', { type: 'network' });
  assert.equal(log.phase(), 'waiting');
  assert.ok(clock.intervalCount > 0, 'network 抖动不该把倒计时停掉');

  clock.advance(600_000);
  await Promise.resolve();
  assert.equal(log.shareEnded, 1);
});

test('无活动连接时的通用 peer 错误进入 error 且停掉倒计时', async () => {
  const { host, log, peer } = createHost();
  const { deps, clock, revokeCalls } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');

  peer()?.emit('error', { type: 'socket-closed' });
  await Promise.resolve();

  assert.equal(log.phase(), 'error');
  assert.deepEqual(log.connectionFailures, ['peer_error:socket-closed']);
  assert.equal(log.peerErrors.length, 1);
  assert.equal(revokeCalls.length, 1);
  assert.equal(clock.intervalCount, 0);
  assert.equal(log.phases[log.phases.length - 1].message, getPeerRuntimeErrorMessage('socket-closed'));
});

test('有在途传输时信令终态只降级状态位，不打错误页（否则传输列表消失）', async () => {
  const { host, log, peer, setActiveConnections } = createHost();
  const { deps } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');
  log.connectionStatuses.length = 0;
  setActiveConnections(1);

  peer()?.emit('error', { type: 'unauthorized' });
  await Promise.resolve();

  assert.deepEqual(log.connectionStatuses, [SHARE_SIGNALING_LOST_MESSAGE]);
  assert.notEqual(log.phase(), 'error', '有在途传输时不能把 UI 打到错误页');
  // 倒计时可以继续走完（到期时会把状态标成「已失效」），但不能立刻触发分享结束。
  assert.equal(log.shareEnded, 0);
});

test('限流且已有连接在传时不进 error：提示链接失效但保留传输视图', async () => {
  const { host, log, peer, setActiveConnections } = createHost();
  const { deps } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');
  log.connectionStatuses.length = 0;
  setActiveConnections(2);

  peer()?.emit('error', { type: 'rate-limited' });
  await Promise.resolve();

  assert.deepEqual(log.connectionStatuses, [SHARE_SIGNALING_LOST_MESSAGE]);
  // 同一句话已经落在状态位和链接下方的常驻提示里。再弹一条 toast 就是第三次复述，
  // 用户会以为连续出了两个故障；这里钉住「只写状态，不弹 toast」。
  assert.deepEqual(log.notifications, []);
  assert.notEqual(log.phase(), 'error');
});

test('信令恢复（signaling:restored）会清掉降级状态位，不留一条过期提示', async () => {
  const { host, log, peer, setActiveConnections } = createHost();
  const { deps } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');
  setActiveConnections(1);
  peer()?.emit('error', { type: 'unauthorized' });
  await Promise.resolve();
  assert.equal(log.connectionStatuses[log.connectionStatuses.length - 1], SHARE_SIGNALING_LOST_MESSAGE);

  // peerRuntime 的 'open' 只会在首次注册时发一次，自动重连成功走的是
  // 'signaling:restored'；这里必须用它，重发 'open' 的旧断言掩盖了真实缺口。
  peer()?.emit('signaling:restored');
  assert.equal(log.connectionStatuses[log.connectionStatuses.length - 1], '');
});

test('口令被注销后降级位要留下来：作废是持久事实，不能跟着 30 秒提示一起消失', async () => {
  const { host, log, peer, setActiveConnections } = createHost();
  const { deps } = createDeps();
  const session = createSenderSession(host, deps);

  await session.start({ metadata, expiryOption: '10m' });
  peer()?.emit('open');
  setActiveConnections(1);

  peer()?.emit('error', { type: 'unauthorized' });
  await Promise.resolve();

  assert.equal(log.shareRevoked.at(-1), SHARE_SIGNALING_LOST_MESSAGE);
  assert.notEqual(log.phase(), 'error', '有在途传输时不能把传输列表撤掉');

  peer()?.emit('signaling:restored');
  assert.equal(log.shareRevoked.at(-1), null, '信令恢复后必须清掉降级位，否则界面一直说链接失效');
});

test('重新开始分享不会继承上一轮的降级位', async () => {
  const { host, log, peer, setActiveConnections } = createHost();
  const { deps } = createDeps();
  const session = createSenderSession(host, deps);
  await session.start({ metadata, expiryOption: '10m' });
  setActiveConnections(1);
  peer()?.emit('error', { type: 'unauthorized' });
  await Promise.resolve();
  assert.equal(log.shareRevoked.at(-1), SHARE_SIGNALING_LOST_MESSAGE);

  await session.start({ metadata, expiryOption: '10m' });
  assert.equal(log.shareRevoked.at(-1), null, '新口令不能继承上一轮的失效提示');
});

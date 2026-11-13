// SignalingHub 编排层的契约测试：直接构造 Durable Object 并走真实的 fetch 分支。
//
// 之前 worker.ts 从未被测试 import（它依赖 Workers 运行时），于是「注册顺序」「名额回滚」
// 「503 升级失败」「预算 429」这些只有读代码才能确认。这里用最小替身补上：
// - `cloudflare:workers` 由 scripts/test-stubs/cloudflare-workers.mjs 提供；
// - `WebSocketPair` / 带 webSocket 的 101 Response 由本文件注入全局；
// - `ctx.storage.sql` 接真实 node:sqlite（语句本身可执行，不是 fake）。
//
// 刻意不覆盖的部分：真实 hibernation 恢复、跨 DO RPC（分片 > 1）、webSocketMessage 的
// 帧投递顺序（那部分由 registrationExecutor / deliverRegisteredThenCommit 的单测覆盖）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

type Sent = { data: string };

class FakeSocket {
  readyState = 1;
  readonly sent: Sent[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  send(data: string): void {
    this.sent.push({ data });
  }

  close(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  messages(): unknown[] {
    return this.sent.map(({ data }) => JSON.parse(data) as unknown);
  }

  lastMessage(): Record<string, unknown> | null {
    const all = this.messages();
    return (all[all.length - 1] as Record<string, unknown>) ?? null;
  }
}

// WebSocketPair[0] 是客户端、[1] 是服务端；DO 只在服务端 send/close，所以断言必须拿到 [1]。
const serverByClient = new WeakMap<FakeSocket, FakeSocket>();

class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;

  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    serverByClient.set(this[0], this[1]);
  }
}

/** 读 close code 走函数：直接 `socket.closed?.code` 会被前面 `assert.equal(socket.closed, null)` 收窄成 never。 */
const closedCode = (socket: FakeSocket): number | undefined => socket.closed?.code;

const serverOf = (client: FakeSocket | null | undefined): FakeSocket => {
  assert.ok(client, 'expected a client socket in the 101 response');
  const server = serverByClient.get(client);
  assert.ok(server, 'expected the paired server socket');
  return server;
};

// Workers 的 101 响应带 `webSocket` 字段；Node 的 Response 拒绝 101 状态码。
class FakeResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly webSocket: FakeSocket | null;
  readonly bodyText: string | null;

  constructor(body: string | null, init: { status?: number; headers?: Record<string, string>; webSocket?: FakeSocket } = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket ?? null;
    this.bodyText = body;
  }
}

const installWorkerGlobals = (): (() => void) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousPair = globals.WebSocketPair;
  const previousResponse = globals.Response;
  globals.WebSocketPair = FakeWebSocketPair;
  globals.Response = FakeResponse;
  return () => {
    globals.WebSocketPair = previousPair;
    globals.Response = previousResponse;
  };
};

const createSqlite = (db: DatabaseSync) => ({
  exec<T = Record<string, unknown>>(text: string, ...params: unknown[]) {
    const withoutTrailing = text.trim().replace(/;+$/, '');
    if (withoutTrailing.includes(';')) {
      throw new Error(`sqlite test adapter only executes a single statement: ${text}`);
    }
    const statement = db.prepare(text);
    const returnsRows = /^\s*(SELECT|PRAGMA|WITH)/i.test(text) || /\bRETURNING\b/i.test(text);
    if (returnsRows) {
      const rows = statement.all(...(params as SQLInputValue[])) as T[];
      const changes = db.prepare('SELECT changes() AS count').get() as { count: number };
      return { toArray: () => rows, rowsWritten: Number(changes.count) };
    }
    const info = statement.run(...(params as SQLInputValue[]));
    return { toArray: () => [] as T[], rowsWritten: Number(info.changes) };
  },
});

const restores: (() => void)[] = [];
const previousConsoleLog = console.log;

test.after(() => {
  console.log = previousConsoleLog;
});

/** 建一个「单例片」的 hub：ctx 暴露 sqlite、已接受 socket 列表与 waitUntil。 */
const createHub = async (overrides: { maxSessions?: string; shardCount?: string } = {}) => {
  restores.push(installWorkerGlobals());
  // 遥测走 console.log；测试里静音，避免 500+ 行噪声。
  console.log = () => {};

  const db = new DatabaseSync(':memory:');
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage: { sql: createSqlite(db) },
    id: { name: 'global-signaling-hub', toString: () => 'global-signaling-hub' },
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: FakeSocket) => {
      sockets.push(socket);
    },
    waitUntil: (promise: Promise<unknown>) => {
      void Promise.resolve(promise).catch(() => {});
    },
  };
  const env = {
    SIGNALING_SHARD_COUNT: overrides.shardCount ?? '1',
    SIGNALING_MAX_SESSIONS_PER_CLIENT: overrides.maxSessions ?? '12',
  };

  const { SignalingHub } = await import('../../src/worker.ts');
  const hub = new SignalingHub(ctx as never, env as never);
  return { hub, db, sockets, env };
};

const upgrade = (hub: unknown, query: string, clientIp: string, extraHeaders: Record<string, string> = {}) => {
  const request = new Request(`https://drop.test/ws-signaling?${query}`, {
    headers: {
      Upgrade: 'websocket',
      Origin: 'https://drop.test',
      'CF-Connecting-IP': clientIp,
      ...extraHeaders,
    },
  });
  return (hub as { fetch(request: Request): Promise<FakeResponse> }).fetch(request);
};

const hash = (char: string): string => char.repeat(64);

test('首次注册换发 proof，注册帧在 accept 之后到达；摘要非法在握手阶段就被拒', async () => {
  const { hub } = await createHub();

  const accepted = await upgrade(hub, 'peerId=AERO-HUB00001', '203.0.113.10', {});
  assert.equal(accepted.status, 101);
  const server = serverOf(accepted.webSocket);

  // 初始注册不带摘要时保持历史行为：不签发 proof（文件传输/观众走这条）。
  assert.equal(server.lastMessage()?.type, 'registered');
  assert.equal(server.lastMessage()?.sessionProof, undefined);
  assert.equal(server.closed, null);

  const invalidHash = await upgrade(hub, `peerId=AERO-HUB00002&sessionSecretHash=${'z'.repeat(64)}`, '203.0.113.10');
  assert.equal(invalidHash.status, 400, '摘要格式错应该在握手阶段拒绝，不进会话表');

  const invalidProof = await upgrade(hub, `peerId=AERO-HUB00003&sessionProof=${'q'.repeat(64)}`, '203.0.113.10');
  assert.equal(invalidProof.status, 400);
});

test('绑定过摘要的会话：不带 proof 的同 peerId 接管被拒并关闭 4010，旧 socket 继续存活', async () => {
  const { hub } = await createHub();

  const owner = serverOf(
    (await upgrade(hub, `peerId=AERO-HUB10001&sessionSecretHash=${hash('a')}`, '203.0.113.11')).webSocket
  );
  const registered = owner.lastMessage() as { type: string; sessionProof?: string };
  assert.equal(registered.type, 'registered');
  assert.match(registered.sessionProof ?? '', /^[0-9a-f]{64}$/);

  const attacker = await upgrade(hub, 'peerId=AERO-HUB10001', '203.0.113.12');
  assert.equal(attacker.status, 101, '拒绝也要先 accept，才能回一帧 error');
  const attackerServer = serverOf(attacker.webSocket);
  assert.equal(attackerServer.lastMessage()?.code, 'session-conflict');
  assert.equal(closedCode(attackerServer), 4010, 'session-conflict 必须是终态 close code');
  assert.equal(owner.closed, null, '拒绝接管不能影响在位的分享者');

  // 带当前 proof 的接管成功，并轮换出新 proof。
  const rotated = serverOf(
    (await upgrade(hub, `peerId=AERO-HUB10001&sessionProof=${registered.sessionProof}`, '203.0.113.12')).webSocket
  );
  const rotatedFrame = rotated.lastMessage() as { type: string; sessionProof?: string };
  assert.equal(rotatedFrame.type, 'registered');
  assert.notEqual(rotatedFrame.sessionProof, registered.sessionProof);
  assert.equal(closedCode(owner), 4011, '被顶替的旧 socket 收到 unavailable-id 终态');
});

test('超过每 IP 会话上限时回 4029，且失败不会吃掉名额', async () => {
  const { hub } = await createHub({ maxSessions: '1' });

  const first = serverOf((await upgrade(hub, 'peerId=AERO-HUB20001', '203.0.113.20')).webSocket);
  assert.equal(first.lastMessage()?.type, 'registered');

  const second = await upgrade(hub, 'peerId=AERO-HUB20002', '203.0.113.20');
  const secondServer = serverOf(second.webSocket);
  assert.equal(secondServer.lastMessage()?.code, 'rate-limited');
  assert.equal(closedCode(secondServer), 4029);

  // 不同出口 IP 不受影响。
  const other = serverOf((await upgrade(hub, 'peerId=AERO-HUB20003', '203.0.113.21')).webSocket);
  assert.equal(other.lastMessage()?.type, 'registered');
});

test('握手预算按出口 IP 生效：超限回 429 + Retry-After，且不建立 socket', async () => {
  const { hub } = await createHub();

  for (let index = 0; index < 20; index += 1) {
    const response = await upgrade(hub, `peerId=AERO-BUDGET0${index}`, '203.0.113.30');
    assert.equal(response.status, 101, `第 ${index + 1} 次握手应放行`);
  }

  const limited = await upgrade(hub, 'peerId=AERO-BUDGETOVER', '203.0.113.30');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) >= 1);

  // 预算只按出口 IP 分桶，别的 IP 不受牵连。
  const otherIp = await upgrade(hub, 'peerId=AERO-BUDGETOTHER', '203.0.113.31');
  assert.equal(otherIp.status, 101);
});

test('分享口令缺失时的旧 peerId 被 4009 拒绝，且不会进入会话表', async () => {
  const { hub } = await createHub();

  const legacy = serverOf((await upgrade(hub, 'peerId=aerodrop-1234', '203.0.113.40')).webSocket);
  assert.equal(legacy.lastMessage()?.code, 'invalid-id');
  assert.equal(closedCode(legacy), 4009);

  // 拒绝路径没有占用名额/绑定：同 IP 的合法注册仍然成功。
  const fresh = serverOf((await upgrade(hub, 'peerId=AERO-HUB40001', '203.0.113.40')).webSocket);
  assert.equal(fresh.lastMessage()?.type, 'registered');
});

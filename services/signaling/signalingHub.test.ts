// SignalingHub 编排层的契约测试：直接构造 Durable Object 并走真实的 fetch 分支。
//
// 之前 worker.ts 从未被测试 import（它依赖 Workers 运行时），于是「注册顺序」「名额回滚」
// 「503 升级失败」「预算 429」这些只有读代码才能确认。这里用最小替身补上：
// - `cloudflare:workers` 由 scripts/test-stubs/cloudflare-workers.mjs 提供；
// - `WebSocketPair` / 带 webSocket 的 101 Response 由本文件注入全局；
// - `ctx.storage.sql` 接真实 node:sqlite（语句本身可执行，不是 fake）。
//
// 替身语义按真实 Workers 收紧：101 响应必须带 webSocket，未 acceptWebSocket 的 socket
// 不允许 send——否则「先 send 后 accept」「101 漏了 webSocket」这类回归会被静默放过。
// 仍然不覆盖：真实 hibernation 恢复（构造期从 attachment 还原 session）与多 isolate 的
// 调度时序。
//
// 投递相关的用例在拿不到内部状态时一律断言「可观测结果」：目标 socket 收到了什么、
// 调用方 socket 收到了什么、SQLite 里的槽位行、以及 console 里的 signaling_metric 行。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlite } from '../../scripts/test-stubs/sqlite-adapter.ts';

import {
  SIGNALING_SESSION_SLOT_REFRESH_MS,
  SIGNALING_SESSION_SLOT_TTL_MS,
} from '../../constants/signaling.ts';
import { MAX_SIGNALING_MESSAGES_PER_WINDOW } from '../signalingRateLimitPolicy.ts';
import { rendezvousShardIndex } from './shardRouting.ts';
import { applySessionSlotRelease, applySessionSlotReserve } from './sessionStore.ts';

type Sent = { data: string };

class FakeSocket {
  readyState = 1;
  /** ctx.acceptWebSocket 是否已经认领过这条 socket。 */
  accepted = false;
  readonly sent: Sent[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  markAccepted(): void {
    this.accepted = true;
  }

  send(data: string): void {
    // Workers 只允许向 acceptWebSocket 认领过的 socket 发帧。替身照此拒绝，
    // 「先 send 后 accept」的顺序回归才会变红而不是静默通过。
    if (!this.accepted) throw new Error('FakeSocket.send called before acceptWebSocket');
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

  messages(): Record<string, unknown>[] {
    return this.sent.map(({ data }) => JSON.parse(data) as Record<string, unknown>);
  }

  lastMessage(): Record<string, unknown> | null {
    const all = this.messages();
    return all[all.length - 1] ?? null;
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
    // 真正的 Workers 里 101 必须携带 webSocket，否则这次升级不会被当成 WS 请求投递。
    if (this.status === 101 && this.webSocket === null) {
      throw new Error('101 response is missing webSocket');
    }
    if (this.status === 101 && this.bodyText !== null) {
      throw new Error('101 response must not carry a body');
    }
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async json(): Promise<unknown> {
    return this.bodyText === null ? null : (JSON.parse(this.bodyText) as unknown);
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

const restores: (() => void)[] = [];
const previousConsoleLog = console.log;
const previousConsoleWarn = console.warn;

test.after(() => {
  // 每个 createHub 都装了全局替身（WebSocketPair/Response 与 console）。不收回会污染
  // 同进程后续测试文件：那里看到的 101 Response 会变成 FakeResponse。
  while (restores.length > 0) restores.pop()?.();
  console.log = previousConsoleLog;
  console.warn = previousConsoleWarn;
});

type RpcCall = { shardName: string; url: string; body: unknown };
type RpcResult = { status: number; body: unknown };

/** 建一个 hub：ctx 暴露 sqlite、已接受 socket 列表、waitUntil 收集器与遥测捕获。 */
const createHub = async (overrides: {
  maxSessions?: string;
  shardCount?: string;
  shardName?: string;
  /**
   * 分片数 > 1 时 shard 0 之外的 DO 替身；不传时跨片 RPC 会直接抛错（RPC 失败路径）。
   * `respond` 可以返回 promise：交错竞态用例需要在 RPC 在途期间启动另一个注册。
   */
  signalingHub?: { respond: (call: RpcCall) => RpcResult | Promise<RpcResult> };
  /** 模拟 DO 唤醒：构造前 ctx.getWebSockets() 里已经有 socket，attachment 是唯一状态来源。 */
  restored?: { socket: FakeSocket; attachment: Record<string, unknown> }[];
} = {}) => {
  restores.push(installWorkerGlobals());

  // 遥测走 console.log；测试里既静音（避免 500+ 行噪声）又留档（用于断言指标）。
  const logs: string[] = [];
  const record = (prefix: string) => (...args: unknown[]) => {
    logs.push(prefix + args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  console.log = record('');
  console.warn = record('warn ');

  const db = new DatabaseSync(':memory:');
  const sockets: FakeSocket[] = [];
  const pending: Promise<unknown>[] = [];
  const rpcCalls: RpcCall[] = [];
  const shardName = overrides.shardName ?? 'global-signaling-hub';

  const ctx = {
    storage: { sql: createSqlite(db) },
    id: { name: shardName, toString: () => shardName },
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: FakeSocket) => {
      socket.markAccepted();
      sockets.push(socket);
    },
    // 投递链、名额释放、槽位续期都挂在 waitUntil 上；收集起来由 settle() 等干净。
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(Promise.resolve(promise).catch(() => {}));
    },
  };
  const env: Record<string, unknown> = {
    SIGNALING_SHARD_COUNT: overrides.shardCount ?? '1',
    SIGNALING_MAX_SESSIONS_PER_CLIENT: overrides.maxSessions ?? '12',
  };
  if (overrides.signalingHub) {
    const respond = overrides.signalingHub.respond;
    env.SIGNALING_HUB = {
      idFromName: (name: string) => name,
      get: (targetShardName: string) => ({
        fetch: async (request: Request) => {
          const text = await request.text();
          const call: RpcCall = {
            shardName: targetShardName,
            url: request.url,
            body: text ? (JSON.parse(text) as unknown) : null,
          };
          rpcCalls.push(call);
          const result = await respond(call);
          return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            async json() {
              return result.body;
            },
          };
        },
      }),
    };
  }

  // 唤醒还原发生在构造函数里，所以必须在 new 之前把 socket 放进 getWebSockets()。
  for (const restoredSocket of overrides.restored ?? []) {
    restoredSocket.socket.markAccepted();
    restoredSocket.socket.serializeAttachment(restoredSocket.attachment);
    sockets.push(restoredSocket.socket);
  }

  const { SignalingHub } = await import('../../src/worker.ts');
  const hub = new SignalingHub(ctx as never, env as never);

  /** 等所有 waitUntil 尾巴跑完（跨片投递链、槽位释放/续期）。 */
  const settle = async (): Promise<void> => {
    for (let guard = 0; guard < 10 && pending.length > 0; guard += 1) {
      await Promise.all(pending.splice(0));
    }
  };

  const metrics = (): { event: string; [key: string]: unknown }[] =>
    logs
      .filter((line) => line.startsWith('signaling_metric '))
      .map((line) => JSON.parse(line.slice('signaling_metric '.length)) as { event: string; [key: string]: unknown });

  return { hub, db, sockets, env, logs, metrics, rpcCalls, settle };
};

type Hub = Awaited<ReturnType<typeof createHub>>['hub'];

const upgrade = (
  hub: Hub,
  query: string,
  clientIp: string,
  extraHeaders: Record<string, string> = {}
): Promise<FakeResponse> => {
  const request = new Request(`https://drop.test/ws-signaling?${query}`, {
    headers: {
      Upgrade: 'websocket',
      Origin: 'https://drop.test',
      'CF-Connecting-IP': clientIp,
      ...extraHeaders,
    },
  });
  return (hub as { fetch(request: Request): Promise<Response> }).fetch(request) as unknown as Promise<FakeResponse>;
};

const sendFrame = (hub: Hub, socket: FakeSocket, frame: Record<string, unknown>): Promise<void> =>
  hub.webSocketMessage(socket as never, JSON.stringify(frame));

const hash = (char: string): string => char.repeat(64);

const readSlotRows = (
  db: DatabaseSync
): { slot_id: string; client_key: string; expires_at: number }[] =>
  db
    .prepare('SELECT slot_id, client_key, expires_at FROM signaling_session_slots')
    .all() as unknown as { slot_id: string; client_key: string; expires_at: number }[];

/** 找一个 rendezvous 到指定分片的 peerId：分片路由是确定性的，不能靠猜。 */
const peerIdOnShard = (shard: number, prefix: string): string => {
  for (let index = 0; index < 1000; index += 1) {
    const candidate = `${prefix}${String(index).padStart(2, '0')}`;
    if (rendezvousShardIndex(candidate, 2) === shard) return candidate;
  }
  throw new Error(`no peerId routes to shard ${shard}`);
};

test('首次注册换发 proof，注册帧在 accept 之后到达；摘要非法在握手阶段就被拒', async () => {
  const { hub } = await createHub();

  const accepted = await upgrade(hub, 'peerId=AERO-HUB00001', '203.0.113.10', {});
  assert.equal(accepted.status, 101);
  const server = serverOf(accepted.webSocket);
  assert.equal(server.accepted, true, '101 返回前必须已经 acceptWebSocket');

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

test('webSocketMessage：offer 只投到目标的 server socket，目标离线时回 peer-unavailable', async () => {
  const { hub, settle } = await createHub();

  const sender = serverOf((await upgrade(hub, 'peerId=AERO-DELIV000A', '203.0.113.50')).webSocket);
  const target = serverOf((await upgrade(hub, 'peerId=AERO-DELIV000B', '203.0.113.50')).webSocket);
  assert.equal(sender.lastMessage()?.type, 'registered');
  assert.equal(target.lastMessage()?.type, 'registered');
  assert.equal(sender.accepted, true, '未 acceptWebSocket 的 socket 连 registered 帧都发不出去');

  const senderFramesBefore = sender.sent.length;
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: 'AERO-DELIV000B',
    connectionId: 'conn-1',
    kind: 'data',
    sdp: 'v=0',
  });
  await settle();

  const delivered = target.lastMessage();
  assert.equal(delivered?.type, 'offer', 'B 的 server socket 必须收到这条 offer');
  assert.equal(delivered?.sourcePeerId, 'AERO-DELIV000A', '投递时必须补上来源 peerId');
  assert.equal(delivered?.connectionId, 'conn-1');
  assert.equal(sender.sent.length, senderFramesBefore, '发送方不该收到自己发出的帧');

  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: 'AERO-OFFLINE01',
    connectionId: 'conn-2',
    kind: 'data',
  });
  await settle();

  assert.equal(sender.sent.length, senderFramesBefore + 1, '目标离线只回一帧 error');
  const error = sender.lastMessage();
  assert.equal(error?.type, 'error');
  assert.equal(error?.code, 'peer-unavailable');
  assert.equal(error?.connectionId, 'conn-2', 'peer-unavailable 必须带回原 connectionId');
  assert.equal(error?.targetPeerId, 'AERO-OFFLINE01');
});

test('webSocketClose：只释放自己的席位，另一个 socket 的 sessionsByPeer 条目不能被误删', async () => {
  const { hub, settle } = await createHub({ maxSessions: '2' });

  const closed = serverOf((await upgrade(hub, 'peerId=AERO-CLOSE00A', '203.0.113.51')).webSocket);
  const kept = serverOf((await upgrade(hub, 'peerId=AERO-CLOSE00B', '203.0.113.51')).webSocket);

  hub.webSocketClose(closed as never);
  await settle();

  const third = serverOf((await upgrade(hub, 'peerId=AERO-CLOSE00C', '203.0.113.51')).webSocket);
  assert.equal(third.lastMessage()?.type, 'registered', '关闭一条会话后应刚好回收一个席位');

  const fourth = await upgrade(hub, 'peerId=AERO-CLOSE00D', '203.0.113.51');
  assert.equal(
    serverOf(fourth.webSocket).lastMessage()?.code,
    'rate-limited',
    '一次关闭只能回收一个席位，不能把仍在位的会话一起算掉'
  );

  await sendFrame(hub, third, { type: 'offer', targetPeerId: 'AERO-CLOSE00B', connectionId: 'keep-b', kind: 'data' });
  await settle();
  assert.equal(kept.lastMessage()?.type, 'offer', 'A 的关闭事件不能删掉 B 的 sessionsByPeer 条目');
  assert.equal(kept.closed, null);

  await sendFrame(hub, third, { type: 'offer', targetPeerId: 'AERO-CLOSE00A', connectionId: 'gone-a', kind: 'data' });
  await settle();
  assert.equal(
    third.lastMessage()?.code,
    'peer-unavailable',
    '已关闭的 socket 必须已经从 sessionsByPeer 里移除'
  );
});

test('被顶替的旧 socket 关闭时不影响新会话：席位/槽位不重复释放，sessionsByPeer 不被删', async () => {
  const { hub, db, settle } = await createHub({ shardCount: '2', maxSessions: '1' });

  const owner = serverOf(
    (await upgrade(hub, `peerId=AERO-TAKEOV01&sessionSecretHash=${hash('b')}`, '203.0.113.52')).webSocket
  );
  const proof = (owner.lastMessage() as { sessionProof?: string }).sessionProof;
  assert.match(proof ?? '', /^[0-9a-f]{64}$/);

  const replacement = serverOf(
    (await upgrade(hub, `peerId=AERO-TAKEOV01&sessionProof=${proof}`, '203.0.113.52')).webSocket
  );
  assert.equal(closedCode(owner), 4011, '接管先由 fetch 完成，旧 socket 收到 unavailable-id');
  assert.equal(replacement.lastMessage()?.type, 'registered');
  // 接管是「转移」：槽位行仍是同一条，只是归属换成了新 socket。
  assert.equal(readSlotRows(db).length, 1);

  // 真实顺序：eject 发生在 fetch 里，旧 socket 的 close 事件随后才到 DO。
  hub.webSocketClose(owner as never);
  await settle();
  assert.equal(
    readSlotRows(db).length,
    1,
    '旧 socket 的 close 不能释放已经转移给新会话的槽位（否则 6h TTL 的名额提前消失）'
  );

  const sender = serverOf((await upgrade(hub, 'peerId=AERO-TAKEOV02', '203.0.113.53')).webSocket);
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: 'AERO-TAKEOV01',
    connectionId: 'to-replacement',
    kind: 'data',
  });
  await settle();
  assert.equal(replacement.lastMessage()?.type, 'offer', '旧 socket 的关闭不能把新会话从 sessionsByPeer 删掉');
  assert.equal(replacement.closed, null);

  // 同 IP 的新连接必须仍然 4029：席位是从旧 socket「转移」过来的，旧 socket 关闭时若再释放
  // 一次，计数就会少 1，这里会错误地放行。
  const next = await upgrade(hub, 'peerId=AERO-TAKEOV03', '203.0.113.52');
  assert.equal(
    serverOf(next.webSocket).lastMessage()?.code,
    'rate-limited',
    '旧 socket 的关闭不能把转移给新会话的席位再释放一次'
  );
});

test('DO 唤醒还原：关闭一条与别人共享 peerId 的旧 socket，不能把在位会话从 sessionsByPeer 删掉', async () => {
  // 唤醒时只有 attachment 可读：两条 socket 都可能带着同一个 peerId（旧 socket 的
  // attachment 在接管时不会被清空），构造期还原是「后写覆盖先写」。
  const stale = new FakeSocket();
  const live = new FakeSocket();
  const { hub, settle } = await createHub({
    restored: [
      { socket: stale, attachment: { clientKey: 'ip:203.0.113.59', peerId: 'AERO-RESTORE1' } },
      { socket: live, attachment: { clientKey: 'ip:203.0.113.59', peerId: 'AERO-RESTORE1' } },
    ],
  });

  const sender = serverOf((await upgrade(hub, 'peerId=AERO-RESTORE2', '203.0.113.60')).webSocket);

  hub.webSocketClose(stale as never);
  await settle();

  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: 'AERO-RESTORE1',
    connectionId: 'wake-1',
    kind: 'data',
  });
  await settle();
  assert.equal(
    live.lastMessage()?.type,
    'offer',
    '旧 socket 的 close 不能按 peerId 无条件删表，否则在位的同 peerId 会话变成幽灵'
  );
  assert.equal(live.closed, null);
});

test('4029 失败不吃名额：同 IP 反复重试仍 4029，关闭一条会话后同 IP 可再注册', async () => {
  const { hub, settle } = await createHub({ maxSessions: '1' });

  const first = serverOf((await upgrade(hub, 'peerId=AERO-QUOTA001', '203.0.113.55')).webSocket);
  assert.equal(first.lastMessage()?.type, 'registered');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const blocked = await upgrade(hub, `peerId=AERO-QUOTA00${attempt + 2}`, '203.0.113.55');
    const server = serverOf(blocked.webSocket);
    assert.equal(server.lastMessage()?.code, 'rate-limited', `第 ${attempt + 1} 次超限重试都应被拒`);
    assert.equal(closedCode(server), 4029);
  }

  hub.webSocketClose(first as never);
  await settle();

  const afterClose = serverOf((await upgrade(hub, 'peerId=AERO-QUOTA009', '203.0.113.55')).webSocket);
  assert.equal(
    afterClose.lastMessage()?.type,
    'registered',
    '被拒的连接没有吃掉名额，关闭一条会话后同 IP 应能再注册'
  );
});

test('shard 0 的会话槽位：关闭释放自己的槽位，ping 的续期按 30 分钟节流', async () => {
  const { hub, db, settle } = await createHub({ shardCount: '2', maxSessions: '1' });
  const realNow = Date.now;
  let virtualNow = realNow();
  Date.now = () => virtualNow;
  try {
    const socket = serverOf((await upgrade(hub, 'peerId=AERO-SLOT0001', '203.0.113.54')).webSocket);
    assert.equal(socket.lastMessage()?.type, 'registered');

    const slots = readSlotRows(db);
    assert.equal(slots.length, 1, '分片模式注册必须在 shard 0 的全局名额表里占一个槽位');
    assert.equal(slots[0].expires_at, virtualNow + SIGNALING_SESSION_SLOT_TTL_MS);

    // 30 分钟节流窗口内的 ping：pong 正常返回，但槽位不做续期写入。
    const insideWindowMs = 5 * 60 * 1000;
    virtualNow += insideWindowMs;
    await sendFrame(hub, socket, { type: 'ping', ts: 11 });
    await settle();
    assert.equal(socket.lastMessage()?.type, 'pong');
    assert.equal(
      readSlotRows(db)[0].expires_at,
      virtualNow - insideWindowMs + SIGNALING_SESSION_SLOT_TTL_MS,
      '窗口内的 ping 不能写槽位（5s 一次心跳会变成写热点）'
    );

    // 到达 30 分钟后的 ping：续期生效，TTL 从此刻重新计算。
    virtualNow += SIGNALING_SESSION_SLOT_REFRESH_MS - insideWindowMs;
    await sendFrame(hub, socket, { type: 'ping', ts: 12 });
    await settle();
    assert.equal(socket.lastMessage()?.type, 'pong');
    assert.equal(readSlotRows(db)[0].expires_at, virtualNow + SIGNALING_SESSION_SLOT_TTL_MS);

    // 关闭 socket：只删自己的槽位行。
    hub.webSocketClose(socket as never);
    await settle();
    assert.equal(readSlotRows(db).length, 0, '关闭 socket 必须释放它自己的槽位');

    const reopened = serverOf((await upgrade(hub, 'peerId=AERO-SLOT0002', '203.0.113.54')).webSocket);
    assert.equal(reopened.lastMessage()?.type, 'registered', '槽位与席位都回收后同 IP 应能再注册');
  } finally {
    Date.now = realNow;
  }
});

test('跨片投递：本片直投不走 RPC；目标片 5xx / 未命中回 peer-unavailable 并记指标', async () => {
  let nextRpc: RpcResult = { status: 500, body: { delivered: false } };
  const { hub, settle, rpcCalls, metrics } = await createHub({
    shardCount: '2',
    signalingHub: { respond: () => nextRpc },
  });

  const senderPeerId = peerIdOnShard(0, 'AERO-XSHARD-A');
  const localPeerId = peerIdOnShard(0, 'AERO-XSHARD-B');
  const remotePeerId = peerIdOnShard(1, 'AERO-XSHARD-C');

  const sender = serverOf((await upgrade(hub, `peerId=${senderPeerId}`, '203.0.113.56')).webSocket);
  const localTarget = serverOf((await upgrade(hub, `peerId=${localPeerId}`, '203.0.113.56')).webSocket);
  assert.equal(localTarget.lastMessage()?.type, 'registered');

  const senderErrors = () => sender.messages().filter((frame) => frame.type === 'error');
  const crossShardFailures = () => metrics().filter((metric) => metric.event === 'signal_cross_shard_failed');

  // 1) 本片有该会话：直接投递，绝不发 RPC。
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: localPeerId,
    connectionId: 'local-1',
    kind: 'data',
  });
  await settle();
  assert.equal(localTarget.lastMessage()?.type, 'offer');
  assert.equal(rpcCalls.length, 0, '本片直投不能走跨片 RPC');

  // 2) 目标片 RPC 5xx：仍回 peer-unavailable，并按 rpc_status 记失败指标。
  nextRpc = { status: 503, body: { delivered: false } };
  const errorsBefore = senderErrors().length;
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: remotePeerId,
    connectionId: 'cross-1',
    kind: 'data',
  });
  await settle();
  assert.equal(senderErrors().length, errorsBefore + 1, '跨片失败必须让调用方收到 peer-unavailable');
  assert.equal(sender.lastMessage()?.code, 'peer-unavailable');
  assert.equal(crossShardFailures().length, 1);
  assert.equal(crossShardFailures()[0].reason, 'rpc_status');
  assert.equal(crossShardFailures()[0].status, 503);
  assert.equal(rpcCalls[0].shardName, 'signaling-shard-1', '路由必须按 peerId 的 rendezvous 结果选片');
  assert.match(rpcCalls[0].url, /\/internal\/deliver-signaling$/);

  // 3) RPC 成功但目标不在那片（delivered:false）：按 unknown_target 记账，同样回 peer-unavailable。
  nextRpc = { status: 200, body: { delivered: false } };
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: remotePeerId,
    connectionId: 'cross-2',
    kind: 'data',
  });
  await settle();
  assert.equal(crossShardFailures().length, 2);
  assert.equal(crossShardFailures()[1].reason, 'unknown_target');
  assert.equal(sender.lastMessage()?.code, 'peer-unavailable');

  // 4) 投递成功：不再回 peer-unavailable，并记 delivered 指标。
  nextRpc = { status: 200, body: { delivered: true } };
  const deliveredBefore = senderErrors().length;
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: remotePeerId,
    connectionId: 'cross-3',
    kind: 'data',
  });
  await settle();
  assert.equal(senderErrors().length, deliveredBefore, '成功投递不该再发 peer-unavailable');
  assert.equal(metrics().filter((metric) => metric.event === 'signal_cross_shard_delivered').length, 1);
  assert.equal(rpcCalls.length, 3);
  const forwarded = rpcCalls[2].body as { targetPeerId: string; message: string };
  assert.equal(forwarded.targetPeerId, remotePeerId);
  assert.deepEqual(JSON.parse(forwarded.message), {
    type: 'offer',
    targetPeerId: remotePeerId,
    connectionId: 'cross-3',
    kind: 'data',
    sourcePeerId: senderPeerId,
  });
});

test('跨片接收端：/internal/deliver-signaling 只投本片会话，未知目标回 delivered:false', async () => {
  const { hub, settle } = await createHub();

  const target = serverOf((await upgrade(hub, 'peerId=AERO-DELIVIN01', '203.0.113.58')).webSocket);
  const deliver = (targetPeerId: string, message: string) =>
    hub.fetch(
      new Request('https://signaling.internal/internal/deliver-signaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPeerId, message }),
      })
    ) as unknown as Promise<FakeResponse>;

  const delivered = await deliver('AERO-DELIVIN01', JSON.stringify({ type: 'ice-candidate', candidate: 'x' }));
  await settle();
  assert.equal(delivered.status, 200);
  assert.deepEqual(await delivered.json(), { delivered: true });
  assert.equal(target.lastMessage()?.type, 'ice-candidate', '跨片收到的帧必须原样投给本片 socket');

  const missing = await deliver('AERO-DELIVIN02', JSON.stringify({ type: 'offer' }));
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { delivered: false }, '目标不在本片时不能假装投递成功');
});

test('webSocketMessage：同一 socket 超过固定窗口上限回 rate-limited 并关 1008', async () => {
  const { hub } = await createHub();
  const socket = serverOf((await upgrade(hub, 'peerId=AERO-BURST001', '203.0.113.57')).webSocket);
  const baseline = socket.sent.length;

  for (let index = 0; index < MAX_SIGNALING_MESSAGES_PER_WINDOW; index += 1) {
    await sendFrame(hub, socket, { type: 'pong' });
  }
  assert.equal(socket.sent.length, baseline, '窗口配额内的帧不应被拒');

  await sendFrame(hub, socket, { type: 'pong' });
  const error = socket.lastMessage();
  assert.equal(error?.type, 'error');
  assert.equal(error?.code, 'rate-limited');
  assert.equal(closedCode(socket), 1008, '超限必须是终态 1008，客户端才会停止重试');
});

test('替身语义：未 acceptWebSocket 的 socket 不能 send，101 响应必须带 webSocket', () => {
  const bare = new FakeSocket();
  assert.throws(() => bare.send('{}'), /before acceptWebSocket/);

  bare.markAccepted();
  bare.send('{}');
  assert.deepEqual(bare.lastMessage(), {});

  assert.throws(() => new FakeResponse(null, { status: 101 }), /missing webSocket/);
  assert.throws(() => new FakeResponse('nope', { status: 101, webSocket: bare }), /must not carry a body/);

  const accepted = new FakeResponse(null, { status: 101, webSocket: bare });
  assert.equal(accepted.webSocket, bare);
  assert.equal(accepted.ok, false, '101 不是 2xx，ok 必须为 false');
});

test('注册途中 socket 关闭：不写会话、名额与槽位一起回滚', async () => {
  // 复现金评审 C：名额 reserve 是跨 DO RPC，socket 可能在 await 期间关闭。旧实现会把
  // 会话写进三张 map、把槽位挂在一个已死的 socket 上——回收只发生在 close 事件里，
  // 而那时 clientBySocket 还没写，等于永久泄漏名额。
  const holder: { current: Awaited<ReturnType<typeof createHub>> | null } = { current: null };
  let closedOnce = false;
  const created = await createHub({
    shardCount: '2',
    shardName: 'signaling-shard-1',
    signalingHub: {
      respond: (call) => {
        const body = call.body as { action?: string; lookups?: unknown[] } | null;
        if (call.url.endsWith('/internal/lookup-share-codes')) {
          const count = Array.isArray(body?.lookups) ? body.lookups.length : 0;
          return { status: 200, body: { records: Array.from({ length: count }, () => null) } };
        }
        if (body?.action === 'reserve') {
          // 模拟 RPC 往返期间客户端断开：close 事件先到，注册流程随后才继续。
          if (!closedOnce) {
            closedOnce = true;
            holder.current?.sockets.at(-1)?.close(1006, 'gone');
          }
          return { status: 200, body: { granted: true } };
        }
        if (call.url.endsWith('/internal/session-slot')) {
          return { status: 200, body: { granted: true, released: true } };
        }
        if (call.url.endsWith('/internal/session-binding')) {
          return { status: 200, body: { allowed: true } };
        }
        return { status: 200, body: {} };
      },
    },
  });
  holder.current = created;

  const response = await upgrade(created.hub, 'peerId=AERO-CLOSED001', '203.0.113.60');
  const server = serverOf(response.webSocket);
  assert.equal(server.sent.length, 0, 'socket 已关闭就不该再写 registered');
  assert.equal(closedCode(server), 1006, '关闭来自客户端，服务端不应再补一次 close');

  await created.settle();
  assert.equal(readSlotRows(created.db).length, 0, '失败注册必须释放槽位，不能永久占名额');

  // 名额没有被吃掉：同一个 IP 还能正常注册。
  const fresh = serverOf((await upgrade(created.hub, 'peerId=AERO-CLOSED002', '203.0.113.60')).webSocket);
  assert.equal(fresh.lastMessage()?.type, 'registered');
});

test('跨 IP 接管时旧 socket 先断开：配额只释放一次，同 IP 的活会话不会被漏算', async () => {
  // 复现安全评审：ejectExisting 与判定之间隔着一次跨 DO 名额 RPC。旧 socket 可能在 await
  // 期间自己 close（unregisterSocket 已按它所属的出口 IP release 过一次），旧实现随后又
  // 无条件 release 一次，把该 IP 上另一条活会话的计数也减掉——每 IP 上限被悄悄放宽。
  // 只有跨 IP 接管会走到「释放旧 IP」这一步，所以这里用两个出口 IP。
  const ipOld = '203.0.113.71';
  const ipNew = '203.0.113.72';
  const holder: { current: Awaited<ReturnType<typeof createHub>> | null } = { current: null };
  let pauseNextReserve = false;
  let resumeReserve: (() => void) | null = null;

  const created = await createHub({
    maxSessions: '2',
    shardCount: '2',
    shardName: 'signaling-shard-1',
    signalingHub: {
      respond: async (call) => {
        const body = call.body as { action?: string; slotId?: string; clientKey?: string; lookups?: unknown[] } | null;
        const sql = () => createSqlite(holder.current!.db);
        if (call.url.endsWith('/internal/lookup-share-codes')) {
          const count = Array.isArray(body?.lookups) ? body.lookups.length : 0;
          return { status: 200, body: { records: Array.from({ length: count }, () => null) } };
        }
        if (call.url.endsWith('/internal/session-binding')) {
          return { status: 200, body: { allowed: true } };
        }
        if (body?.action === 'reserve') {
          if (pauseNextReserve) {
            pauseNextReserve = false;
            await new Promise<void>((resolve) => {
              resumeReserve = resolve;
            });
          }
          // 这一段专门验证 Do 内存里的每出口 IP 席位计数：全局槽位表一律放行，
          // 否则公共层的上限会把 limiter 的漂移掩盖掉。
          return { status: 200, body: { granted: true } };
        }
        if (body?.action === 'release') {
          applySessionSlotRelease(sql(), body.slotId ?? '');
          return { status: 200, body: { released: true } };
        }
        return { status: 200, body: {} };
      },
    },
  });
  holder.current = created;

  // 旧 IP 上两条活会话（占满该 IP 上限），新 IP 上一条，用于跨 IP 接管。
  const peerTarget = 'AERO-EJECTX001';
  const socketTarget = serverOf((await upgrade(created.hub, `peerId=${peerTarget}`, ipOld)).webSocket);
  serverOf((await upgrade(created.hub, 'peerId=AERO-EJECTX002', ipOld)).webSocket);
  const mover = serverOf((await upgrade(created.hub, 'peerId=AERO-EJECTX003', ipNew)).webSocket);
  assert.equal(socketTarget.lastMessage()?.type, 'registered');
  assert.equal(mover.lastMessage()?.type, 'registered');

  // 从新 IP 接管 target：名额 RPC 挂住，期间旧 socket 断开（它已先释放旧 IP 的一个计数）。
  pauseNextReserve = true;
  const takeover = upgrade(created.hub, `peerId=${peerTarget}`, ipNew);
  for (let waited = 0; resumeReserve === null; waited += 1) {
    if (waited > 400) throw new Error('reserve RPC 没有被挂住，用例前提不成立');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  created.hub.webSocketClose(socketTarget as never);
  await created.settle();
  (resumeReserve as unknown as () => void)();

  const accepted = await takeover;
  assert.equal(accepted.status, 101);
  assert.equal(serverOf(accepted.webSocket).lastMessage()?.type, 'registered', '接管应当成功');
  await created.settle();

  // 旧 IP 上仍有一条活会话，所以还能再进 1 个；第 2 个必须被拒。
  const another = serverOf((await upgrade(created.hub, 'peerId=AERO-EJECTX004', ipOld)).webSocket);
  assert.equal(
    another.lastMessage()?.type,
    'registered',
    '旧 socket 断开只该释放一次，旧 IP 应还剩 1 个空位'
  );
  const overflow = await upgrade(created.hub, 'peerId=AERO-EJECTX005', ipOld);
  assert.equal(
    serverOf(overflow.webSocket).lastMessage()?.code,
    'rate-limited',
    '若旧 IP 被多减一次，这里会错误地放行第 3 条活会话'
  );
});

test('分片模式下 commit 返回 superseded 时记指标，而不是当作成功静默吞掉', async () => {
  // 复现金评审 E：分片 commit 以前只看 response.ok，2xx 就算成功，superseded 既没有
  // 指标也没有补偿，迟到写入的语义在分片路径上完全丢失。
  const { hub, metrics, settle } = await createHub({
    shardCount: '2',
    shardName: 'signaling-shard-1',
    signalingHub: {
      respond: (call) => {
        const body = call.body as { action?: string } | null;
        if (body?.action === 'commit') {
          return { status: 200, body: { committed: false, superseded: true } };
        }
        if (call.url.endsWith('/internal/session-slot')) {
          return { status: 200, body: { granted: true } };
        }
        return {
          status: 200,
          body: {
            allowed: true,
            proof: 'f'.repeat(64),
            pending: {
              proofHash: 'e'.repeat(64),
              boundSecretHash: 'a'.repeat(64),
              expectedProofHash: null,
            },
          },
        };
      },
    },
  });

  const server = serverOf(
    (await upgrade(hub, `peerId=AERO-SUPERSED1&sessionSecretHash=${hash('a')}`, '203.0.113.61')).webSocket
  );
  await settle();
  assert.equal(server.lastMessage()?.type, 'registered');
  const superseded = metrics().filter((line) => line.event === 'signal_session_binding_commit_superseded');
  assert.equal(superseded.length, 1, 'superseded 必须留下可观测痕迹');
  assert.equal(superseded[0]?.path, 'shard-rpc');
});

test('交错注册竞态：A 的名额 RPC 在途时 B 落定，A 回 session-conflict 且不覆盖 B 的会话与槽位', async () => {
  // 复现安全评审 F：判定（sessionsByPeer 为空）与落定之间隔着一次跨 DO RPC。两个连接都
  // 认为自己是首个连接；先落定的 B 已经收到 registered，A 恢复后若不复核就会把它从 map
  // 里顶掉（幽灵连接），还把自己的槽位永久挂在一条死会话上。
  const peerId = 'AERO-RACE0001';
  const ipA = '203.0.113.81';
  const ipB = '203.0.113.82';
  const handle: { current: Awaited<ReturnType<typeof createHub>> | null } = { current: null };
  let upgradeB: Promise<FakeResponse> | null = null;

  const created = await createHub({
    shardCount: '2',
    shardName: 'signaling-shard-1',
    signalingHub: {
      respond: async (call) => {
        const body = call.body as
          | { action?: string; slotId?: string; clientKey?: string; lookups?: unknown[] }
          | null;
        const sql = () => createSqlite(handle.current!.db);
        // 本片是 shard 1：名额 reserve 是跨 DO RPC，A 正好在这里让出事件循环。
        if (body?.action === 'reserve') {
          if (!upgradeB) {
            // B 与 A 同 peerId、不同出口 IP：等它完整注册并落定之后，才让 A 的 RPC 返回。
            upgradeB = upgrade(handle.current!.hub, `peerId=${peerId}`, ipB);
            await upgradeB;
          }
          const granted = applySessionSlotReserve(sql(), {
            slotId: body.slotId ?? '',
            clientKey: body.clientKey ?? '',
            now: Date.now(),
            maxSessions: 12,
            ttlMs: SIGNALING_SESSION_SLOT_TTL_MS,
          });
          return { status: 200, body: { granted } };
        }
        if (body?.action === 'release') {
          applySessionSlotRelease(sql(), body.slotId ?? '');
          return { status: 200, body: { released: true } };
        }
        if (call.url.endsWith('/internal/lookup-share-codes')) {
          const count = Array.isArray(body?.lookups) ? body.lookups.length : 0;
          return { status: 200, body: { records: Array.from({ length: count }, () => null) } };
        }
        // 绑定判定：两者都是首次注册，允许。
        return { status: 200, body: { allowed: true } };
      },
    },
  });
  handle.current = created;

  const socketA = serverOf((await upgrade(created.hub, `peerId=${peerId}`, ipA)).webSocket);
  const responseB = await upgradeB!;
  const socketB = serverOf(responseB.webSocket);
  await created.settle();

  // A 输了竞争：复核 map 之后按冲突拒绝，绝不写自己的会话、也不驱逐 B。
  assert.equal(socketA.lastMessage()?.code, 'session-conflict', 'A 在 await 之后必须重读 sessionsByPeer');
  assert.equal(closedCode(socketA), 4010, '输掉竞争是终态，客户端必须拿到 4010');
  assert.equal(
    socketA.messages().some((frame) => frame.type === 'registered'),
    false,
    'A 不能先拿到 registered 再被拒，否则它就是没有归属的幽灵连接'
  );
  assert.equal(
    created.metrics().filter((metric) => metric.event === 'signal_session_conflict').length,
    1,
    '冲突必须留下可观测指标'
  );

  // B 的会话与槽位都不该被 A 的迟到注册影响。
  assert.equal(socketB.lastMessage()?.type, 'registered');
  assert.equal(socketB.closed, null, 'B 不能被 A 的迟到注册关闭');
  const slots = readSlotRows(created.db);
  assert.equal(slots.length, 1, 'A 输掉竞争必须回滚自己领到的槽位，最终只剩 B 的一条');
  assert.equal(slots[0].client_key, `ip:${ipB}`, '留下的槽位必须归属 B');

  // B 仍在 sessionsByPeer：新连接投到这个 peerId 必须落到 B。
  const sender = serverOf((await upgrade(created.hub, 'peerId=AERO-RACE0002', '203.0.113.83')).webSocket);
  await sendFrame(created.hub, sender, {
    type: 'offer',
    targetPeerId: peerId,
    connectionId: 'race-1',
    kind: 'data',
  });
  await created.settle();
  assert.equal(socketB.lastMessage()?.type, 'offer', 'B 必须仍是该 peerId 的在位会话');
  assert.equal(socketB.closed, null);
});

test('跨片投递 RPC 抛错：调用方收到 peer-unavailable，只记一条 rpc_error 失败指标', async () => {
  // 「目标片 5xx」与「目标片不可达（fetch reject）」是两条分支：后者只有 catch 里的
  // rpc_error。若被吞成成功或漏记指标，排障时会把「分片挂了」显示成「对方不在线」。
  const { hub, settle, rpcCalls, metrics } = await createHub({
    shardCount: '2',
    signalingHub: {
      respond: () => {
        throw new Error('signaling shard unreachable');
      },
    },
  });

  const sender = serverOf(
    (await upgrade(hub, `peerId=${peerIdOnShard(0, 'AERO-RPCERR-A')}`, '203.0.113.84')).webSocket
  );
  const remotePeerId = peerIdOnShard(1, 'AERO-RPCERR-B');

  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: remotePeerId,
    connectionId: 'rpc-error',
    kind: 'data',
  });
  await settle();

  assert.equal(sender.lastMessage()?.code, 'peer-unavailable', 'RPC 抛错也必须让调用方拿到终态');
  assert.equal(rpcCalls.length, 1, '失败前必须真的发起过一次跨片 RPC');
  const failures = metrics().filter((metric) => metric.event === 'signal_cross_shard_failed');
  assert.equal(failures.length, 1, '异常分支必须且只能记一条失败指标');
  assert.equal(failures[0].reason, 'rpc_error');
  assert.equal(failures[0].targetShard, 1);
});

test('webSocketError：单独的错误路径也回收会话与席位，且不误删同 peerId 的其他 socket', async () => {
  // webSocketError 与 webSocketClose 共用回收函数，但它是独立注册的回调：漏接就会让
  // 「异常断开的连接」永久占着 peerId 与名额（close 事件不一定跟着来）。
  const stale = new FakeSocket();
  const live = new FakeSocket();
  const { hub, settle } = await createHub({
    maxSessions: '1',
    restored: [
      { socket: stale, attachment: { clientKey: 'ip:203.0.113.91', peerId: 'AERO-ERRPATH1' } },
      { socket: live, attachment: { clientKey: 'ip:203.0.113.91', peerId: 'AERO-ERRPATH1' } },
    ],
  });
  const failing = serverOf((await upgrade(hub, 'peerId=AERO-ERRPATH2', '203.0.113.92')).webSocket);
  assert.equal(failing.lastMessage()?.type, 'registered');

  // 1) 非归属 socket 的错误：不能按 peerId 无条件删表。
  hub.webSocketError(stale as never);
  await settle();
  const sender = serverOf((await upgrade(hub, 'peerId=AERO-ERRPATH3', '203.0.113.93')).webSocket);
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: 'AERO-ERRPATH1',
    connectionId: 'err-1',
    kind: 'data',
  });
  await settle();
  assert.equal(live.lastMessage()?.type, 'offer', '错误路径不能把同 peerId 的在位会话从 map 删掉');
  assert.equal(live.closed, null);

  // 2) 归属 socket 的错误：会话与席位一起回收，同 IP 立刻能再注册一条。
  hub.webSocketError(failing as never);
  await settle();
  await sendFrame(hub, sender, {
    type: 'offer',
    targetPeerId: 'AERO-ERRPATH2',
    connectionId: 'err-2',
    kind: 'data',
  });
  await settle();
  assert.equal(sender.lastMessage()?.code, 'peer-unavailable', '错误路径必须把该 socket 从会话表移除');

  const reopened = await upgrade(hub, 'peerId=AERO-ERRPATH4', '203.0.113.92');
  assert.equal(
    serverOf(reopened.webSocket).lastMessage()?.type,
    'registered',
    'webSocketError 必须释放席位，否则同 IP 会被自己的死连接 4029'
  );
});

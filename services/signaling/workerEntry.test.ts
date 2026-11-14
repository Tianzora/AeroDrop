// Worker 入口层（src/worker.ts 的默认导出 fetch）的契约测试。
//
// 之前只有 services/signaling/signalingHub.test.ts 这类测试，它们直接 new SignalingHub 类；
// 入口层的分派（同源门 → /ws-signaling → /api/* → ASSETS）一次都没被执行过。于是
// 「同源门写反」「/ws-signaling 不再要求 Upgrade」「静态资源分派被 /api 分支吞掉」
// 这类回归在 test:all 与覆盖率门禁下都是全绿。
//
// 这里注入最小 env（ASSETS stub + 真实 SignalingHub 实例当 DO 命名空间）+ 假 Request，
// 直接驱动默认导出 fetch。握手路径复用与 signalingHub.test.ts 同一套替身语义：
// - `cloudflare:workers` 由 scripts/test-stubs/cloudflare-workers.mjs 提供；
// - WebSocketPair / 带 webSocket 的 101 Response 由本文件注入全局；
// - ctx.storage.sql 接真实 node:sqlite；
// - FakeSocket 拒绝「未 accept 就 send」，所以「accept-before-send」不需要额外断言顺序，
//   顺序错了这里会直接抛错。
//
// 仍然不覆盖：真实 Cloudflare 的静态资源绑定、wrangler 注入的 CF-Connecting-IP 头、
// 以及跨 isolate 的限流窗口（限流计数是模块级的，本文件用不同客户端 IP 隔离）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlite } from '../../scripts/test-stubs/sqlite-adapter.ts';
import {
  SHARE_CODE_ERROR_MESSAGES,
  SHARE_CODE_FORBIDDEN_BODY,
} from '../shareCodeRegistry.ts';

const ORIGIN = 'https://drop.example';
// Cloudflare 注入的真实客户端 IP 头（与 services/signaling/requestContext.ts 一致）。
const CF_IP_HEADER = 'CF-Connecting-IP';

class FakeSocket {
  readyState = 1;
  /** ctx.acceptWebSocket 是否已经认领过这条 socket。 */
  accepted = false;
  readonly sent: { data: string }[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  markAccepted(): void {
    this.accepted = true;
  }

  send(data: string): void {
    // Workers 只允许向 acceptWebSocket 认领过的 socket 发帧。替身照此拒绝，
    // 「先 send 后 accept」的顺序回归才会崩在入口测试里，而不是静默通过。
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

// WebSocketPair[0] 是客户端、[1] 是服务端；DO 只在服务端 send/close。
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

type FakeResponseInit = {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
  webSocket?: FakeSocket;
};

/**
 * Workers 的 Response 替身。除了 101 + webSocket 这条 Workers 专属语义，还要能当普通
 * Response 用：入口层的 json()/applyResponsePolicies() 会 new Response(...) 包装它。
 */
class FakeResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly webSocket: FakeSocket | null;

  constructor(body: unknown, init: FakeResponseInit = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = new Headers(init.headers);
    this.body = typeof body === 'string' ? body : null;
    this.webSocket = init.webSocket ?? null;
    // 真正的 Workers 里 101 必须携带 webSocket，且不能有 body。
    if (this.status === 101 && this.webSocket === null) {
      throw new Error('101 response is missing webSocket');
    }
    if (this.status === 101 && body !== null) {
      throw new Error('101 response must not carry a body');
    }
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    return this.body ?? '';
  }

  async json(): Promise<unknown> {
    return this.body === null ? null : (JSON.parse(this.body) as unknown);
  }

  static json(data: unknown, init: Omit<FakeResponseInit, 'webSocket'> = {}): FakeResponse {
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return new FakeResponse(JSON.stringify(data), { ...init, headers });
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
  while (restores.length > 0) restores.pop()?.();
  console.log = previousConsoleLog;
  console.warn = previousConsoleWarn;
});

type EntryEnv = Record<string, unknown> & {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

type Entry = {
  call: (request: Request) => Promise<FakeResponse>;
  env: EntryEnv;
  assets: Request[];
  sockets: FakeSocket[];
  /** 进入 DO 的次数：用来证明入口在握手前就拒绝的请求没有打到 Durable Object。 */
  hubFetchCount: () => number;
};

/** 建一个入口：真 env（ASSETS stub）+ 真 SignalingHub 实例当 SIGNALING_HUB 命名空间。 */
const createEntry = async (): Promise<Entry> => {
  restores.push(installWorkerGlobals());

  // 遥测走 console.log（未知码 miss 每个都记一行），测试里静音。
  console.log = () => {};
  console.warn = () => {};

  const db = new DatabaseSync(':memory:');
  const sockets: FakeSocket[] = [];
  const assets: Request[] = [];
  const pending: Promise<unknown>[] = [];
  const shardName = 'global-signaling-hub';

  const env = {
    SIGNALING_SHARD_COUNT: '1',
    SIGNALING_MAX_SESSIONS_PER_CLIENT: '12',
    // 静态资源绑定替身：记录收到哪些 Request，证明分发确实落到了 ASSETS 分支。
    ASSETS: {
      fetch: async (request: Request): Promise<Response> => {
        assets.push(request);
        return new Response('<!doctype html><title>asset</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    },
  } as EntryEnv;

  const ctx = {
    storage: { sql: createSqlite(db) },
    id: { name: shardName, toString: () => shardName },
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: FakeSocket) => {
      socket.markAccepted();
      sockets.push(socket);
    },
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(Promise.resolve(promise).catch(() => {}));
    },
  };

  const workerModule = await import('../../src/worker.ts');
  const hub = new workerModule.SignalingHub(ctx as never, env as never);

  let hubFetchCount = 0;
  env.SIGNALING_HUB = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        hubFetchCount += 1;
        return hub.fetch(request);
      },
    }),
  };

  const worker = workerModule.default as unknown as {
    fetch(request: Request, env: EntryEnv): Promise<Response>;
  };

  return {
    call: (request) => worker.fetch(request, env) as unknown as Promise<FakeResponse>,
    env,
    assets,
    sockets,
    hubFetchCount: () => hubFetchCount,
  };
};

/** 入口层的请求构造：默认带同源 Origin 与伪造的 CF 客户端 IP。 */
const request = (
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; origin?: string | null } = {}
): Request => {
  const headers: Record<string, string> = { ...init.headers };
  const explicitOrigin = Object.keys(headers).some((name) => name.toLowerCase() === 'origin');
  // origin: null 表示「完全不带 Origin」；显式传了 Origin 头就尊重它（负对照要用）。
  if (init.origin !== null && !explicitOrigin) headers.Origin = init.origin ?? ORIGIN;
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
};

const wsRequest = (query: string, headers: Record<string, string> = {}): Request => {
  const requestInit = {
    headers: {
      Upgrade: 'websocket',
      [CF_IP_HEADER]: '203.0.113.10',
      ...headers,
    },
  };
  return request(`/ws-signaling${query}`, requestInit);
};

const serverOf = (response: FakeResponse): FakeSocket => {
  const client = response.webSocket;
  assert.ok(client, 'expected a client socket in the 101 response');
  const server = serverByClient.get(client);
  assert.ok(server, 'expected the paired server socket');
  return server;
};

test('非白名单路径整体落到 ASSETS，并套上响应策略（安全头 + 缓存策略）', async () => {
  const entry = await createEntry();

  const response = await entry.call(request('/assets/app-a1b2.js'));
  assert.equal(response.status, 200);
  assert.equal(entry.assets.length, 1, '静态路径必须交给 ASSETS');
  assert.equal(entry.assets[0].url, `${ORIGIN}/assets/app-a1b2.js`);
  // applyResponsePolicies 生效的证据：安全头 + 哈希资源的 immutable 缓存。
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

  const html = await entry.call(request('/'));
  assert.equal(html.headers.get('Cache-Control'), 'no-cache');
  assert.equal(entry.assets.length, 2);

  // 分享链接（?code=）标记 noindex —— 这条策略只在入口层生效。
  const share = await entry.call(request('/?code=123456'));
  assert.equal(share.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal(entry.assets.length, 3);
  assert.equal(entry.hubFetchCount(), 0, '静态请求不能打到 Durable Object');
});

test('白名单 API 前缀不会被 ASSETS 吞掉：未知 /api/* 是 404 而不是静态文件', async () => {
  const entry = await createEntry();

  const response = await entry.call(request('/api/nope'));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not Found');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(entry.assets.length, 0, '/api/* 必须走 API 分支');
});

test('/ws-signaling：非 GET 400、非升级请求 426，且都不触达 Durable Object', async () => {
  const entry = await createEntry();

  const posted = await entry.call(request('/ws-signaling?peerId=ENTRY-PEER-01', {
    method: 'POST',
    headers: { Upgrade: 'websocket' },
  }));
  assert.equal(posted.status, 400);
  assert.equal(await posted.text(), 'Worker expected GET method');

  const plain = await entry.call(request('/ws-signaling?peerId=ENTRY-PEER-01'));
  assert.equal(plain.status, 426);
  assert.equal(await plain.text(), 'Worker expected Upgrade: websocket');
  assert.equal(entry.hubFetchCount(), 0);
});

test('/ws-signaling：Origin 不匹配或缺 Origin 一律 403，握手请求不能进 DO', async () => {
  const entry = await createEntry();

  const crossOrigin = await entry.call(
    wsRequest('?peerId=ENTRY-PEER-02', { Origin: 'https://evil.example' })
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(await crossOrigin.text(), 'Forbidden');

  const opaqueOrigin = await entry.call(
    wsRequest('?peerId=ENTRY-PEER-02', { Origin: 'null' })
  );
  assert.equal(opaqueOrigin.status, 403);

  const noOrigin = await entry.call(
    request('/ws-signaling?peerId=ENTRY-PEER-02', {
      headers: { Upgrade: 'websocket', [CF_IP_HEADER]: '203.0.113.20' },
      origin: null,
    })
  );
  assert.equal(noOrigin.status, 403);

  assert.equal(entry.hubFetchCount(), 0, '被同源门挡下的握手不应该占用 DO');
});

test('/ws-signaling：同源但缺 peerId 返回 400，且不触达 DO', async () => {
  const entry = await createEntry();

  const missing = await entry.call(wsRequest(''));
  assert.equal(missing.status, 400);
  assert.equal(await missing.text(), 'Missing peerId');

  // 只有空白也算缺失（入口用 trim 后的空串判空）。
  const blank = await entry.call(wsRequest('?peerId=%20%20'));
  assert.equal(blank.status, 400);
  assert.equal(entry.hubFetchCount(), 0);
});

test('/ws-signaling：合法握手返回 101，服务端 socket 先 accept 再收到 registered', async () => {
  const entry = await createEntry();

  const response = await entry.call(wsRequest('?peerId=ENTRY-PEER-03'));
  assert.equal(response.status, 101);
  assert.equal(entry.hubFetchCount(), 1, '握手应该路由进 Durable Object');

  const server = serverOf(response);
  // FakeSocket.send 在未 accept 时直接抛错，所以走到这里已经证明 accept 早于 send。
  assert.equal(server.accepted, true, '101 返回前必须已经 acceptWebSocket');
  assert.equal(server.lastMessage()?.type, 'registered');
  assert.equal(server.lastMessage()?.peerId, 'ENTRY-PEER-03');
  assert.equal(server.closed, null);
  // 注册通过的 socket 必须被 ctx 记住（DO 的会话表来自 acceptWebSocket）。
  assert.equal(entry.sockets.includes(server), true);
});

test('/api/share-code：跨站 Origin 403；凭证不匹配 revoke 也是 403（不泄露码是否存在）', async () => {
  const entry = await createEntry();

  const crossOrigin = await entry.call(
    request('/api/share-code', {
      method: 'POST',
      origin: 'https://evil.example',
      headers: { [CF_IP_HEADER]: '203.0.113.30', 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'ENTRYSHARE01', secretHash: 'a'.repeat(64) }),
    })
  );
  assert.equal(crossOrigin.status, 403);

  const created = await entry.call(
    request('/api/share-code', {
      method: 'POST',
      headers: { [CF_IP_HEADER]: '203.0.113.31', 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'ENTRYSHARE01', secretHash: 'a'.repeat(64) }),
    })
  );
  assert.equal(created.status, 200);
  const issued = (await created.json()) as { code: string };
  assert.match(issued.code, /^\d{6}$/);

  // 摘要格式合法但值不匹配：DO 侧 403，入口原样映射成 forbidden。
  const wrongSecret = await entry.call(
    request(`/api/share-code/${issued.code}/revoke`, {
      method: 'POST',
      headers: { [CF_IP_HEADER]: '203.0.113.31', 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'ENTRYSHARE01', secretHash: 'b'.repeat(64) }),
    })
  );
  assert.equal(wrongSecret.status, 403);
  assert.deepEqual(await wrongSecret.json(), SHARE_CODE_FORBIDDEN_BODY);
  assert.equal(wrongSecret.headers.get('X-Frame-Options'), 'DENY', '响应策略同样套在 share-code 上');

  // 同一路由 + 正确摘要放行：上面的 403 来自凭证校验，不是路由写坏。
  const revoked = await entry.call(
    request(`/api/share-code/${issued.code}/revoke`, {
      method: 'POST',
      headers: { [CF_IP_HEADER]: '203.0.113.31', 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'ENTRYSHARE01', secretHash: 'a'.repeat(64) }),
    })
  );
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json() as { revoked: boolean }).revoked, true);
});

test('/api/share-code：未知码 404、格式非法 400（按现状断言，不改语义）', async () => {
  const entry = await createEntry();
  const ip = { [CF_IP_HEADER]: '203.0.113.40' };

  const unknown = await entry.call(request('/api/share-code?code=123456', { headers: ip }));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: SHARE_CODE_ERROR_MESSAGES.notFoundOrExpired });

  // 非六位数字在入口就被 normalizeShareCode 拒掉，没有进 DO。
  const invalid = await entry.call(request('/api/share-code?code=12ab', { headers: ip }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: SHARE_CODE_ERROR_MESSAGES.invalidCode });
});

test('/api/share-code：GET 超过 30 次/10s 的固定窗口后返回 429 + Retry-After', async () => {
  const entry = await createEntry();
  const headers = { [CF_IP_HEADER]: '203.0.113.50' };

  // 上限来自 services/shareCodeRateLimitPolicy.ts（GET 30/10s）；前 30 次都放行到 DO 查码。
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await entry.call(request('/api/share-code?code=123456', { headers }));
    assert.equal(response.status, 404, `第 ${attempt + 1} 次应该还没被限流`);
  }

  const limited = await entry.call(request('/api/share-code?code=123456', { headers }));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'Too Many Requests' });
  assert.ok(Number(limited.headers.get('Retry-After')) >= 1, 'Retry-After 必须是正整数秒');
  // 429 在入口层就返回，没有继续打 DO（DO 的未知码预算是另一层 200/10s）。
  assert.equal(entry.hubFetchCount(), 30);
});

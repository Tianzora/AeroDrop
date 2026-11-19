import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatSession } from './chatCore.ts';
import {
  disposeRoomChatConnections,
  hasOpenRoomChatConnection,
  linkRoomChatConnection,
  pruneRoomChatConnections,
  sendRoomChatText,
  sendRoomControl,
  useRoomChat,
  type RoomChatApi,
} from './useRoomChat.ts';

const renderProbe = (): { api: RoomChatApi; html: string } => {
  let captured: RoomChatApi | null = null;
  const Probe = () => {
    const api = useRoomChat({ onNotify: () => {} });
    captured = api;
    return React.createElement('div', null, `${api.ui.role}:${api.ui.connected}:${api.ui.messages.length}`);
  };
  const html = renderToStaticMarkup(React.createElement(Probe));
  assert.ok(captured, 'useRoomChat 必须在渲染时返回命令面');
  return { api: captured as RoomChatApi, html };
};

test('useRoomChat 默认给出关闭态、未连接、空历史的发送端浮层', () => {
  const { api, html } = renderProbe();
  assert.equal(api.ui.open, false);
  assert.equal(api.ui.role, 'sender');
  assert.equal(api.ui.connected, false);
  assert.deepEqual(api.ui.messages, []);
  assert.match(html, /sender:false:0/);
});

test('useRoomChat 暴露连接接入、重置与身份设置四条命令', () => {
  const { api } = renderProbe();
  const surface: Array<keyof RoomChatApi> = ['attachRoomConnection', 'reset', 'setLocalPeerId', 'setRole', 'sendControl'];
  for (const key of surface) {
    assert.equal(typeof api[key], 'function', `${key} 必须是可调用函数`);
  }
});

test('useRoomChat 的 UI 回调在空历史下也不会抛错', () => {
  const { api } = renderProbe();
  assert.doesNotThrow(() => api.ui.onToggle());
  assert.doesNotThrow(() => api.ui.onClose());
});

class FakeRoomConnection {
  peer = 'peer-42';
  open = true;
  closed = false;
  sent: any[] = [];
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  send(data: any): void {
    if (!this.open) throw new Error('closed');
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.open = false;
    this.closed = true;
    this.emit('close');
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

test('useRoomChat 行为：attach 后收帧更新消息，且用连接身份覆盖伪造 fromPeerId', () => {
  const session = new ChatSession({ rateLimitMaxMessages: 100, rateLimitWindowMs: 10_000, now: () => 1 });
  const conn = new FakeRoomConnection();
  let changes = 0;
  const attachment = linkRoomChatConnection(
    conn as unknown as Parameters<typeof linkRoomChatConnection>[0],
    session,
    () => { changes += 1; },
  );

  conn.emit('data', JSON.stringify({ id: 'r1', fromPeerId: 'mallory', ts: 1, text: 'hello' }));

  assert.equal(session.getMessages().length, 1);
  assert.equal(session.getMessages()[0].fromPeerId, 'peer-42');
  assert.equal(changes, 0);
  conn.emit('open');
  assert.equal(changes, 1);
  assert.equal(attachment.conn, conn);
});

test('useRoomChat 行为：send 把消息交给 open 连接；无连接返回 not-connected', () => {
  const session = new ChatSession({
    rateLimitMaxMessages: 100,
    rateLimitWindowMs: 10_000,
    localPeerId: 'me',
    now: () => 1,
  });
  const conn = new FakeRoomConnection();
  const attachment = linkRoomChatConnection(
    conn as unknown as Parameters<typeof linkRoomChatConnection>[0],
    session,
    () => {},
  );

  assert.equal(sendRoomChatText(session, [attachment], 'hi'), 'sent');
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].text, 'hi');

  conn.open = false;
  assert.equal(sendRoomChatText(session, [attachment], 'again'), 'not-connected');
});

test('useRoomChat 行为：reset 清理旧连接监听并 close，避免旧通道继续灌消息', () => {
  const session = new ChatSession({ rateLimitMaxMessages: 100, rateLimitWindowMs: 10_000, now: () => 1 });
  const conn = new FakeRoomConnection();
  const attachment = linkRoomChatConnection(
    conn as unknown as Parameters<typeof linkRoomChatConnection>[0],
    session,
    () => {},
  );
  conn.emit('data', JSON.stringify({ id: 'old', fromPeerId: 'p', ts: 1, text: 'before' }));
  assert.equal(session.getMessages().length, 1);

  disposeRoomChatConnections([attachment]);
  session.clear();

  assert.equal(conn.closed, true);
  assert.equal(conn.listenerCount('data'), 0);
  assert.equal(session.getMessages().length, 0);
});

test('useRoomChat 行为：死连接被摘除时同时 off 监听，避免旧通道继续灌消息', () => {
  const session = new ChatSession({ rateLimitMaxMessages: 100, rateLimitWindowMs: 10_000, now: () => 1 });
  const conn = new FakeRoomConnection();
  const attachment = linkRoomChatConnection(
    conn as unknown as Parameters<typeof linkRoomChatConnection>[0],
    session,
    () => {},
  );
  assert.equal(conn.listenerCount('data'), 1);

  // 模拟连接已死（close/error 后 open=false），由 prune 负责真正 off + close。
  conn.open = false;
  const alive = pruneRoomChatConnections([attachment]);

  assert.equal(alive.length, 0);
  assert.equal(conn.closed, true);
  assert.equal(conn.listenerCount('data'), 0);
  assert.equal(conn.listenerCount('open'), 0);
  assert.equal(conn.listenerCount('close'), 0);
  assert.equal(conn.listenerCount('error'), 0);
});

test('useRoomChat 控制帧：share-request 被旁路到 onControl，不进聊天历史', () => {
  const session = new ChatSession({ rateLimitMaxMessages: 100, rateLimitWindowMs: 10_000, now: () => 1 });
  const conn = new FakeRoomConnection();
  const controls: Array<{ message: unknown; sourcePeerId: string }> = [];
  linkRoomChatConnection(
    conn as unknown as Parameters<typeof linkRoomChatConnection>[0],
    session,
    () => {},
    (message, sourcePeerId) => controls.push({ message, sourcePeerId }),
  );

  conn.emit('data', { type: 'share-request', action: 'start' });
  assert.equal(controls.length, 1);
  assert.deepEqual(controls[0].message, { type: 'share-request', action: 'start' });
  assert.equal(controls[0].sourcePeerId, 'peer-42');
  assert.equal(session.getMessages().length, 0);

  conn.emit('data', JSON.stringify({ id: 'c1', fromPeerId: 'x', ts: 1, text: 'hi' }));
  assert.equal(session.getMessages().length, 1);
  assert.equal(controls.length, 1);
});

test('useRoomChat 控制帧：sendRoomControl 广播给所有 open 连接', () => {
  const first = new FakeRoomConnection();
  const second = new FakeRoomConnection();
  const attachments = [
    linkRoomChatConnection(first as unknown as Parameters<typeof linkRoomChatConnection>[0], null, () => {}),
    linkRoomChatConnection(second as unknown as Parameters<typeof linkRoomChatConnection>[0], null, () => {}),
  ];
  assert.equal(sendRoomControl(attachments, { type: 'share-state', activeSharerId: null }), true);
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 1);
  first.open = false;
  assert.equal(sendRoomControl(attachments, { type: 'share-state', activeSharerId: 'x' }), true);
  assert.equal(second.sent.length, 2);
});

test('useRoomChat 行为：连接 close 后 connected 判定变为 false', () => {
  const session = new ChatSession({ rateLimitMaxMessages: 100, rateLimitWindowMs: 10_000, now: () => 1 });
  const conn = new FakeRoomConnection();
  const attachment = linkRoomChatConnection(
    conn as unknown as Parameters<typeof linkRoomChatConnection>[0],
    session,
    () => {},
  );
  assert.equal(hasOpenRoomChatConnection([attachment]), true);
  conn.close();
  assert.equal(hasOpenRoomChatConnection([attachment]), false);
});
import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useRoomChat, type RoomChatApi } from './useRoomChat.ts';

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
  const surface: Array<keyof RoomChatApi> = ['attachRoomConnection', 'reset', 'setLocalPeerId', 'setRole'];
  for (const key of surface) {
    assert.equal(typeof api[key], 'function', `${key} 必须是可调用函数`);
  }
});

test('useRoomChat 的 UI 回调在空历史下也不会抛错', () => {
  const { api } = renderProbe();
  assert.doesNotThrow(() => api.ui.onToggle());
  assert.doesNotThrow(() => api.ui.onClose());
});
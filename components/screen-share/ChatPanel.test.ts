import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatPanel, formatClock, handleDraftChange, handleDraftKeyDown, submitChatDraft } from './ChatPanel.tsx';

const baseProps: React.ComponentProps<typeof ChatPanel> = {
  role: 'viewer',
  connected: true,
  messages: [],
  onSend: () => {},
  onExport: () => {},
  connectingHint: '正在建立聊天通道',
};

const render = (overrides: Partial<React.ComponentProps<typeof ChatPanel>> = {}) =>
  renderToStaticMarkup(React.createElement(ChatPanel, { ...baseProps, ...overrides }));

test('聊天以页面内嵌面板渲染，不再出现右下角悬浮入口', () => {
  const markup = render({ connected: false });

  assert.match(markup, /aria-label="房间聊天"/);
  assert.match(markup, /rounded-card/);
  assert.match(markup, /正在建立聊天通道/);
  assert.doesNotMatch(markup, /aria-label="打开聊天"/);
  assert.doesNotMatch(markup, /fixed bottom-4 right-4/);
});

test('未连接时禁用输入并展示连接提示', () => {
  const markup = render({ role: 'sender', connected: false });

  assert.match(markup, /bg-white/);
  assert.match(markup, /正在建立聊天通道/);
  assert.match(markup, /连接后即可聊天/);
  assert.match(markup, /disabled=""/);
});

test('有消息时逐条渲染发送者、时间和文本，并启用导出', () => {
  const ts = new Date(2026, 0, 2, 9, 5).getTime();
  const markup = render({
    role: 'viewer',
    messages: [
      { id: 'm1', fromPeerId: 'peer-alpha', ts, text: '你好\n世界' },
      { id: 'm2', fromPeerId: 'peer-beta', ts, text: '收到' },
    ],
  });

  // 观看端看到的对方消息统一显示为“房主”，不把 peer id 暴露在界面上。
  assert.equal((markup.match(/>房主</g) ?? []).length, 2);
  assert.doesNotMatch(markup, /peer-alpha|peer-beta/);
  assert.match(markup, /09:05/);
  assert.match(markup, /你好\n世界/);
  assert.match(markup, /收到/);
  assert.match(markup, /aria-label="导出聊天记录"/);
  assert.doesNotMatch(markup, /disabled=""[^>]*aria-label="导出聊天记录"/);
});

test('已连接但没有消息时明确提示晚加入没有历史', () => {
  const markup = render({ connected: true, messages: [] });

  assert.match(markup, /晚加入者没有历史消息/);
  assert.match(markup, /已连接/);
});
test('formatClock 无效时间返回空串，并对时分补零', () => {
  assert.equal(formatClock(Number.NaN), '');
  const ts = new Date(2026, 0, 2, 9, 5).getTime();
  assert.equal(formatClock(ts), '09:05');
});

test('submitChatDraft 丢弃纯空白草稿，有效草稿原样发送后清空', () => {
  const sent: string[] = [];
  let draft = '未改动';
  submitChatDraft('   ', (text) => sent.push(text), (value) => (draft = value));
  assert.deepEqual(sent, [] as string[]);
  assert.equal(draft, '未改动');

  submitChatDraft('  hello  ', (text) => sent.push(text), (value) => (draft = value));
  assert.deepEqual(sent, ['  hello  ']);
  assert.equal(draft, '');
});

test('输入变更直接写入，Enter 发送而 Shift+Enter 不发送', () => {
  let nextDraft = '';
  handleDraftChange(
    (value) => (nextDraft = value),
    { target: { value: 'abc' } } as unknown as React.ChangeEvent<HTMLInputElement>
  );
  assert.equal(nextDraft, 'abc');

  const sent: string[] = [];
  let cleared = '';
  let prevented = false;
  const enterEvent = {
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as React.KeyboardEvent<HTMLInputElement>;
  handleDraftKeyDown('hi', (text) => sent.push(text), (value) => (cleared = value), enterEvent);
  assert.deepEqual(sent, ['hi']);
  assert.equal(cleared, '');
  assert.equal(prevented, true);

  const shiftEnterEvent = {
    key: 'Enter',
    shiftKey: true,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as React.KeyboardEvent<HTMLInputElement>;
  handleDraftKeyDown('hi', (text) => sent.push(text), (value) => (cleared = value), shiftEnterEvent);
  assert.deepEqual(sent, ['hi']);
});
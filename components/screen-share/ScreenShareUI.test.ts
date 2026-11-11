import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScreenShareUI } from './ScreenShareUI.tsx';

const baseProps: React.ComponentProps<typeof ScreenShareUI> = {
  isSharing: false,
  isViewing: false,
  isConnecting: false,
  viewerConnectingStage: '' as const,
  error: null,
  targetSharerId: null,
  cancelConnecting: () => {},
  retryConnection: () => {},
  dismissConnectionError: () => {},
  viewerVideoRef: () => {},
  needsPlayClick: false,
  onViewerPlayClick: () => {},
  stopViewing: () => {},
  qualityLabels: { high: '高清', medium: '标清', low: '流畅' },
  remoteQuality: 'high' as const,
  shareLink: null,
  copyShareLink: () => {},
  copied: false,
  isPeerReady: true,
  viewerCount: 0,
  qualityLevel: 'high' as const,
  sharerVideoRef: { current: null },
  changeScreenSource: () => {},
  startScreenShare: () => {},
  stopScreenShare: () => {},
};

const render = (overrides: Partial<React.ComponentProps<typeof ScreenShareUI>> = {}) =>
  renderToStaticMarkup(React.createElement(ScreenShareUI, { ...baseProps, ...overrides }));

test('观看态：状态与画质叠进播放器，使用自绘控件条', () => {
  const markup = render({ isViewing: true, targetSharerId: 'sharer-1' });

  assert.match(markup, /观看屏幕/);
  assert.match(markup, /实时观看对方共享的屏幕内容/);
  assert.match(markup, /正在观看/);
  assert.match(markup, /画质 高清/);
  assert.match(markup, /停止观看/);
  assert.doesNotMatch(markup, /controls=""/);
  assert.match(markup, /aria-label="暂停"/);
  assert.match(markup, /aria-label="静音"/);
  assert.match(markup, /aria-label="全屏"/);
  // 画中画按浏览器能力出现；服务端渲染拿不到 document，因此不应出现在静态标记里
  assert.doesNotMatch(markup, /画中画/);
});

test('共享态：保留分享链接卡片与共享操作条', () => {
  const markup = render({ isSharing: true, shareLink: 'https://example.com/#/screen-share?sharer=abc' });

  assert.match(markup, /屏幕共享/);
  assert.match(markup, /正在共享/);
  assert.match(markup, /复制分享链接/);
  assert.match(markup, /aria-label="分享链接"/);
  assert.doesNotMatch(markup, /在新窗口打开/);
  assert.match(markup, /停止共享/);
  assert.doesNotMatch(markup, /停止观看/);
});

test('未开始时保留引导头部与开始按钮', () => {
  const markup = render();

  assert.match(markup, /屏幕共享/);
  assert.match(markup, /开始共享屏幕/);
  assert.match(markup, /与其他设备实时共享您的屏幕内容/);
  assert.doesNotMatch(markup, /停止共享/);
});

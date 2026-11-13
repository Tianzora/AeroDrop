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
  isShareLive: false,
  shareRoomRenewalWarning: false,
  shareRoomExpired: false,
  hasBeenReady: false,
  sharerFailure: null,
  dismissSharerFailure: () => {},
  recommendedViewerCount: 4,
  maxViewerCount: 6,
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
  const markup = render({
    isSharing: true,
    isShareLive: true,
    shareLink: 'https://example.com/#/screen-share?sharer=abc',
  });

  assert.match(markup, /屏幕共享/);
  assert.match(markup, /正在共享/);
  assert.match(markup, /复制分享链接/);
  assert.match(markup, /aria-label="分享链接"/);
  assert.doesNotMatch(markup, /在新窗口打开/);
  assert.match(markup, /停止共享/);
  assert.doesNotMatch(markup, /停止观看/);
});

test('共享中但信令未就绪：不显示绿色 LIVE，链接标注失效', () => {
  const markup = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  // 曾经连上过又掉了：绿色「正在共享」会骗人，只能说在重连。
  assert.match(markup, /正在重连服务器/);
  assert.doesNotMatch(markup, /正在共享/);
  assert.match(markup, /信令中断，新观众暂时无法加入/);
  assert.match(markup, /disabled=""/);
});

test('信令终态：展示中断说明并提示旧链接已失效', () => {
  const markup = render({
    sharerFailure: {
      reason: 'signaling_failed',
      message: '无法连接信令服务器，请检查网络后重试',
    },
  });

  assert.match(markup, /共享已中断/);
  assert.match(markup, /无法连接信令服务器，请检查网络后重试/);
  assert.match(markup, /此前分享的链接已失效/);
  assert.match(markup, /重新开始共享/);
  assert.doesNotMatch(markup, /正在共享/);
  assert.doesNotMatch(markup, /复制分享链接/);
});

test('容量：给出建议人数，超过建议值给出降画质提示', () => {
  const markup = render({
    isSharing: true,
    isShareLive: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
    viewerCount: 5,
    recommendedViewerCount: 4,
    maxViewerCount: 6,
  });

  assert.match(markup, /建议 4 人同时观看（依网络），最多 6 人/);
  assert.match(markup, /当前 5 人已超过建议人数，部分观众画质可能下降/);
});

test('未开始时也展示建议人数，且不渲染共享链接卡片', () => {
  const markup = render({ recommendedViewerCount: 4, maxViewerCount: 6 });

  assert.match(markup, /建议 4 人同时观看（依网络），最多 6 人/);
  assert.doesNotMatch(markup, /复制分享链接/);
});

test('续期连续失败：保持绿色 LIVE 的同时给出过期风险提示', () => {
  const markup = render({
    isSharing: true,
    isShareLive: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
    shareRoomRenewalWarning: true,
  });

  // 续期失败不影响当前观看，所以不清 LIVE；但要提前告诉主控链接会过期。
  assert.match(markup, /正在共享/);
  assert.match(markup, /分享链接续期失败，到期后观众将无法再加入/);
});

test('信令未就绪时不叠续期提示：那一刻更该说的是链接暂时不可用', () => {
  const markup = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
    shareRoomRenewalWarning: true,
  });

  assert.match(markup, /信令中断，新观众暂时无法加入/);
  assert.doesNotMatch(markup, /分享链接续期失败/);
});

test('未开始时保留引导头部与开始按钮', () => {
  const markup = render();

  assert.match(markup, /屏幕共享/);
  assert.match(markup, /开始共享屏幕/);
  assert.match(markup, /与其他设备实时共享您的屏幕内容/);
  assert.doesNotMatch(markup, /停止共享/);
});

test('信令终态只留终态卡里的「重新开始共享」，不再重复一颗主按钮', () => {
  const markup = render({
    sharerFailure: {
      reason: 'signaling_failed',
      message: '无法连接信令服务器，请检查网络后重试',
    },
  });

  // 同一屏两个「开始共享」入口会让人分不清哪个才是恢复路径。
  assert.match(markup, /重新开始共享/);
  assert.doesNotMatch(markup, /开始共享屏幕/);
});

test('链接失效时不只是拦鼠标：连键盘焦点一起移出序列', () => {
  const link = 'https://example.com/#/screen-share?view=AERO-abc';

  const dead = render({ isSharing: true, isShareLive: false, isPeerReady: false, shareLink: link });
  assert.match(dead, /aria-disabled="true"/);
  assert.match(dead, /tabindex="-1"/);

  const live = render({ isSharing: true, isShareLive: true, shareLink: link });
  assert.match(live, /aria-disabled="false"/);
  assert.doesNotMatch(live, /tabindex="-1"/);
});

test('房号过期：徽标与链接一起失效，不能继续显示绿色正在共享', () => {
  const markup = render({
    isSharing: true,
    isShareLive: true,
    shareRoomExpired: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  assert.match(markup, /链接已失效/);
  assert.match(markup, /分享链接已失效，需要重新开始共享才能让新观众加入/);
  assert.doesNotMatch(markup, /正在共享/);
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, /tabindex="-1"/);
});

test('首次连接不说「信令中断」：还没连上过和掉线是两回事', () => {
  const connecting = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: false,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });
  assert.match(connecting, /正在连接服务器，连上后新观众即可加入/);
  assert.doesNotMatch(connecting, /信令中断/);

  const reconnecting = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });
  assert.match(reconnecting, /信令中断，新观众暂时无法加入/);
});

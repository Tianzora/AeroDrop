import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ScreenShareUI,
  deriveIsChatEntryVisible,
  deriveIsChatPanelVisible,
  deriveIsInRoomShell,
  deriveIsShareSlotIdle,
  deriveIsViewerSession,
  indexViewerStage,
  isShareLinkUsable,
  isSlotActiveForOther,
} from './ScreenShareUI.tsx';
import {
  SHARER_RECONNECT_EXHAUSTED_MESSAGE,
  SIGNALING_UNREACHABLE_MESSAGE,
} from '../../services/connectionGuidance.ts';

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
  dismissError: () => {},
  viewerVideoRef: () => {},
  needsPlayClick: false,
  onViewerPlayClick: () => {},
  stopViewing: () => {},
  roomRetained: false,
  chat: {
    role: 'viewer' as const,
    open: false,
    connected: false,
    messages: [],
    onToggle: () => {},
    onClose: () => {},
    onSend: () => {},
    onExport: () => {},
  },
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
  shareRoomRetrySeconds: null,
  viewerRetrySeconds: null,
  recommendedViewerCount: 4,
  maxViewerCount: 6,
  viewerCount: 0,
  qualityLevel: 'high' as const,
  sharerVideoRef: { current: null },
  changeScreenSource: () => {},
  startScreenShare: () => {},
  stopScreenShare: () => {},
  onEndRoom: () => {},
};

const render = (overrides: Partial<React.ComponentProps<typeof ScreenShareUI>> = {}) =>
  renderToStaticMarkup(React.createElement(ScreenShareUI, { ...baseProps, ...overrides }));

test('房间共享视图判定是纯函数：链接/槽位/视角/聊天入口组合都可单测', () => {
  assert.equal(isShareLinkUsable(true, false), true);
  assert.equal(isShareLinkUsable(true, true), false);
  assert.equal(isShareLinkUsable(false, false), false);

  assert.equal(isSlotActiveForOther('a', 'b'), true);
  assert.equal(isSlotActiveForOther('a', 'a'), false);
  assert.equal(isSlotActiveForOther(null, 'a'), false);
  assert.equal(isSlotActiveForOther('a', null), false);

  assert.equal(
    deriveIsViewerSession({ isViewing: true, targetSharerId: null, viewerSharePaused: false, slotActiveIsOther: false }),
    true,
  );
  assert.equal(
    deriveIsViewerSession({ isViewing: false, targetSharerId: 'a', viewerSharePaused: false, slotActiveIsOther: false }),
    true,
  );
  assert.equal(
    deriveIsViewerSession({ isViewing: false, targetSharerId: null, viewerSharePaused: true, slotActiveIsOther: false }),
    true,
  );
  assert.equal(
    deriveIsViewerSession({ isViewing: false, targetSharerId: null, viewerSharePaused: false, slotActiveIsOther: true }),
    true,
  );
  assert.equal(
    deriveIsViewerSession({ isViewing: false, targetSharerId: null, viewerSharePaused: false, slotActiveIsOther: false }),
    false,
  );

  assert.equal(
    deriveIsInRoomShell({ isSharing: false, isViewerSession: false, roomRetained: true, sharePaused: false }),
    true,
  );
  assert.equal(
    deriveIsInRoomShell({ isSharing: false, isViewerSession: false, roomRetained: false, sharePaused: false }),
    false,
  );

  assert.equal(
    deriveIsShareSlotIdle({
      inRoomShell: true,
      isSharing: false,
      isViewing: false,
      isConnecting: false,
      viewerSharePaused: false,
      slotActiveIsOther: false,
    }),
    true,
  );
  assert.equal(
    deriveIsShareSlotIdle({
      inRoomShell: true,
      isSharing: false,
      isViewing: false,
      isConnecting: false,
      viewerSharePaused: false,
      slotActiveIsOther: true,
    }),
    false,
  );
  assert.equal(
    deriveIsShareSlotIdle({
      inRoomShell: false,
      isSharing: false,
      isViewing: false,
      isConnecting: false,
      viewerSharePaused: false,
      slotActiveIsOther: false,
    }),
    false,
  );

  const steps = ['fetching_ice', 'connecting_signaling', 'connecting_media', 'waiting_stream'] as const;
  assert.equal(indexViewerStage('', steps), -1);
  assert.equal(indexViewerStage('connecting_media', steps), 2);

  assert.equal(
    deriveIsChatEntryVisible({ inRoomShell: false, chatConnected: false, messageCount: 1, viewerFullscreen: false }),
    true,
  );
  assert.equal(
    deriveIsChatEntryVisible({ inRoomShell: true, chatConnected: false, messageCount: 0, viewerFullscreen: true }),
    false,
  );
  assert.equal(deriveIsChatPanelVisible(true, true), true);
  assert.equal(deriveIsChatPanelVisible(true, false), false);
  assert.equal(deriveIsChatPanelVisible(false, true), false);
});

test('观看态：状态与画质叠进播放器，使用自绘控件条', () => {
  const markup = render({ isViewing: true, targetSharerId: 'sharer-1' });

  assert.match(markup, /观看屏幕/);
  assert.match(markup, /实时观看对方共享的屏幕内容/);
  assert.match(markup, /正在观看/);
  assert.match(markup, /画质 高清/);
  // 观看端不做任何共享控制：没有「停止观看 / 重新观看 / 开始共享」，只保留播放器自绘控件。
  assert.doesNotMatch(markup, /停止观看/);
  assert.doesNotMatch(markup, /重新观看/);
  assert.doesNotMatch(markup, />\s*开始共享\s*</);
  assert.doesNotMatch(markup, /结束并离开/);
  assert.doesNotMatch(markup, /controls=""/);
  assert.match(markup, /aria-label="暂停"/);
  assert.match(markup, /aria-label="静音"/);
  assert.match(markup, /aria-label="全屏"/);
  // 画中画按浏览器能力出现；服务端渲染拿不到 document，因此不应出现在静态标记里
  assert.doesNotMatch(markup, /画中画/);
});

test('观看端共享停止后只显示浅色占位，房间聊天保留且没有任何按钮', () => {
  const markup = render({
    targetSharerId: 'sharer-1',
    viewerSharePaused: true,
    chat: { ...baseProps.chat, connected: true },
  });

  assert.match(markup, /共享已停止/);
  assert.match(markup, /房间与聊天仍保留/);
  assert.match(markup, /role="status"/);
  // 观看端零共享控制：占位态不许出现任何停止/重新观看/开始/结束按钮。
  assert.doesNotMatch(markup, /停止观看/);
  assert.doesNotMatch(markup, /重新观看/);
  assert.doesNotMatch(markup, />\s*开始共享\s*</);
  assert.doesNotMatch(markup, /结束并离开/);
});

test('共享端停止共享后显示占位与开始共享，房间聊天入口仍在', () => {
  const markup = render({
    roomRetained: true,
    sharePaused: true,
    chat: { ...baseProps.chat, connected: true },
  });

  assert.match(markup, /共享已暂停/);
  // 无观看者时不能说「观看者都还在」——文案随 viewerCount 切换。
  assert.match(markup, /房间与聊天仍保留/);
  assert.doesNotMatch(markup, /房间、聊天和观看者都还在/);
  assert.match(markup, /开始共享/);
  assert.doesNotMatch(markup, /停止共享/);
  assert.doesNotMatch(markup, /开始共享屏幕/);
  assert.match(markup, /结束并离开/);

  const withViewers = render({
    roomRetained: true,
    sharePaused: true,
    viewerCount: 2,
    chat: { ...baseProps.chat, connected: true },
  });
  assert.match(withViewers, /房间、聊天和观看者都还在/);
});

test('房间空闲时显示开始共享，任何成员都能发起共享', () => {
  const markup = render({ roomRetained: true });
  assert.match(markup, /还没有人共享屏幕/);
  assert.match(markup, /任何人都可以开始共享/);
  assert.match(markup, />\s*开始共享\s*</);
  assert.match(markup, /结束并离开/);
  assert.doesNotMatch(markup, /停止共享/);
});

test('他人共享中提供顶替共享；顶替需先确认，本端不出现停止观看', () => {
  const markup = render({
    targetSharerId: 'sharer-1',
    isViewing: true,
    shareSlotActiveId: 'sharer-1',
    localPeerId: 'me',
  });
  assert.match(markup, /顶替共享/);
  assert.match(markup, /结束并离开/);
  assert.doesNotMatch(markup, /停止观看/);
  assert.doesNotMatch(markup, /重新观看/);
  assert.doesNotMatch(markup, />\s*停止共享\s*</);
});

test('共享页固定左右两栏，互动卡常驻无需「加入聊天房间」', () => {
  const markup = render({
    isSharing: true,
    chat: {
      ...baseProps.chat,
      connected: true,
      messages: [{ id: 'm1', fromPeerId: 'me', ts: Date.now(), text: '你好' }],
    },
  });
  // 互动卡常驻：不依赖按钮展开，也不提供收起。
  assert.match(markup, /aria-label="房间聊天"/);
  assert.doesNotMatch(markup, /加入聊天房间/);
  assert.doesNotMatch(markup, /收起聊天/);
  assert.match(markup, /互动/);
  assert.match(markup, /语音/);
  // ≥lg 固定两栏：左屏幕共享、右互动，窄屏单列由 grid 自动堆叠。
  assert.match(markup, /lg:grid-cols-\[minmax\(0,1.4fr\)_minmax\(320px,1fr\)\]/);
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
      hadShareLink: true,
    },
  });

  assert.match(markup, /共享已中断/);
  assert.match(markup, /无法连接信令服务器，请检查网络后重试/);
  assert.match(markup, /此前分享的链接已失效/);
  assert.match(markup, /重新开始共享/);
  assert.doesNotMatch(markup, /正在共享/);
  assert.doesNotMatch(markup, /复制分享链接/);
});

test('房号登记就失败（从来没有链接）：说「未能开始共享」，不许断言旧链接已失效', () => {
  // 复现产品评审 B：首次开始共享时房号登记 429/连续超时，shareRoom 仍是 null，
  // 从未生成链接。旧实现硬编码「共享已中断 + 此前分享的链接已失效」，三句话互相矛盾。
  const markup = render({
    sharerFailure: {
      reason: 'signaling_failed',
      message: '创建共享房间过于频繁，请稍后再试',
      hadShareLink: false,
    },
  });

  assert.match(markup, /未能开始共享/);
  assert.match(markup, /创建共享房间过于频繁，请稍后再试/);
  assert.doesNotMatch(markup, /共享已中断/);
  assert.doesNotMatch(markup, /此前分享的链接已失效/);
  assert.match(markup, /重新开始共享/);
});

test('容量：保留实际观看人数，但不再展示建议人数/上限文案', () => {
  const markup = render({
    isSharing: true,
    isShareLive: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
    viewerCount: 5,
    recommendedViewerCount: 4,
    maxViewerCount: 6,
  });

  assert.match(markup, /5 人观看/);
  assert.doesNotMatch(markup, /建议 4 人同时观看（依网络），最多 6 人/);
  assert.doesNotMatch(markup, /超过建议人数/);
});

test('未开始时不再展示建议人数，且不渲染共享链接卡片', () => {
  const markup = render({ recommendedViewerCount: 4, maxViewerCount: 6 });

  assert.doesNotMatch(markup, /建议 4 人同时观看（依网络），最多 6 人/);
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

test('共享中同时提供停止共享（保留房间）与结束并离开（closeRoom）', () => {
  const markup = render({ isSharing: true });

  assert.match(markup, /停止共享/);
  assert.match(markup, /结束并离开/);
});

test('信令终态只留终态卡里的「重新开始共享」，不再重复一颗主按钮', () => {
  const markup = render({
    sharerFailure: {
      reason: 'signaling_failed',
      message: '无法连接信令服务器，请检查网络后重试',
      hadShareLink: true,
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

test('房号过期：链接卡里直接给一颗重建房号的按钮，而不是只留一行说明', () => {
  const markup = render({
    isSharing: true,
    isShareLive: true,
    shareRoomExpired: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  // 链接作废后画面还在，但新观众进不来：用户得能在这里一键重建房号。
  assert.match(markup, /重新开始共享/);
  assert.match(markup, /分享链接已失效，需要重新开始共享才能让新观众加入/);
  // 已经在共享中，不要再冒出「开始共享屏幕」这颗重复入口。
  assert.doesNotMatch(markup, /开始共享屏幕/);
});

test('重建耗尽 / 首连看门狗超时：终态卡用的是真实文案，且都带「重新开始共享」', () => {
  // 这两条路径以前没有任何自动化覆盖：分享端只会永久停在「正在连接服务器」。
  const exhausted = render({
    sharerFailure: { reason: 'signaling_failed', message: SHARER_RECONNECT_EXHAUSTED_MESSAGE, hadShareLink: true },
  });
  assert.match(exhausted, /信令连接持续失败，请刷新页面后重新开始共享/);
  assert.match(exhausted, /共享已中断/);
  assert.match(exhausted, /重新开始共享/);
  assert.match(exhausted, /此前分享的链接已失效/);

  const watchdog = render({
    sharerFailure: { reason: 'signaling_failed', message: SIGNALING_UNREACHABLE_MESSAGE, hadShareLink: true },
  });
  assert.match(watchdog, /无法连接信令服务器，请检查网络后重试/);
  assert.match(watchdog, /重新开始共享/);
});

test('限流冷却期内：显示服务端给的剩余秒数，并禁用「重新开始共享」', () => {
  const markup = render({
    sharerFailure: { reason: 'signaling_failed', message: '创建共享房间过于频繁，请稍后再试', hadShareLink: true },
    shareRoomRetrySeconds: 27,
  });

  assert.match(markup, /27 秒后可重试/);
  // 还能点的话用户只会再吃一次 429，把冷却期越拖越长。
  assert.match(markup, /disabled=""/);
});

test('冷却结束后「重新开始共享」恢复可点，倒计时也从界面上消失', () => {
  const markup = render({
    sharerFailure: { reason: 'signaling_failed', message: '无法连接信令服务器，请检查网络后重试', hadShareLink: true },
    shareRoomRetrySeconds: null,
  });

  assert.doesNotMatch(markup, /秒后可重试/);
  // 互动卡常驻后同屏还有其它禁用控件（聊天输入等），只确认「重新开始共享」这颗按钮没有被禁用。
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?重新开始共享/);
  assert.match(markup, /重新开始共享/);
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

test('观众被出口限流时「重试连接」禁用并显示倒计时', () => {
  const markup = render({
    error: '连接请求过多，请稍后再试',
    targetSharerId: 'sharer-1',
    viewerRetrySeconds: 27,
  });

  assert.match(markup, /重试连接/);
  assert.match(markup, /27 秒后可重试/);
  // 冷却期内按钮还能点的话，用户点一次就再吃一次 429，永远出不来。
  assert.match(markup, /disabled=""/);
});

test('观众没有冷却时不显示倒计时，也不禁用重试', () => {
  const markup = render({
    error: '连接请求过多，请稍后再试',
    targetSharerId: 'sharer-1',
    viewerRetrySeconds: null,
  });

  assert.match(markup, /重试连接/);
  assert.doesNotMatch(markup, /秒后可重试/);
  // 只断言「重试连接」这颗按钮，不误伤常驻互动卡里的禁用聊天控件。
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?重试连接/);
});

test('观众端错误终态只留重试/取消，不冒出发送端的「开始共享屏幕」', () => {
  const markup = render({
    error: '共享方长时间未恢复，屏幕共享已结束',
    targetSharerId: 'sharer-1',
  });

  assert.match(markup, /观看屏幕/);
  assert.match(markup, /重试连接/);
  assert.doesNotMatch(markup, /开始共享屏幕/);
  assert.doesNotMatch(markup, /与其他设备实时共享您的屏幕内容/);
});

test('房号过期卡说明「重新开始共享」会断开现有观众', () => {
  const markup = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: true,
    shareRoomExpired: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  assert.match(markup, /重新开始共享/);
  // 只说「新观众进不来」会让用户以为现有观众不受影响。
  assert.match(markup, /观众会断开/);
});

test('冷却期内主按钮禁用并显示倒计时：关掉终态卡也绕不过去', () => {
  const markup = render({ shareRoomRetrySeconds: 27, hasBeenReady: true });

  assert.match(markup, /开始共享屏幕/);
  assert.match(markup, /27 秒后可重试/);
  // 光断言 disabled="" 会被同屏的其它禁用按钮蒙混过去：要确认禁用的就是这颗主按钮。
  assert.match(markup, /<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?开始共享屏幕/);
});

test('冷却结束后主按钮恢复可用且不显示倒计时', () => {
  const markup = render({ shareRoomRetrySeconds: null, hasBeenReady: true });

  assert.match(markup, /开始共享屏幕/);
  assert.doesNotMatch(markup, /秒后可重试/);
  // 常驻互动卡的输入框天然禁用，这里只确认主按钮未被禁用。
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?开始共享屏幕/);
});

test('房号过期卡的「重新开始共享」在冷却期内同样禁用', () => {
  const markup = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: true,
    shareRoomExpired: true,
    shareRoomRetrySeconds: 12,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  assert.match(markup, /12 秒后可重试/);
  // 同屏的复制/分享按钮本来就是禁用的，必须确认禁用的是「重新开始共享」这颗。
  assert.match(markup, /<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?重新开始共享/);
});

test('通用错误条带关闭入口：信令抖一下留下的红条不该一直占着版面', () => {
  const markup = render({ error: '信令服务拒绝了当前会话，请重新开始共享' });

  assert.match(markup, /关闭提示/);
});

test('只是信令抖动时链接标题写「暂不可用」而不是「已失效」', () => {
  const markup = render({
    isSharing: true,
    isShareLive: false,
    isPeerReady: false,
    hasBeenReady: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  assert.match(markup, /title="分享链接暂不可用"/);
  assert.doesNotMatch(markup, /分享链接已失效/);
});

test('分享状态变化会被读屏播报：徽标区是 role=status 的实时区域', () => {
  const markup = render({
    isSharing: true,
    isShareLive: true,
    isPeerReady: true,
    shareLink: 'https://example.com/#/screen-share?view=AERO-abc',
  });

  assert.match(markup, /正在共享/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
});

test('观众「正在连接」是 polite 的 live region：读屏能听到还在连', () => {
  const markup = render({ isConnecting: true, targetSharerId: 'sharer-1' });

  assert.match(markup, /正在连接/);
  // 过程信息用 polite：不该打断用户正在听的内容。
  assert.match(markup, /role="status"[^>]*aria-live="polite"/);
});

test('通用错误红条是 assertive 的 live region：做不了事要立刻念出来', () => {
  const markup = render({ error: '无法获取屏幕采集权限，请重试' });

  assert.match(markup, /无法获取屏幕采集权限/);
  assert.match(markup, /role="alert"[^>]*aria-live="assertive"/);
});

test('观众错误 + 重试块的红条同样是 assertive', () => {
  const markup = render({ error: '找不到该分享者', targetSharerId: 'sharer-1' });

  assert.match(markup, /找不到该分享者/);
  assert.match(markup, /role="alert"[^>]*aria-live="assertive"/);
});

test('分享终态卡是 assertive 的 live region：分享已经停了，必须立刻播报', () => {
  const markup = render({
    sharerFailure: { reason: 'signaling_failed', message: SIGNALING_UNREACHABLE_MESSAGE, hadShareLink: true },
  });

  assert.match(markup, /共享已中断/);
  assert.match(markup, /role="alert"[^>]*aria-live="assertive"/);
});

/**
 * 取出包含 `attrAt` 的那个 `<div>` 的整段 markup（按标签配对切，不靠数偏移）。
 * 断言「某段内容不在 live region 里」必须对元素子树做否定匹配：算嵌套深度很容易把
 * 「alert 自己的开标签」漏掉，从而把「直接子节点」误判成「在外部」。
 */
const elementHtmlAt = (markup: string, attrAt: number): string => {
  const openStart = markup.lastIndexOf('<div', attrAt);
  assert.ok(openStart >= 0, '找不到包含该属性的 <div>');
  let depth = 0;
  const tag = /<\/?div(\s|>)/g;
  tag.lastIndex = openStart;
  for (let match = tag.exec(markup); match; match = tag.exec(markup)) {
    depth += match[0].startsWith('</div') ? -1 : 1;
    if (depth === 0) {
      return markup.slice(openStart, match.index + match[0].length);
    }
  }
  throw new Error('unbalanced <div> in markup');
};

test('没有冷却时不会渲染出 undefined 秒后可重试', () => {
  const markup = render({
    sharerFailure: { reason: 'signaling_failed', message: SIGNALING_UNREACHABLE_MESSAGE, hadShareLink: true },
  });

  assert.doesNotMatch(markup, /undefined 秒后可重试/);
  assert.doesNotMatch(markup, /秒后可重试/);
});

test('终态卡的冷却倒计时不在 live region 里：每秒变一次，进去会整卡重播', () => {
  const markup = render({
    sharerFailure: { reason: 'signaling_failed', message: SIGNALING_UNREACHABLE_MESSAGE, hadShareLink: true },
    shareRoomRetrySeconds: 60,
  });

  const alertAt = markup.indexOf('role="alert"');
  const countdownAt = markup.indexOf('60 秒后可重试');
  assert.ok(alertAt >= 0 && countdownAt > alertAt, '终态卡与倒计时应当同时出现');

  const alertHtml = elementHtmlAt(markup, alertAt);
  assert.match(alertHtml, /共享已中断/);
  assert.doesNotMatch(
    alertHtml,
    /秒后可重试/,
    '倒计时每秒变一次，放进 role=alert 子树会让读屏每秒重播整段原因'
  );
  assert.doesNotMatch(alertHtml, /重新开始共享/, '可聚焦按钮也不该被当成状态通告播报');
  // 倒计时本身仍然可见，只是搬到了 live region 外面，并被按钮用 aria-describedby 引用。
  assert.match(markup, /id="share-terminal-cooldown-hint"[^>]*>\s*60 秒后可重试/);
  assert.match(markup, /aria-describedby="share-terminal-cooldown-hint"/);
  assert.match(markup, /重新开始共享/);
  assert.match(markup, /disabled/);
});

test('观众倒计时有自己的 live region，且按 10 秒一档播报', () => {
  const markup = render({ error: '连接请求过多，请稍后再试', targetSharerId: 'sharer-1', viewerRetrySeconds: 27 });

  assert.match(markup, /27 秒后可重试/);
  // 视觉上的秒数不进 live region（否则每秒一次播报），只留 sr-only 的粗粒度播报。
  assert.match(markup, /aria-hidden="true"[^>]*>27 秒后可重试|aria-hidden="true">27 秒后可重试/);
  assert.match(markup, /30 秒内可重试/);
  assert.match(markup, /role="status"[^>]*aria-live="polite"[^>]*>30 秒内可重试/);
});

test('「取消连接」按钮不在 live region 子树里：按钮不该被当成状态更新播报', () => {
  const markup = render({ isConnecting: true, targetSharerId: 'sharer-1' });

  const statusAt = markup.indexOf('role="status"');
  const cancelAt = markup.indexOf('取消连接');
  assert.ok(statusAt >= 0 && cancelAt > statusAt, '连接阶段与取消按钮应当同时出现');

  const statusHtml = elementHtmlAt(markup, statusAt);
  assert.match(statusHtml, /正在连接/);
  assert.doesNotMatch(statusHtml, /取消连接/, '取消按钮必须在 role=status 容器外部');
});

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Monitor, StopCircle, Play, Pause, AlertCircle, Copy, Check, Share2, Eye, Loader2, RefreshCw, X, MonitorUp, Maximize, Minimize, Volume2, VolumeX, PictureInPicture, AlertTriangle, LogOut, MessageCircle } from 'lucide-react';
import { ChatPanel, type ChatPanelMessage } from './ChatPanel';
import type { RoomVoiceApi } from '../../services/voice/useRoomVoice';

export type ScreenShareViewerConnectingStage = 'fetching_ice' | 'connecting_signaling' | 'connecting_media' | 'waiting_stream' | '';

interface ScreenShareUIProps {
  isSharing: boolean;
  isViewing: boolean;
  isConnecting: boolean;
  viewerConnectingStage: ScreenShareViewerConnectingStage;
  error: string | null;
  targetSharerId: string | null;
  cancelConnecting: () => void;
  retryConnection: () => void;
  dismissConnectionError: () => void;
  /** 只收起通用错误条：不动会话/观众状态。 */
  dismissError: () => void;
  viewerVideoRef: (video: HTMLVideoElement | null) => void;
  needsPlayClick: boolean;
  onViewerPlayClick: () => void;
  stopViewing: () => void;
  /** 共享端停止共享后房间与聊天仍保留：给共享端显示占位与「开始共享」。 */
  roomRetained?: boolean;
  /** 共享端已停止发送画面（房间还在）；画面区显示「共享已暂停」占位。 */
  sharePaused?: boolean;
  /** 共享端占位态主按钮：复用现有 startScreenShare。 */
  onResumeShare?: () => void;
  /** 观看端画面暂停（分享方停共享或本端停止观看），独立于 isConnecting。 */
  viewerSharePaused?: boolean;
  /** 观看端正在同一容器内自动重连画面（无按钮，仅状态提示）。 */
  viewerReconnecting?: boolean;
  /** 房间级共享槽当前 active 的 peerId；null = 空闲。 */
  shareSlotActiveId?: string | null;
  /** 本端 peerId：判断当前 active 是否是自己。 */
  localPeerId?: string | null;
  /** 观看端在「他人共享中」发起顶替（UI 已做二次确认）。 */
  onTakeoverShare?: () => void;

  /** 房间语音 API：与聊天同卡，语音页接真实麦克风控件。 */
  voice?: RoomVoiceApi;

  /** 房间聊天浮层的展示状态与回调，由 ScreenShare 提供。 */
  chat: {
    role: 'sender' | 'viewer';
    open: boolean;
    connected: boolean;
    messages: ChatPanelMessage[];
    onToggle: () => void;
    onClose: () => void;
    onSend: (text: string) => void;
    onExport: () => void;
  };
  qualityLabels: Record<'high' | 'medium' | 'low', string>;
  remoteQuality: 'high' | 'medium' | 'low';
  shareLink: string | null;
  copyShareLink: () => void;
  copied: boolean;
  isPeerReady: boolean;
  /** 绿色「正在共享」的唯一条件：已登记且信令健康。 */
  isShareLive: boolean;
  /** 房号续期连续失败：画面照常，但链接快到期了，不能再显示「一切正常」。 */
  shareRoomRenewalWarning: boolean;
  /** 房号已过期：链接作废，不能再显示成可用链接，也不能配绿色 LIVE。 */
  shareRoomExpired: boolean;
  /** 是否曾经连上过信令：区分「首连中」与「连上又断」，文案不同。 */
  hasBeenReady: boolean;
  /** hadShareLink=false：这次共享从来没生成过链接（房号登记被拒/超时），不能说「链接已失效」。 */
  sharerFailure: { reason: 'signaling_failed'; message: string; hadShareLink: boolean } | null;
  dismissSharerFailure: () => void;
  /** 限流冷却剩余秒数；null = 没有冷却。有值时不能重新登记房号，按钮要禁用并显示倒计时。 */
  shareRoomRetrySeconds: number | null;
  /** 观众建连被限流后的冷却剩余秒数；null = 没有冷却。有值时禁用「重试连接」并显示倒计时。 */
  viewerRetrySeconds: number | null;
  recommendedViewerCount: number;
  maxViewerCount: number;
  viewerCount: number;
  qualityLevel: 'high' | 'medium' | 'low';
  sharerVideoRef: React.RefObject<HTMLVideoElement | null>;
  changeScreenSource: () => void;
  startScreenShare: () => void;
  stopScreenShare: () => void;
  /** 主持端「结束并离开」：closeRoom 全断（销毁 peer、撤销房号、清聊天），与停止共享（保留房间）语义分开。 */
  onEndRoom: () => void;
}


/**
 * 房内共享界面状态是纯函数：把「谁在共享、我现在是什么视角、聊天入口是否可见」
 * 这些判定从组件 render 里抽出来，既方便单测覆盖组合矩阵，也避免每个分支各写一遍。
 */
export function isShareLinkUsable(isShareLive: boolean, shareRoomExpired: boolean): boolean {
  return isShareLive && !shareRoomExpired;
}

export function isSlotActiveForOther(
  shareSlotActiveId: string | null | undefined,
  localPeerId: string | null | undefined
): boolean {
  return Boolean(shareSlotActiveId && localPeerId && shareSlotActiveId !== localPeerId);
}

export function deriveIsViewerSession(input: {
  isViewing: boolean;
  targetSharerId: string | null;
  viewerSharePaused: boolean;
  slotActiveIsOther: boolean;
}): boolean {
  return (
    input.isViewing ||
    Boolean(input.targetSharerId) ||
    input.viewerSharePaused ||
    input.slotActiveIsOther
  );
}

export function deriveIsInRoomShell(input: {
  isSharing: boolean;
  isViewerSession: boolean;
  roomRetained: boolean;
  sharePaused: boolean;
}): boolean {
  return input.isSharing || input.isViewerSession || input.roomRetained || input.sharePaused;
}

export function deriveIsShareSlotIdle(input: {
  inRoomShell: boolean;
  isSharing: boolean;
  isViewing: boolean;
  isConnecting: boolean;
  viewerSharePaused: boolean;
  slotActiveIsOther: boolean;
}): boolean {
  return (
    input.inRoomShell &&
    !input.isSharing &&
    !input.isViewing &&
    !input.isConnecting &&
    !input.viewerSharePaused &&
    !input.slotActiveIsOther
  );
}

export function indexViewerStage(
  stage: ScreenShareViewerConnectingStage,
  steps: readonly ScreenShareViewerConnectingStage[]
): number {
  return stage ? steps.indexOf(stage) : -1;
}

export function deriveIsChatEntryVisible(input: {
  inRoomShell: boolean;
  chatConnected: boolean;
  messageCount: number;
  viewerFullscreen: boolean;
}): boolean {
  return (
    (input.inRoomShell || input.chatConnected || input.messageCount > 0) &&
    !input.viewerFullscreen
  );
}

export function deriveIsChatPanelVisible(chatEntryVisible: boolean, chatOpen: boolean): boolean {
  return chatEntryVisible && chatOpen;
}

export const ScreenShareUI: React.FC<ScreenShareUIProps> = ({
  isSharing,
  isViewing,
  isConnecting,
  viewerConnectingStage,
  error,
  targetSharerId,
  cancelConnecting,
  retryConnection,
  dismissConnectionError,
  dismissError,
  viewerVideoRef,
  needsPlayClick,
  onViewerPlayClick,
  stopViewing,
  roomRetained = false,
  sharePaused = false,
  onResumeShare,
  viewerSharePaused = false,
  viewerReconnecting = false,
  shareSlotActiveId = null,
  localPeerId = null,
  onTakeoverShare,
  voice,
  chat,
  qualityLabels,
  remoteQuality,
  shareLink,
  copyShareLink,
  copied,
  isShareLive,
  shareRoomRenewalWarning,
  shareRoomExpired,
  hasBeenReady,
  sharerFailure,
  dismissSharerFailure,
  shareRoomRetrySeconds,
  viewerRetrySeconds,
  viewerCount,
  qualityLevel,
  sharerVideoRef,
  changeScreenSource,
  startScreenShare,
  stopScreenShare,
  onEndRoom,
}) => {
  // 链接可用 = 信令就绪 且 房号没过期。任一不成立，这个链接就指向一个连不上的分享。
  const linkUsable = isShareLinkUsable(isShareLive, shareRoomExpired);
  // 只要还在房间里，就保持共享工具条/聊天入口，而不是退回大标题落地页。
  // 房间共享槽：active 是别人 → watching（可顶替）；active 是自己时仍算共享端，
  // 不能因为槽里有值就把自己当成观看端，否则顶替成功后界面不会切到共享工具条。
  const slotActiveIsOther = isSlotActiveForOther(shareSlotActiveId, localPeerId);
  const isViewerSession = deriveIsViewerSession({
    isViewing,
    targetSharerId,
    viewerSharePaused,
    slotActiveIsOther,
  });
  const inRoomShell = deriveIsInRoomShell({
    isSharing,
    isViewerSession,
    roomRetained,
    sharePaused,
  });
  const slotIdle = deriveIsShareSlotIdle({
    inRoomShell,
    isSharing,
    isViewing,
    isConnecting,
    viewerSharePaused,
    slotActiveIsOther,
  });
  const reduceMotion = useReducedMotion();

  // 观看端建连的四个阶段：把「系统正在做什么」摊成一条可见的进度轨，
  // 而不是只留一个转圈图标（.impeccable：动效要成为系统在工作的证据）。
  const viewerStageSteps = ['fetching_ice', 'connecting_signaling', 'connecting_media', 'waiting_stream'] as const;
  const viewerStageIndex = indexViewerStage(viewerConnectingStage, viewerStageSteps);

  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerElRef = useRef<HTMLVideoElement | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const [viewerPlaying, setViewerPlaying] = useState(true);
  const [viewerMuted, setViewerMuted] = useState(false);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [pipSupported, setPipSupported] = useState(false);
  const [viewerPip, setViewerPip] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showTakeoverConfirm, setShowTakeoverConfirm] = useState(false);

  const attachViewerVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      viewerElRef.current = element;
      viewerVideoRef(element);
    },
    [viewerVideoRef]
  );

  const syncViewerState = useCallback(() => {
    const element = viewerElRef.current;
    if (!element) return;
    setViewerPlaying(!element.paused);
    setViewerMuted(element.muted);
    if (element.paused) setControlsVisible(true);
  }, []);

  useEffect(() => {
    setPipSupported(document.pictureInPictureEnabled === true);
  }, []);

  useEffect(() => {
    const element = viewerElRef.current;
    if (!element) return;
    syncViewerState();
    const handleEnterPip = () => setViewerPip(true);
    const handleLeavePip = () => setViewerPip(false);
    element.addEventListener('play', syncViewerState);
    element.addEventListener('pause', syncViewerState);
    element.addEventListener('volumechange', syncViewerState);
    element.addEventListener('enterpictureinpicture', handleEnterPip);
    element.addEventListener('leavepictureinpicture', handleLeavePip);
    return () => {
      element.removeEventListener('play', syncViewerState);
      element.removeEventListener('pause', syncViewerState);
      element.removeEventListener('volumechange', syncViewerState);
      element.removeEventListener('enterpictureinpicture', handleEnterPip);
      element.removeEventListener('leavepictureinpicture', handleLeavePip);
    };
  }, [isViewing, syncViewerState]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setViewerFullscreen(document.fullscreenElement === viewerContainerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (hideControlsTimerRef.current !== null) window.clearTimeout(hideControlsTimerRef.current);
    };
  }, []);

  // 控件条只包一层渐变，鼠标停留时显形；遮挡画面时间越长越好，因为这是观看态。
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current !== null) window.clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(Boolean(viewerElRef.current?.paused));
    }, 2600);
  }, []);

  const concealControls = useCallback(() => {
    if (hideControlsTimerRef.current !== null) window.clearTimeout(hideControlsTimerRef.current);
    if (!viewerElRef.current?.paused) setControlsVisible(false);
  }, []);

  const toggleViewerPlay = useCallback(() => {
    const element = viewerElRef.current;
    if (!element) return;
    if (element.paused) {
      void element.play().catch(() => {});
    } else {
      element.pause();
    }
    revealControls();
  }, [revealControls]);

  const toggleViewerMute = useCallback(() => {
    const element = viewerElRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setViewerMuted(element.muted);
    revealControls();
  }, [revealControls]);

  const toggleViewerPictureInPicture = useCallback(async () => {
    const element = viewerElRef.current;
    if (!element || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await element.requestPictureInPicture();
      }
    } catch {
      // 浏览器可能拒绝（画面尚未就绪、或正处于系统全屏）：保持原状，不改按钮状态
    }
    revealControls();
  }, [revealControls]);

  const toggleViewerFullscreen = useCallback(() => {
    const container = viewerContainerRef.current;
    const element = viewerElRef.current;
    if (!container || !element) return;
    if (document.fullscreenElement) {
      if (typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => {});
      }
      return;
    }
    if (typeof container.requestFullscreen === 'function') {
      void container.requestFullscreen().catch(() => {});
      return;
    }
    // iOS Safari 只允许 video 元素自身进入全屏，走原生播放器界面。
    (element as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  }, []);

  // 系统分享面板（移动端、Chrome/Edge 桌面可用）；不支持时退回复制，避免按钮点了没反应。
  const shareLinkToApps = useCallback(() => {
    if (!shareLink) return;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator.share({ title: 'AeroDrop 屏幕共享', url: shareLink }).catch(() => {
        // 用户取消、或系统拒绝分享：保持界面不变
      });
      return;
    }
    copyShareLink();
  }, [shareLink, copyShareLink]);

  // 右侧「互动」卡默认收起：主卡里先给一个「加入聊天房间」按钮，点击才展开。
  // 停止共享只停画面、不断房间，所以聊天入口仍要保留；全屏观看时让位给画面。
  const chatEntryVisible = deriveIsChatEntryVisible({
    inRoomShell,
    chatConnected: chat.connected,
    messageCount: chat.messages.length,
    viewerFullscreen,
  });
  const showChat = deriveIsChatPanelVisible(chatEntryVisible, chat.open);

  const chatEntryButton = chatEntryVisible ? (
    <button
      type="button"
      onClick={chat.onToggle}
      aria-expanded={chat.open}
      aria-controls="room-chat-panel"
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
    >
      <MessageCircle size={15} />
      {chat.open ? '收起聊天' : '加入聊天房间'}
      {chat.messages.length > 0 && (
        <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-xs leading-none text-white">
          {chat.messages.length}
        </span>
      )}
    </button>
  ) : null;

  return (
    <div className="w-full mx-auto">
      <div
        className={`grid items-stretch gap-4 mx-auto ${
          showChat ? 'max-w-5xl lg:grid-cols-[minmax(0,1fr)_22rem]' : 'max-w-xl'
        }`}
      >
        <div className="min-w-0 bg-white rounded-card shadow-card border border-slate-100 p-6 md:p-8 transition-colors motion-base animate-slide-up">
        {/* 共享 / 观看中把装饰性大头部压成工具条式紧凑头部：Meet / Zoom 进入「正在
            共享」态后都会收起介绍性大标题，把纵向空间让给画面和操作；未开始时保
            留图标 + 标题的引导性头部。 */}
        {inRoomShell ? (
          <div className="mb-6 flex items-center gap-3">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-slate-100 ring-1 ring-slate-200">
              {isViewerSession ? (
                <Eye size={20} className="text-brand-600" />
              ) : (
                <Monitor size={20} className="text-brand-600" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-brand-600/70">
                Screen Share
              </p>
              <h2 className="truncate text-lg font-bold leading-tight text-slate-900">
                {isViewerSession ? '观看屏幕' : '屏幕共享'}
              </h2>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
        {isViewing && (
                <p className="hidden min-w-0 truncate text-xs text-slate-500 xl:block">
                  实时观看对方共享的屏幕内容
                </p>
              )}
              {chatEntryButton}
            </div>
          </div>
        ) : (
          <>
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-slate-100 rounded-card mb-4 ring-1 ring-slate-200">
              {isConnecting || targetSharerId ? (
                <Eye size={32} className="text-brand-600" />
              ) : (
                <Monitor size={32} className="text-brand-600" />
              )}
            </div>
            <h2 className="text-xl font-bold text-slate-900">
              {isConnecting ? '正在连接...' : targetSharerId ? '观看屏幕' : '屏幕共享'}
            </h2>
            {!isConnecting && !targetSharerId && (
              <p className="mt-2 text-sm text-slate-500">
                与其他设备实时共享您的屏幕内容
              </p>
            )}
          </div>
          {chatEntryButton && <div className="mb-6 flex justify-end">{chatEntryButton}</div>}
          </>
        )}

        {error && !(targetSharerId && !isConnecting && !isViewing && !isSharing) && (
          /* 阻断性错误（采集失败、信令拒绝、超时）要立刻念出来：这是「现在做不了事」，
             不是「稍后会好」的过程信息，所以用 assertive 而不是 polite。 */
          <div
            role="alert"
            aria-live="assertive"
            className="mb-6 p-4 bg-red-50 border border-red-200 rounded-card flex items-start gap-3"
          >
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="min-w-0 flex-1 text-sm break-words text-red-700">{error}</span>
            {/* 信令抖一下就会落一条错误：没有关闭入口的话它会一直占着版面，
                而且和真实状态（画面还在）互相矛盾。 */}
            <button
              onClick={dismissError}
              className="inline-flex min-w-8 min-h-8 shrink-0 items-center justify-center rounded-control text-red-500 transition-colors hover:bg-red-100"
              aria-label="关闭提示"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {isConnecting && (
          /* 连接阶段是过程信息：读屏用户需要知道「还在连」，但不该打断正在听的内容。 */
          <div
            role="status"
            aria-live="polite"
            className="mb-6 flex flex-col items-center justify-center py-12"
          >
            <Loader2 size={32} className="text-brand-600 animate-spin mb-4" />
            <p className="text-sm text-slate-600 font-medium mb-4">
              {viewerConnectingStage === 'fetching_ice' && '正在获取网络配置...'}
              {viewerConnectingStage === 'connecting_signaling' && '正在连接信号服务器...'}
              {viewerConnectingStage === 'connecting_media' && '正在建立媒体通道...'}
              {viewerConnectingStage === 'waiting_stream' && '正在等待屏幕画面...'}
              {!viewerConnectingStage && '正在连接到屏幕共享...'}
            </p>
            {/* 四段进度：已完成段变浅蓝短线、当前段拉长，给「还在推进」一个可见的节奏。 */}
            <div className="flex items-center gap-2" aria-hidden="true">
              {viewerStageSteps.map((step, index) => {
                const done = viewerStageIndex >= 0 && index < viewerStageIndex;
                const active = index === viewerStageIndex;
                return (
                  <span
                    key={step}
                    className={`h-1.5 rounded-full transition-width motion-base ${
                      active
                        ? 'w-7 bg-brand-500'
                        : done
                          ? 'w-3.5 bg-brand-300'
                          : 'w-3.5 bg-slate-200'
                    }`}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* 操作按钮放在 live region 外面：读屏只该听见「还在连」，不该把按钮念成状态更新。 */}
        {isConnecting && (
          <div className="mb-6 flex justify-center">
            <button
              onClick={cancelConnecting}
              className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800 border border-slate-300 rounded-full hover:bg-slate-100 transition-colors"
            >
              <X size={16} />
              取消连接
            </button>
          </div>
        )}

        {error && !isConnecting && !isViewing && !isSharing && targetSharerId && (
          <div className="mb-6">
            <div
              role="alert"
              aria-live="assertive"
              className="p-4 bg-red-50 border border-red-200 rounded-card flex items-center gap-3 mb-4"
            >
              <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
              <span className="min-w-0 text-sm break-words text-red-700">{error}</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={retryConnection}
                disabled={typeof viewerRetrySeconds === 'number'}
                aria-describedby={
                  typeof viewerRetrySeconds === 'number' ? 'viewer-retry-cooldown-hint' : undefined
                }
                className="flex items-center justify-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-600"
              >
                <RefreshCw size={16} />
                重试连接
              </button>
              <button
                onClick={dismissConnectionError}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-slate-600 hover:text-slate-800 border border-slate-300 rounded-full hover:bg-slate-100 transition-colors"
              >
                <X size={16} />
                取消
              </button>
              {/* 被出口限流时立刻重试只会再吃一次 429：把还要等多久摆出来，按钮同时禁用。 */}
              {typeof viewerRetrySeconds === 'number' && (
                <span
                  className="text-xs text-red-600/80 tabular-nums"
                  aria-hidden="true"
                >
                  {viewerRetrySeconds} 秒后可重试
                </span>
              )}
              {/* 倒计时本身每秒都在变，直接进 live region 会变成每秒一次播报；
                  这里按 10 秒一档播一次，视觉上的秒数用 aria-hidden 挡住。 */}
              {typeof viewerRetrySeconds === 'number' && (
                <span id="viewer-retry-cooldown-hint" className="sr-only" role="status" aria-live="polite">
                  {`${Math.ceil(viewerRetrySeconds / 10) * 10} 秒内可重试`}
                </span>
              )}
            </div>
          </div>
        )}

        {viewerSharePaused && (
          <div
            role="status"
            aria-live="polite"
            aria-busy={viewerReconnecting || undefined}
            className="relative mb-4 aspect-video overflow-hidden rounded-card border border-slate-200 bg-slate-100"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.23, 1, 0.32, 1] }}
              className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
            >
              <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-control bg-white text-slate-500 ring-1 ring-slate-200">
                <Eye size={24} />
              </div>
              <p className="text-base font-bold text-slate-900">共享已停止</p>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                房间与聊天仍保留，等待共享者重新开始共享。
              </p>
              {viewerReconnecting && (
                <p className="mt-3 inline-flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 size={16} className="animate-spin" />
                  正在重新连接屏幕共享…
                </p>
              )}
            </motion.div>
          </div>
        )}

        {isViewing && (
          <>
            <div
              ref={viewerContainerRef}
              className={`mb-4 relative group overflow-hidden bg-slate-900 border border-slate-200 ${
                viewerFullscreen ? 'flex h-screen items-center justify-center rounded-none' : 'rounded-card'
              }`}
              onPointerEnter={revealControls}
              onPointerMove={revealControls}
              onPointerLeave={concealControls}
            >
              <video
                ref={attachViewerVideo}
                autoPlay
                playsInline
                onClick={toggleViewerPlay}
                className={`block w-full object-contain ${viewerFullscreen ? 'max-h-full' : 'aspect-video'}`}
              />

              {/* 观看状态与画质叠进画面，与共享者一侧的 LIVE 徽标同构，
                  不再在播放器下方单独占一行。 */}
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-black/55 p-3">
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white ring-1 ring-white/15">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
                  </span>
                  正在观看
                </span>
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-xs font-medium tabular-nums text-white ring-1 ring-white/15">
                    画质 {qualityLabels[remoteQuality]}
                  </span>
                </span>
              </div>

              {/* 自绘控件条：原生 controls 与页面气质不符，直播画面又不需要进度条，
                  所以只留播放/静音/画中画/全屏。指针活动时显形，暂停时常驻。 */}
              <div
                className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/55 p-3 transition-opacity motion-base ${
                  controlsVisible ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <button
                  type="button"
                  onClick={toggleViewerPlay}
                  aria-label={viewerPlaying ? '暂停' : '播放'}
                  title={viewerPlaying ? '暂停' : '播放'}
                  className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-control bg-black/50 text-white ring-1 ring-white/15 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {viewerPlaying ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <button
                  type="button"
                  onClick={toggleViewerMute}
                  aria-label={viewerMuted ? '取消静音' : '静音'}
                  title={viewerMuted ? '取消静音' : '静音'}
                  className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-control bg-black/50 text-white ring-1 ring-white/15 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {viewerMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
                <span className="flex-1" />
                {pipSupported && (
                  <button
                    type="button"
                    onClick={() => {
                      void toggleViewerPictureInPicture();
                    }}
                    aria-label={viewerPip ? '退出画中画' : '画中画'}
                    title={viewerPip ? '退出画中画' : '画中画'}
                    className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-control bg-black/50 text-white ring-1 ring-white/15 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    <PictureInPicture size={18} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleViewerFullscreen}
                  aria-label={viewerFullscreen ? '退出全屏' : '全屏'}
                  title={viewerFullscreen ? '退出全屏' : '全屏'}
                  className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-control bg-black/50 text-white ring-1 ring-white/15 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {viewerFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
              </div>

              {needsPlayClick && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 cursor-pointer"
                  onClick={onViewerPlayClick}
                >
                  <div className="w-16 h-16 rounded-control bg-white/20 flex items-center justify-center mb-3">
                    <Play size={32} className="text-white ml-1" fill="white" />
                  </div>
                  <p className="text-white text-sm">点击开始观看</p>
                </div>
              )}
            </div>

          </>
        )}

        {slotActiveIsOther && (
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={() => setShowTakeoverConfirm(true)}
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border border-amber-700/20 bg-amber-50 px-4 text-sm font-bold text-amber-700 transition-colors motion-fast hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 active:scale-[0.985]"
            >
              <MonitorUp size={18} />
              顶替共享
            </button>
            <button
              onClick={() => setShowEndConfirm(true)}
              className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-red-200 bg-white px-4 text-sm font-bold text-red-600 transition-ui motion-fast hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 active:scale-[0.985]"
            >
              <LogOut size={18} />
              结束并离开
            </button>
          </div>
        )}

        {!isViewing && !isConnecting && (
          <>
            {sharerFailure && !isSharing && (
              /* 信令终态：不能只弹 toast。绿色 LIVE 消失、预览停止、链接作废，
                 这里说明原因并给一条重新开始的路。 */
              <div className="mb-4 rounded-card border border-red-200 bg-red-50 p-4">
                {/* live region 只包住「发生了什么」：按钮和每秒变化的倒计时都不能进来，
                    否则读屏会把可聚焦控件当通告、或每秒重播整段原因。 */}
                <div role="alert" aria-live="assertive">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-500" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-red-700">
                        {sharerFailure.hadShareLink ? '共享已中断' : '未能开始共享'}
                      </p>
                      <p className="mt-1 break-words text-sm text-red-700/90">{sharerFailure.message}</p>
                      {/* 没有链接时不能说「此前分享的链接已失效」：那句话会让人以为刚发出去的
                          链接死了，而实际上观众从来没拿到过链接。 */}
                      {sharerFailure.hadShareLink && (
                        <p className="mt-1 text-xs text-red-600/80">
                          此前分享的链接已失效，观众无法再加入。
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={startScreenShare}
                    disabled={typeof shareRoomRetrySeconds === 'number'}
                    aria-describedby={
                      typeof shareRoomRetrySeconds === 'number' ? 'share-terminal-cooldown-hint' : undefined
                    }
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-600"
                  >
                    <Play size={16} fill="currentColor" />
                    重新开始共享
                  </button>
                  <button
                    onClick={dismissSharerFailure}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-slate-300 px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    <X size={16} />
                    关闭
                  </button>
                  {/* 服务端已经告诉我们还要等多久：把秒数显示出来，比只留一个灰按钮有用。
                      它在 alert 之外、并被按钮的 aria-describedby 引用。 */}
                  {typeof shareRoomRetrySeconds === 'number' && (
                    <span
                      id="share-terminal-cooldown-hint"
                      className="text-xs text-red-600/80 tabular-nums"
                    >
                      {shareRoomRetrySeconds} 秒后可重试
                    </span>
                  )}
                </div>
              </div>
            )}

            {isSharing && shareLink && (
              <div className="mb-4 rounded-card border border-slate-200/80 bg-slate-50/70 px-4 py-3 ring-1 ring-white/50">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${linkUsable ? 'bg-green-500' : 'bg-amber-500'}`} />
                    <p className="text-xs font-semibold uppercase text-slate-500">
                      实时链接
                    </p>
                  </div>
                  {viewerCount > 0 && (
                    /* pr-3 让文字右缘与下方 44px 图标按钮的可见图标右缘对齐
                       （图标 18px 居中，左右各留 13px 内边距） */
                    <span className="inline-flex shrink-0 items-center gap-1 pr-3 text-xs font-medium text-slate-600 tabular-nums">
                      <Eye size={16} />
                      {viewerCount} 人观看
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 rounded-control bg-white px-3 py-1 ring-1 ring-slate-200/80">
                  <a
                    href={shareLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-disabled={!linkUsable}
                    /* 失效链接不能只靠 pointer-events 拦鼠标：键盘 Tab 仍会聚焦到一个
                       aria-disabled 的链接上。直接移出焦点序列。 */
                    tabIndex={linkUsable ? undefined : -1}
                    className={`flex-1 min-w-0 text-sm font-mono truncate ${
                      linkUsable
                        ? 'text-brand-600 hover:underline'
                        : 'text-slate-400 pointer-events-none'
                    }`}
                    title={shareLink}
                  >
                    {shareLink}
                  </a>
                  <button
                    onClick={copyShareLink}
                    disabled={!linkUsable}
                    className="inline-flex min-w-11 min-h-11 shrink-0 items-center justify-center rounded-control text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                    title={linkUsable ? '复制分享链接' : shareRoomExpired ? '分享链接已失效' : '分享链接暂不可用'}
                    aria-label="复制分享链接"
                  >
                    {copied ? (
                      <Check size={18} className="text-green-500" />
                    ) : (
                      <Copy size={18} />
                    )}
                  </button>
                  <button
                    onClick={shareLinkToApps}
                    disabled={!linkUsable}
                    className="inline-flex min-w-11 min-h-11 shrink-0 items-center justify-center rounded-control text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                    title={linkUsable ? '分享链接' : shareRoomExpired ? '分享链接已失效' : '分享链接暂不可用'}
                    aria-label="分享链接"
                  >
                    <Share2 size={18} />
                  </button>
                </div>
                {shareRoomExpired && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {/* 链接作废后画面还在，但新观众进不来：这里必须有直接重建房号的入口，
                        不能只剩一行「需要重新开始共享」让用户自己去找。 */}
                    <button
                      onClick={startScreenShare}
                      disabled={typeof shareRoomRetrySeconds === 'number'}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-600"
                    >
                      <RefreshCw size={16} />
                      重新开始共享
                    </button>
                    {typeof shareRoomRetrySeconds === 'number' && (
                      <span className="text-xs text-amber-600 tabular-nums">
                        {shareRoomRetrySeconds} 秒后可重试
                      </span>
                    )}
                    <span className="text-xs text-amber-600">
                      分享链接已失效，需要重新开始共享才能让新观众加入；重新开始会新建房间，正在观看的观众会断开
                    </span>
                  </div>
                )}
                {!shareRoomExpired && !isShareLive && (
                  <p className="mt-1.5 text-xs text-amber-600">
                    {hasBeenReady ? '信令中断，新观众暂时无法加入' : '正在连接服务器，连上后新观众即可加入'}
                  </p>
                )}
                {linkUsable && shareRoomRenewalWarning && (
                  <p className="mt-1.5 text-xs text-amber-600">
                    分享链接续期失败，到期后观众将无法再加入
                  </p>
                )}
              </div>
            )}

            {(isSharing || sharePaused) && (
              <div className="relative mb-4 aspect-video overflow-hidden rounded-card border border-slate-200 bg-slate-900">
                <video
                  ref={sharerVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`absolute inset-0 h-full w-full object-contain transition-opacity motion-base ${
                    isSharing ? 'opacity-100' : 'pointer-events-none opacity-0'
                  }`}
                />

                {sharePaused && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="absolute inset-0 flex flex-col items-center justify-center bg-slate-100 px-6 text-center"
                  >
                    <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-control bg-white text-slate-500 ring-1 ring-slate-200">
                      <Monitor size={24} />
                    </div>
                    <p className="text-base font-bold text-slate-900">共享已暂停</p>
                    <p className="mt-1 max-w-sm text-sm text-slate-500">
                {viewerCount > 0
                  ? '没有在发送屏幕画面。房间、聊天和观看者都还在。'
                  : '没有在发送屏幕画面。房间与聊天仍保留。'}
              </p>
                    <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                      <span className="h-2 w-2 rounded-full bg-amber-500" />
                      已停止 · 房间保留
                    </span>
                  </div>
                )}

                {isSharing && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-black/55 p-3"
                  >
                    {linkUsable ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white ring-1 ring-white/15">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
                        </span>
                        正在共享
                      </span>
                    ) : shareRoomExpired ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-700 px-2.5 py-1 text-xs font-medium text-white">
                        <AlertTriangle size={16} />
                        链接已失效
                      </span>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-700 px-2.5 py-1 text-xs font-medium text-white">
                        <Loader2 size={16} className="animate-spin" />
                        {hasBeenReady ? '正在重连服务器...' : '正在连接服务器...'}
                      </span>
                    )}
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-xs font-medium tabular-nums text-white ring-1 ring-white/15">
                        画质 {qualityLabels[qualityLevel]}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            )}

            {slotIdle && (
              <>
                <div
                  role="status"
                  aria-live="polite"
                  className="relative mb-4 aspect-video overflow-hidden rounded-card border border-slate-200 bg-slate-100"
                >
                  <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                    <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-control bg-white text-slate-500 ring-1 ring-slate-200">
                      <Monitor size={24} />
                    </div>
                    <p className="text-base font-bold text-slate-900">还没有人共享屏幕</p>
                    <p className="mt-1 max-w-sm text-sm text-slate-500">
                      房间、聊天和语音都还在，任何人都可以开始共享。
                    </p>
                  </div>
                </div>
                <div className="mb-4 flex items-center gap-2">
                  <button
                    onClick={startScreenShare}
                    className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-brand-600 px-4 text-sm font-bold text-white transition-colors motion-fast hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 active:scale-[0.985]"
                  >
                    <Play size={18} fill="currentColor" />
                    开始共享
                  </button>
                  <button
                    onClick={() => setShowEndConfirm(true)}
                    className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-red-200 bg-white px-4 text-sm font-bold text-red-600 transition-ui motion-fast hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 active:scale-[0.985]"
                  >
                    <LogOut size={18} />
                    结束并离开
                  </button>
                </div>
              </>
            )}

            {/* 终态卡里已经有「重新开始共享」：同一屏再放一颗「开始共享屏幕」是重复 CTA。
                观看端（targetSharerId 还在）也只该重试/取消，不能出现发送端的「开始共享屏幕」。 */}
            {!isSharing && !sharePaused && !sharerFailure && !targetSharerId && !roomRetained && (
              <div className="mt-2 flex flex-col items-center gap-2">
                <button
                  onClick={startScreenShare}
                  disabled={typeof shareRoomRetrySeconds === 'number'}
                  aria-describedby={typeof shareRoomRetrySeconds === 'number' ? 'share-room-cooldown-hint' : undefined}
                  className="flex items-center justify-center gap-3 w-full max-w-xs bg-brand-600 hover:bg-brand-700 text-white font-bold py-3.5 px-6 rounded-full shadow-card transition-ui motion-fast active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-600"
                >
                  <Play size={20} fill="currentColor" />
                  开始共享屏幕
                </button>
                {/* 冷却必须活过「关闭」终态卡：否则关掉卡片再点主按钮就绕过了倒计时。 */}
                {typeof shareRoomRetrySeconds === 'number' && (
                  <span
                    id="share-room-cooldown-hint"
                    className="text-xs text-slate-500 tabular-nums"
                  >
                    {shareRoomRetrySeconds} 秒后可重试
                  </span>
                )}
              </div>
            )}

            {(isSharing || sharePaused) && (
              <div className="flex items-center gap-2">
                {isSharing && (
                  <button
                    onClick={changeScreenSource}
                    className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:px-4"
                  >
                    <MonitorUp size={18} />
                    切换窗口
                  </button>
                )}
                <motion.button
                  layout
                  onClick={isSharing ? stopScreenShare : onResumeShare}
                  className={`inline-flex h-12 min-w-32 flex-1 items-center justify-center gap-2 rounded-full px-4 text-sm font-bold transition-colors motion-fast active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 ${
                    isSharing
                      ? 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-300'
                      : 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-300'
                  }`}
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={isSharing ? 'stop' : 'start'}
                      initial={reduceMotion ? false : { opacity: 0, y: -2 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -2 }}
                      transition={{ duration: reduceMotion ? 0 : 0.14 }}
                      className="inline-flex items-center gap-2"
                    >
                      {isSharing ? <StopCircle size={18} /> : <Play size={18} fill="currentColor" />}
                      {isSharing ? '停止共享' : '开始共享'}
                    </motion.span>
                  </AnimatePresence>
                </motion.button>
                <button
                  onClick={() => setShowEndConfirm(true)}
                  className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-red-200 bg-white px-4 text-sm font-bold text-red-600 transition-ui motion-fast hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 active:scale-[0.985]"
                >
                  <LogOut size={18} />
                  结束并离开
                </button>
              </div>
            )}

          </>
        )}
        </div>

        {showChat && (
          <ChatPanel
            role={chat.role}
            connected={chat.connected}
            messages={chat.messages}
            onSend={chat.onSend}
            onExport={chat.onExport}
            onClose={chat.onClose}
            connectingHint={chat.role === 'viewer' ? '共享已结束，聊天连接建立中' : '等待观众加入聊天'}
            voice={voice}
          />
        )}
      </div>
      {showTakeoverConfirm &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="takeover-confirm-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setShowTakeoverConfirm(false);
              }
            }}
          >
            <div className="w-full max-w-sm rounded-card bg-white p-6 shadow-card ring-1 ring-slate-200/70">
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-control bg-amber-50 text-amber-700">
                <MonitorUp size={20} />
              </div>
              <h3 id="takeover-confirm-title" className="text-lg font-bold text-slate-900">
                接替对方的共享？
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                确认后，对方会立即停止共享并转为观看；聊天和语音不会中断。
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  autoFocus
                  onClick={() => setShowTakeoverConfirm(false)}
                  className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                >
                  取消
                </button>
                <button
                  onClick={() => { setShowTakeoverConfirm(false); onTakeoverShare?.(); }}
                  className="inline-flex h-10 items-center justify-center rounded-full bg-amber-700 px-4 text-sm font-bold text-white transition-colors hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                >
                  确认接替
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {showEndConfirm &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-room-confirm-title"
          >
            <div className="w-full max-w-sm rounded-card bg-white p-6 shadow-card ring-1 ring-slate-200/70">
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-control bg-red-50 text-red-600">
                <AlertTriangle size={20} />
              </div>
              <h3 id="end-room-confirm-title" className="text-lg font-bold text-slate-900">
                结束并离开？
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                {isViewerSession
                  ? '将断开与共享方的连接，房间即刻关闭，当前聊天记录也会清空。'
                  : '所有观看者会立即断开，房号作废，当前聊天记录也会清空。只想停画面请用「停止共享」，房间与聊天会保留。'}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  autoFocus
                  onClick={() => setShowEndConfirm(false)}
                  className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                >
                  取消
                </button>
                <button
                  onClick={() => { setShowEndConfirm(false); (isViewerSession ? stopViewing : onEndRoom)(); }}
                  className="inline-flex h-10 items-center justify-center rounded-full bg-red-600 px-4 text-sm font-bold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                >
                  结束并离开
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

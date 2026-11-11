import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, StopCircle, Play, Pause, AlertCircle, Copy, Check, Share2, Eye, Loader2, RefreshCw, X, MonitorUp, Maximize, Minimize, Volume2, VolumeX, PictureInPicture } from 'lucide-react';

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
  viewerVideoRef: (video: HTMLVideoElement | null) => void;
  needsPlayClick: boolean;
  onViewerPlayClick: () => void;
  stopViewing: () => void;
  qualityLabels: Record<'high' | 'medium' | 'low', string>;
  remoteQuality: 'high' | 'medium' | 'low';
  shareLink: string | null;
  copyShareLink: () => void;
  copied: boolean;
  isPeerReady: boolean;
  viewerCount: number;
  qualityLevel: 'high' | 'medium' | 'low';
  sharerVideoRef: React.RefObject<HTMLVideoElement | null>;
  changeScreenSource: () => void;
  startScreenShare: () => void;
  stopScreenShare: () => void;
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
  viewerVideoRef,
  needsPlayClick,
  onViewerPlayClick,
  stopViewing,
  qualityLabels,
  remoteQuality,
  shareLink,
  copyShareLink,
  copied,
  isPeerReady,
  viewerCount,
  qualityLevel,
  sharerVideoRef,
  changeScreenSource,
  startScreenShare,
  stopScreenShare,
}) => {
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerElRef = useRef<HTMLVideoElement | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const [viewerPlaying, setViewerPlaying] = useState(true);
  const [viewerMuted, setViewerMuted] = useState(false);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [pipSupported, setPipSupported] = useState(false);
  const [viewerPip, setViewerPip] = useState(false);

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

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-white dark:bg-night-850 rounded-card shadow-card border border-slate-100 dark:border-night-750 p-6 md:p-8 transition-colors motion-base">
        {/* 共享 / 观看中把装饰性大头部压成工具条式紧凑头部：Meet / Zoom 进入「正在
            共享」态后都会收起介绍性大标题，把纵向空间让给画面和操作；未开始时保
            留图标 + 标题的引导性头部。 */}
        {isSharing || isViewing ? (
          <div className="mb-6 flex items-center gap-2.5">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-brand-100 dark:bg-brand-500/12">
              {isViewing ? (
                <Eye size={20} className="text-brand-600" />
              ) : (
                <Monitor size={20} className="text-brand-600" />
              )}
            </div>
            <h2 className="truncate text-xl font-bold text-slate-900 dark:text-night-100">
              {isViewing ? '观看屏幕' : '屏幕共享'}
            </h2>
            {isViewing && (
              <p className="ml-auto min-w-0 truncate text-xs text-slate-500 dark:text-night-400">
                实时观看对方共享的屏幕内容
              </p>
            )}
          </div>
        ) : (
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-100 dark:bg-brand-500/12 rounded-card mb-4">
              {isConnecting ? (
                <Eye size={32} className="text-brand-600" />
              ) : (
                <Monitor size={32} className="text-brand-600" />
              )}
            </div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-night-100">
              {isConnecting ? '正在连接...' : '屏幕共享'}
            </h2>
            {!isConnecting && (
              <p className="mt-2 text-sm text-slate-500 dark:text-night-400">
                与其他设备实时共享您的屏幕内容
              </p>
            )}
          </div>
        )}

        {error && !(targetSharerId && !isConnecting && !isViewing && !isSharing) && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-card flex items-center gap-3">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="min-w-0 text-sm break-words text-red-700 dark:text-red-300">{error}</span>
          </div>
        )}

        {isConnecting && (
          <div className="mb-6 flex flex-col items-center justify-center py-12">
            <Loader2 size={32} className="text-brand-600 animate-spin mb-4" />
            <p className="text-sm text-slate-600 dark:text-night-300 font-medium mb-4">
              {viewerConnectingStage === 'fetching_ice' && '正在获取网络配置...'}
              {viewerConnectingStage === 'connecting_signaling' && '正在连接信号服务器...'}
              {viewerConnectingStage === 'connecting_media' && '正在建立媒体通道...'}
              {viewerConnectingStage === 'waiting_stream' && '正在等待屏幕画面...'}
              {!viewerConnectingStage && '正在连接到屏幕共享...'}
            </p>
            <button
              onClick={cancelConnecting}
              className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-night-400 hover:text-slate-800 dark:hover:text-night-200 border border-slate-300 dark:border-night-700 rounded-full hover:bg-slate-100 dark:hover:bg-night-800 transition-colors"
            >
              <X size={16} />
              取消连接
            </button>
          </div>
        )}

        {error && !isConnecting && !isViewing && !isSharing && targetSharerId && (
          <div className="mb-6">
            <div className="p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-card flex items-center gap-3 mb-4">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
              <span className="min-w-0 text-sm break-words text-red-700 dark:text-red-300">{error}</span>
            </div>
            <div className="flex justify-center gap-3">
              <button
                onClick={retryConnection}
                className="flex items-center justify-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-full transition-colors"
              >
                <RefreshCw size={16} />
                重试连接
              </button>
              <button
                onClick={dismissConnectionError}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-slate-600 dark:text-night-400 hover:text-slate-800 dark:hover:text-night-200 border border-slate-300 dark:border-night-700 rounded-full hover:bg-slate-100 dark:hover:bg-night-800 transition-colors"
              >
                <X size={16} />
                取消
              </button>
            </div>
          </div>
        )}

        {isViewing && (
          <>
            <div
              ref={viewerContainerRef}
              className={`mb-4 relative group overflow-hidden bg-slate-900 border border-slate-200 dark:border-night-750 shadow-sm ${
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
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 via-black/25 to-transparent p-2.5">
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
                  </span>
                  正在观看
                </span>
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
                    画质 {qualityLabels[remoteQuality]}
                  </span>
                </span>
              </div>

              {/* 自绘控件条：原生 controls 与页面气质不符，直播画面又不需要进度条，
                  所以只留播放/静音/画中画/全屏。指针活动时显形，暂停时常驻。 */}
              <div
                className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-2.5 transition-opacity duration-200 ${
                  controlsVisible ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <button
                  type="button"
                  onClick={toggleViewerPlay}
                  aria-label={viewerPlaying ? '暂停' : '播放'}
                  title={viewerPlaying ? '暂停' : '播放'}
                  className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
                >
                  {viewerPlaying ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <button
                  type="button"
                  onClick={toggleViewerMute}
                  aria-label={viewerMuted ? '取消静音' : '静音'}
                  title={viewerMuted ? '取消静音' : '静音'}
                  className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
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
                    className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
                  >
                    <PictureInPicture size={18} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleViewerFullscreen}
                  aria-label={viewerFullscreen ? '退出全屏' : '全屏'}
                  title={viewerFullscreen ? '退出全屏' : '全屏'}
                  className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
                >
                  {viewerFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
              </div>

              {needsPlayClick && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 cursor-pointer"
                  onClick={onViewerPlayClick}
                >
                  <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mb-3">
                    <Play size={32} className="text-white ml-1" fill="white" />
                  </div>
                  <p className="text-white text-sm">点击开始观看</p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={stopViewing}
                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-red-600 px-5 text-sm font-bold text-white shadow-card transition-ui motion-fast hover:bg-red-700 active:scale-[0.99]"
              >
                <StopCircle size={18} />
                停止观看
              </button>
            </div>
          </>
        )}

        {!isViewing && !isConnecting && (
          <>

            {isSharing && shareLink && (
              <div className="mb-4 rounded-card border border-slate-200 dark:border-night-750 bg-slate-50 dark:bg-night-900/50 px-3 py-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-slate-600 dark:text-night-300">
                    将此链接分享给观看者
                  </p>
                  {viewerCount > 0 && (
                    /* pr-3 让文字右缘与下方 44px 图标按钮的可见图标右缘对齐
                       （图标 18px 居中，左右各留 13px 内边距） */
                    <span className="inline-flex shrink-0 items-center gap-1 pr-3 text-xs font-medium text-slate-600 dark:text-night-300 tabular-nums">
                      <Eye size={16} />
                      {viewerCount} 人观看
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <a
                    href={shareLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-w-0 text-sm font-mono text-brand-600 dark:text-brand-400 hover:underline truncate"
                    title={shareLink}
                  >
                    {shareLink}
                  </a>
                  <button
                    onClick={copyShareLink}
                    className="inline-flex min-w-11 min-h-11 shrink-0 items-center justify-center rounded-control text-slate-500 dark:text-night-400 hover:bg-slate-200/70 dark:hover:bg-night-750/70 hover:text-slate-700 dark:hover:text-night-200 transition-colors"
                    title="复制分享链接"
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
                    className="inline-flex min-w-11 min-h-11 shrink-0 items-center justify-center rounded-control text-slate-500 dark:text-night-400 hover:bg-slate-200/70 dark:hover:bg-night-750/70 hover:text-slate-700 dark:hover:text-night-200 transition-colors"
                    title="分享链接"
                    aria-label="分享链接"
                  >
                    <Share2 size={18} />
                  </button>
                </div>
              </div>
            )}

            {isSharing && (
              <div className="mb-4 relative group rounded-card overflow-hidden bg-slate-900 border border-slate-200 dark:border-night-750 shadow-sm">
                <video
                  ref={sharerVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full aspect-video object-contain"
                />

                {/* 状态直接叠进画面：原来共享状态独占一行、与预览脱节。
                    现在改为画面内的 LIVE 徽标，右上角只保留画质胶囊；观看人数放到
                    链接卡片的标题行（那本来就是链接/观看者语义），避免窄屏挤爆。 */}
                <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 via-black/25 to-transparent p-2.5">
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
                    </span>
                    正在共享
                  </span>
                  <span className="flex flex-wrap items-center justify-end gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
                      画质 {qualityLabels[qualityLevel]}
                    </span>
                  </span>
                </div>

                {!isPeerReady && (
                  <div className="pointer-events-none absolute bottom-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-full bg-amber-500/90 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                    <Loader2 size={16} className="animate-spin" />
                    正在连接服务器...
                  </div>
                )}

              </div>
            )}

            {!isSharing ? (
              <div className="mt-2 flex justify-center">
                <button
                  onClick={startScreenShare}
                  className="flex items-center justify-center gap-3 w-full max-w-xs bg-brand-600 hover:bg-brand-700 text-white font-bold py-3.5 px-6 rounded-full shadow-card transition-ui motion-fast active:scale-[0.99]"
                >
                  <Play size={20} fill="currentColor" />
                  开始共享屏幕
                </button>
              </div>
            ) : (
              /* 共享中的操作改成工具条：切换窗口从画面上的悬停按钮变成常驻次要按钮，
                 停止共享保持红色主操作但不再独占整行，省下一大块纵向空间。 */
              <div className="flex items-center gap-2">
                <button
                  onClick={changeScreenSource}
                  className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-slate-300 px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:border-night-700 dark:text-night-300 dark:hover:bg-night-750"
                >
                  <MonitorUp size={18} />
                  切换窗口
                </button>
                <button
                  onClick={stopScreenShare}
                  className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-red-600 px-5 text-sm font-bold text-white shadow-card transition-ui motion-fast hover:bg-red-700 active:scale-[0.99]"
                >
                  <StopCircle size={18} />
                  停止共享
                </button>
              </div>
            )}

          </>
        )}
      </div>
    </div>
  );
};

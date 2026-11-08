import React from 'react';
import { Monitor, StopCircle, Play, AlertCircle, Copy, Check, ExternalLink, Eye, Loader2, RefreshCw, X, MonitorUp } from 'lucide-react';

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
  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-white dark:bg-slate-800 rounded-card shadow-card border border-slate-100 dark:border-slate-700 p-6 md:p-8 transition-colors motion-base">
        {/* 共享中把装饰性大头部压成工具条式紧凑头部：Meet / Zoom 进入「正在共享」
            态后都会收起介绍性大标题，把纵向空间让给画面和操作；未共享时保留
            图标 + 标题 + 说明的引导性头部。 */}
        {isSharing ? (
          <div className="mb-4 flex items-center gap-2.5">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-brand-100 dark:bg-brand-900/30">
              <Monitor size={20} className="text-brand-600" />
            </div>
            <h2 className="truncate text-xl font-bold text-slate-900 dark:text-white">屏幕共享</h2>
          </div>
        ) : (
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-100 dark:bg-brand-900/30 rounded-card mb-4">
              {isViewing || isConnecting ? (
                <Eye size={32} className="text-brand-600" />
              ) : (
                <Monitor size={32} className="text-brand-600" />
              )}
            </div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
              {isViewing ? '正在观看屏幕' : isConnecting ? '正在连接...' : '屏幕共享'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {isViewing || isConnecting ? '实时观看对方共享的屏幕内容' : '与其他设备实时共享您的屏幕内容'}
            </p>
          </div>
        )}

        {error && !(targetSharerId && !isConnecting && !isViewing && !isSharing) && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-card flex items-center gap-3">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="min-w-0 text-sm break-words text-red-700 dark:text-red-300">{error}</span>
          </div>
        )}

        {isConnecting && (
          <div className="mb-6 flex flex-col items-center justify-center py-12">
            <Loader2 size={32} className="text-brand-600 animate-spin mb-4" />
            <p className="text-sm text-slate-600 dark:text-slate-300 font-medium mb-1">
              {viewerConnectingStage === 'fetching_ice' && '正在获取网络配置...'}
              {viewerConnectingStage === 'connecting_signaling' && '正在连接信号服务器...'}
              {viewerConnectingStage === 'connecting_media' && '正在建立媒体通道...'}
              {viewerConnectingStage === 'waiting_stream' && '正在等待屏幕画面...'}
              {!viewerConnectingStage && '正在连接到屏幕共享...'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              {viewerConnectingStage === 'fetching_ice' && '获取 STUN/TURN 服务器信息'}
              {viewerConnectingStage === 'connecting_signaling' && '连接 PeerJS 信令服务'}
              {viewerConnectingStage === 'connecting_media' && '通过 WebRTC 建立音视频连接'}
              {viewerConnectingStage === 'waiting_stream' && '已连接，等待对方屏幕画面传输'}
            </p>
            <button
              onClick={cancelConnecting}
              className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X size={16} />
              取消连接
            </button>
          </div>
        )}

        {error && !isConnecting && !isViewing && !isSharing && targetSharerId && (
          <div className="mb-6">
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-card flex items-center gap-3 mb-4">
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
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={16} />
                取消
              </button>
            </div>
          </div>
        )}

        {isViewing && (
          <>
            <div className="mb-4 relative overflow-hidden rounded-card">
              <div className="bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-card overflow-hidden">
                <video
                  ref={viewerVideoRef}
                  autoPlay
                  playsInline
                  controls
                  className="w-full aspect-video object-contain"
                />
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

            <div className="flex justify-center">
              <button
                onClick={stopViewing}
                className="flex items-center justify-center gap-3 w-full max-w-xs bg-red-600 hover:bg-red-700 text-white font-bold py-3.5 px-6 rounded-full shadow-card transition-ui motion-fast active:scale-[0.99]"
              >
                <StopCircle size={20} />
                停止观看
              </button>
            </div>
            <div className="mt-6 flex items-center justify-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
              </span>
              <span className="text-sm font-medium text-green-600 dark:text-green-400">
                正在观看屏幕共享 | 画质: {qualityLabels[remoteQuality]}
              </span>
            </div>
          </>
        )}

        {!isViewing && !isConnecting && (
          <>

            {isSharing && shareLink && (
              <div className="mb-4 rounded-card border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-3 py-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    将此链接分享给观看者
                  </p>
                  {viewerCount > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 tabular-nums">
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
                    className="inline-flex min-w-11 min-h-11 shrink-0 items-center justify-center rounded-control text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-700/70 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                    title="复制分享链接"
                    aria-label="复制分享链接"
                  >
                    {copied ? (
                      <Check size={18} className="text-green-500" />
                    ) : (
                      <Copy size={18} />
                    )}
                  </button>
                  <a
                    href={shareLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-11 min-h-11 shrink-0 items-center justify-center rounded-control text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-700/70 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                    title="在新窗口打开"
                    aria-label="在新窗口打开"
                  >
                    <ExternalLink size={18} />
                  </a>
                </div>
              </div>
            )}

            {isSharing && (
              <div className="mb-4 relative group rounded-card overflow-hidden bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm">
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
              <div className="flex justify-center">
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
                  className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-slate-300 px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
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

            {!isSharing && (
              <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800">
                <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
                  点击开始后，浏览器将弹出选择窗口，您可以选择共享整个屏幕、某个应用窗口或浏览器标签页。
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

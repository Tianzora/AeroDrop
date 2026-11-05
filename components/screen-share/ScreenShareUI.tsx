import React from 'react';
import { Monitor, Eye } from 'lucide-react';
import { ShareConnectingPanel } from './panels/ShareConnectingPanel';
import { ViewerPanel } from './panels/ViewerPanel';
import { ShareActivePanel } from './panels/ShareActivePanel';
import { ShareIdlePanel } from './panels/ShareIdlePanel';
import { ShareErrorBanner, ShareErrorPanel } from './panels/ShareErrorPanel';

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

export const ScreenShareUI: React.FC<ScreenShareUIProps> = (props) => {
  const {
    isSharing, isViewing, isConnecting, viewerConnectingStage, error, targetSharerId,
    cancelConnecting, retryConnection, dismissConnectionError, viewerVideoRef, needsPlayClick,
    onViewerPlayClick, stopViewing, qualityLabels, remoteQuality, shareLink, copyShareLink, copied,
    isPeerReady, viewerCount, qualityLevel, sharerVideoRef, changeScreenSource, startScreenShare, stopScreenShare,
  } = props;

  const title = isViewing ? '正在观看屏幕' : isConnecting ? '正在连接…' : '屏幕共享';
  const subtitle = isViewing || isConnecting ? '实时观看对方共享的屏幕内容' : '与其他设备实时共享您的屏幕内容';
  const isConnectFailed = Boolean(targetSharerId) && !isConnecting && !isViewing && !isSharing;
  const showTopError = Boolean(error) && !isConnectFailed;

  let body: React.ReactNode = null;
  if (isConnecting) {
    body = <ShareConnectingPanel stage={viewerConnectingStage} onCancel={cancelConnecting} />;
  } else if (isViewing) {
    body = <ViewerPanel viewerVideoRef={viewerVideoRef} needsPlayClick={needsPlayClick} onViewerPlayClick={onViewerPlayClick} stopViewing={stopViewing} qualityLabel={qualityLabels[remoteQuality]} />;
  } else if (error && isConnectFailed) {
    body = <ShareErrorPanel error={error} onRetry={retryConnection} onDismiss={dismissConnectionError} />;
  } else if (isSharing) {
    body = (
      <ShareActivePanel
        shareLink={shareLink} copyShareLink={copyShareLink} copied={copied} isPeerReady={isPeerReady}
        viewerCount={viewerCount} qualityLabel={qualityLabels[qualityLevel]} sharerVideoRef={sharerVideoRef}
        changeScreenSource={changeScreenSource} stopScreenShare={stopScreenShare}
      />
    );
  } else {
    body = <ShareIdlePanel startScreenShare={startScreenShare} />;
  }

  return (
    <div className="mx-auto w-full max-w-[880px]">
      <header className="mb-6 text-center">
        <div className="mb-3.5 inline-grid h-14 w-14 place-items-center rounded-[16px] border border-border bg-raised text-accent shadow-[var(--shadow-1)]">
          {isViewing || isConnecting ? <Eye size={26} /> : <Monitor size={26} />}
        </div>
        <h1 className="text-[30px] font-semibold leading-[1.08] tracking-[-.03em] text-ink sm:text-[34px]">{title}</h1>
        <p className="mt-1 text-[14px] text-muted">{subtitle}</p>
      </header>
      {showTopError && <ShareErrorBanner error={error as string} />}
      {body}
    </div>
  );
};

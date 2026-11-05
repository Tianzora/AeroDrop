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
    <div className="mx-auto flex min-h-[480px] w-full max-w-[880px] flex-col justify-center">
      <header className="mb-9 text-center">
        <h1 className="font-serif font-normal text-[clamp(30px,4vw,44px)] leading-[1.08] tracking-[-.02em] text-ink">{title}</h1>
      </header>
      {showTopError && <ShareErrorBanner error={error as string} />}
      {body}
    </div>
  );
};

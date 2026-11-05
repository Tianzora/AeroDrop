import React from 'react';
import { Play, StopCircle } from 'lucide-react';
import { Button } from '../../ui/Button';

export interface ViewerPanelProps {
  viewerVideoRef: (video: HTMLVideoElement | null) => void;
  needsPlayClick: boolean;
  onViewerPlayClick: () => void;
  stopViewing: () => void;
  qualityLabel: string;
}

export const ViewerPanel: React.FC<ViewerPanelProps> = ({ viewerVideoRef, needsPlayClick, onViewerPlayClick, stopViewing, qualityLabel }) => (
  <div className="motion-rise">
    <div className="relative mb-4 overflow-hidden rounded-[4px] border border-border bg-black">
      <video ref={viewerVideoRef} autoPlay playsInline controls className="aspect-video w-full object-contain" />
      {needsPlayClick && (
        <div className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-black/60" onClick={onViewerPlayClick}>
          <div className="mb-3 grid h-16 w-16 place-items-center rounded-full bg-white/20"><Play size={30} className="ml-1 text-white" fill="white" /></div>
          <p className="text-[13px] text-white">点击开始观看</p>
        </div>
      )}
    </div>
    <div className="flex justify-center"><Button variant="danger" fullWidth className="max-w-xs" size="lg" icon={<StopCircle size={19} />} onClick={stopViewing}>停止观看</Button></div>
    <div className="mt-5 flex items-center justify-center gap-2">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
      </span>
      <span className="text-[13px] font-medium text-success">正在观看屏幕共享 | 画质：{qualityLabel}</span>
    </div>
  </div>
);

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
  <div className="space-y-4">
    <div className="relative overflow-hidden rounded-[4px] border border-border bg-black">
      <video ref={viewerVideoRef} autoPlay playsInline controls className="mx-auto max-h-[56vh] w-full object-contain" />
      <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/90">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> 正在观看
      </div>
      {needsPlayClick && (
        <div className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-black/60" onClick={onViewerPlayClick}>
          <div className="mb-3 grid h-16 w-16 place-items-center rounded-full bg-white/20"><Play size={30} className="ml-1 text-white" fill="white" /></div>
          <p className="text-[13px] text-white">点击开始观看</p>
        </div>
      )}
    </div>
    <div className="flex flex-col gap-3 rounded-[4px] border border-border bg-raised p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-[12.5px] text-muted">画质 <span className="text-ink">{qualityLabel}</span> · 正在观看屏幕共享</div>
      <div className="flex shrink-0 items-center">
        <Button data-morph="action" variant="danger" icon={<StopCircle size={18} />} onClick={stopViewing}>停止观看</Button>
      </div>
    </div>
  </div>
);

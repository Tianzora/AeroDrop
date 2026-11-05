import React from 'react';
import { Copy, Check, ExternalLink, MonitorUp, StopCircle } from 'lucide-react';
import { Button } from '../../ui/Button';

export interface ShareActivePanelProps {
  shareLink: string | null;
  copyShareLink: () => void;
  copied: boolean;
  isPeerReady: boolean;
  viewerCount: number;
  qualityLabel: string;
  sharerVideoRef: React.RefObject<HTMLVideoElement | null>;
  changeScreenSource: () => void;
  stopScreenShare: () => void;
}

export const ShareActivePanel: React.FC<ShareActivePanelProps> = ({
  shareLink, copyShareLink, copied, isPeerReady, viewerCount, qualityLabel, sharerVideoRef, changeScreenSource, stopScreenShare,
}) => (
  <div className="space-y-4">
    <div className="group relative overflow-hidden rounded-[4px] border border-border bg-black">
      <video ref={sharerVideoRef} autoPlay playsInline muted className="mx-auto max-h-[56vh] w-full object-contain" />
      <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/90">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> 正在共享
      </div>
      <button
        onClick={changeScreenSource}
        title="切换共享窗口"
        aria-label="切换共享窗口"
        className="absolute right-3 top-3 rounded-[4px] bg-black/50 p-2 text-white opacity-0 transition-opacity duration-200 hover:bg-black/70 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <MonitorUp size={18} />
      </button>
    </div>

    <div className="flex flex-col gap-3 rounded-[4px] border border-border bg-raised p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className={isPeerReady ? 'h-1.5 w-1.5 rounded-full bg-success' : 'h-1.5 w-1.5 rounded-full bg-warning'} />
            <span className={isPeerReady ? 'text-success' : 'text-warning'}>
              {!isPeerReady ? '正在连接服务器…' : viewerCount > 0 ? `${viewerCount} 人正在观看` : '等待观看者接入'}
            </span>
          </span>
          <span className="text-border-strong">·</span>
          <span>画质 {qualityLabel}</span>
        </div>
        {shareLink && (
          <div className="flex min-w-0 items-center gap-1">
            <a href={shareLink} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[12.5px] text-ink hover:underline" title={shareLink}>{shareLink}</a>
            <button onClick={copyShareLink} aria-label="复制分享链接" title="复制分享链接" className="shrink-0 rounded-[4px] p-1.5 text-muted transition-colors duration-200 hover:bg-sunken hover:text-ink">
              {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
            </button>
            <a href={shareLink} target="_blank" rel="noopener noreferrer" aria-label="在新窗口打开" title="在新窗口打开" className="shrink-0 rounded-[4px] p-1.5 text-muted transition-colors duration-200 hover:bg-sunken hover:text-ink">
              <ExternalLink size={16} />
            </a>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        <Button variant="danger" icon={<StopCircle size={18} />} onClick={stopScreenShare}>停止共享</Button>
      </div>
    </div>
  </div>
);

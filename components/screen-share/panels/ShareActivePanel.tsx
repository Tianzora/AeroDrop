import React from 'react';
import { Copy, Check, ExternalLink, MonitorUp, StopCircle } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';

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
    {shareLink && (
      <Card className="p-4">
        <p className="mb-2 text-center text-[12px] text-muted">将此链接分享给观看者</p>
        <div className="flex items-center justify-center gap-2">
          <a href={shareLink} target="_blank" rel="noopener noreferrer" className="max-w-[300px] truncate font-mono text-[13px] text-accent hover:underline" title={shareLink}>{shareLink}</a>
          <button onClick={copyShareLink} aria-label="复制分享链接" title="复制分享链接" className="shrink-0 rounded-md p-2 text-accent transition-colors duration-200 hover:bg-accent/10">
            {copied ? <Check size={18} className="text-success" /> : <Copy size={18} />}
          </button>
          <a href={shareLink} target="_blank" rel="noopener noreferrer" aria-label="在新窗口打开" title="在新窗口打开" className="shrink-0 rounded-md p-2 text-accent transition-colors duration-200 hover:bg-accent/10">
            <ExternalLink size={18} />
          </a>
        </div>
        <div className="mt-2 flex items-center justify-center gap-2 text-[12px]">
          {!isPeerReady ? <span className="text-warning">正在连接服务器…</span> : <Badge tone="success">已就绪</Badge>}
          {viewerCount > 0 && <Badge tone="success" dot={false}>当前观看人数：{viewerCount} · 画质：{qualityLabel}</Badge>}
        </div>
      </Card>
    )}

    <div className="group relative overflow-hidden rounded-[4px] border border-border bg-black">
      <video ref={sharerVideoRef} autoPlay playsInline muted className="aspect-video w-full object-contain" />
      <button onClick={changeScreenSource} title="切换共享窗口" aria-label="切换共享窗口" className="absolute right-3 top-3 rounded-md bg-black/50 p-2 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <MonitorUp size={18} />
      </button>
    </div>

    <div className="flex justify-center"><Button variant="danger" fullWidth size="lg" className="max-w-xs" icon={<StopCircle size={19} />} onClick={stopScreenShare}>停止共享</Button></div>
    <div className="flex items-center justify-center gap-2">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
      </span>
      <span className="text-[13px] font-medium text-success">正在共享屏幕…</span>
    </div>
  </div>
);

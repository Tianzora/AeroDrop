import React from 'react';
import { Play } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';

export const ShareIdlePanel: React.FC<{ startScreenShare: () => void }> = ({ startScreenShare }) => (
  <div className="space-y-4 motion-rise">
    <Card className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-[18px] border border-border bg-sunken text-accent">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></svg>
      </div>
      <div>
        <p className="text-[16px] font-bold text-ink">开始共享你的屏幕</p>
        <p className="mt-1.5 text-[13px] text-muted">浏览器会弹出选择窗口，可选择整个屏幕、应用窗口或标签页。</p>
      </div>
      <Button size="lg" icon={<Play size={19} fill="currentColor" />} onClick={startScreenShare}>开始共享屏幕</Button>
    </Card>
    <Card className="px-5 py-4">
      <p className="text-[12px] text-subtle">观众通过分享链接进入观看页。共享内容点对点传输，不经过云端。</p>
    </Card>
  </div>
);

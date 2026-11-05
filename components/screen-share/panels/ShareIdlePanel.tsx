import React from 'react';
import { Play } from 'lucide-react';
import { Button } from '../../ui/Button';

export const ShareIdlePanel: React.FC<{ startScreenShare: () => void }> = ({ startScreenShare }) => (
  <div className="flex flex-col items-center gap-5 py-6 text-center">
    <div>
      <p className="text-[15px] leading-[1.7] text-muted">选择整个屏幕、应用窗口或标签页，对方通过链接实时观看</p>
    </div>
    <Button size="lg" icon={<Play size={18} fill="currentColor" />} onClick={startScreenShare}>开始共享屏幕</Button>
    <p className="text-[12px] text-subtle">共享内容点对点传输，不经过云端</p>
  </div>
);

import React from 'react';
import { Play } from 'lucide-react';
import { Button } from '../../ui/Button';

export const ShareIdlePanel: React.FC<{ startScreenShare: () => void }> = ({ startScreenShare }) => (
  <div className="flex flex-col items-center gap-5 pb-6 pt-2 text-center">
    <Button size="lg" icon={<Play size={18} fill="currentColor" />} onClick={startScreenShare}>开始共享屏幕</Button>
    <p className="text-[12px] text-subtle">共享内容点对点传输，不经过云端</p>
  </div>
);

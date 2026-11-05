import React from 'react';
import { Play } from 'lucide-react';
import { Button } from '../../ui/Button';

export const ShareIdlePanel: React.FC<{ startScreenShare: () => void }> = ({ startScreenShare }) => (
  <div className="flex flex-col items-center pb-8 pt-6 text-center">
    <Button data-morph="action" size="lg" icon={<Play size={18} fill="currentColor" />} onClick={startScreenShare}>开始共享屏幕</Button>
  </div>
);

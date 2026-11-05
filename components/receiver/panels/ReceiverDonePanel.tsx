import React from 'react';
import { Check } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';

export const ReceiverDonePanel: React.FC<{ onReset: () => void }> = ({ onReset }) => (
  <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center motion-scale">
    <div className="grid h-16 w-16 place-items-center rounded-full border-2 border-success/40 bg-success/10 text-success">
      <Check size={32} />
    </div>
    <h2 className="text-[22px] font-bold text-ink">下载完成</h2>
    <p className="text-[13px] text-muted">文件已保存到你的设备</p>
    <Button size="lg" className="mt-3" onClick={onReset}>接收下一个</Button>
  </Card>
);

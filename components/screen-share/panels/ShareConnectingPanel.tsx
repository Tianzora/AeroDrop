import React from 'react';
import { Loader2, X } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import type { ScreenShareViewerConnectingStage } from '../ScreenShareUI';

const STAGE_TEXT: Record<ScreenShareViewerConnectingStage, { title: string; detail: string }> = {
  fetching_ice: { title: '正在获取网络配置…', detail: '获取 STUN/TURN 服务器信息' },
  connecting_signaling: { title: '正在连接信号服务器…', detail: '连接 PeerJS 信令服务' },
  connecting_media: { title: '正在建立媒体通道…', detail: '通过 WebRTC 建立音视频连接' },
  waiting_stream: { title: '正在等待屏幕画面…', detail: '已连接，等待对方屏幕画面传输' },
  '': { title: '正在连接到屏幕共享…', detail: '准备建立连接' },
};

export const ShareConnectingPanel: React.FC<{ stage: ScreenShareViewerConnectingStage; onCancel: () => void }> = ({ stage, onCancel }) => {
  const t = STAGE_TEXT[stage] ?? STAGE_TEXT[''];
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Loader2 size={40} className="animate-spin text-accent" />
      <p className="text-[15px] font-bold text-ink">{t.title}</p>
      <p className="text-[12px] text-muted">{t.detail}</p>
      <Button variant="secondary" size="sm" className="mt-4" icon={<X size={15} />} onClick={onCancel}>取消连接</Button>
    </Card>
  );
};

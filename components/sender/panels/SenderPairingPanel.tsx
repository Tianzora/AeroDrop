import React from 'react';
import { X, ShieldCheck } from 'lucide-react';
import { TransferState } from '../../../types';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { CodeDisplay, ShareLink } from '../../ui/CodeDisplay';
import { StatusDot } from '../../ui/StatusDot';
import { SenderDeviceList } from './SenderDeviceList';
import type { SenderPeerTransferStat } from '../SenderUI';

export interface SenderPairingPanelProps {
  state: TransferState;
  transferCode: string;
  copied: boolean;
  handleCopyCode: () => void;
  shareLink: string;
  linkCopied: boolean;
  handleCopyLink: () => void;
  remainingTime: string;
  connectionStatus: string;
  individualStats: SenderPeerTransferStat[];
  activeConnectionsCount: number;
  stopSharing: () => void;
}

export const SenderPairingPanel: React.FC<SenderPairingPanelProps> = ({
  transferCode, copied, handleCopyCode, shareLink, linkCopied, handleCopyLink, remainingTime, connectionStatus, individualStats, stopSharing,
}) => {
  const waiting = individualStats.length === 0;
  return (
    <div className="space-y-4 motion-rise">
      <Card className="p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <StatusDot status={waiting ? 'waiting' : 'transferring'} pulse={waiting} />
            <span className="text-[15px] font-semibold text-ink">{waiting ? '等待接收方接入…' : '接收方已接入'}</span>
          </div>
          <span className="text-[12px] text-muted">{connectionStatus}</span>
        </div>

        <div className="mt-6 flex flex-col items-center gap-4">
          <CodeDisplay code={transferCode} copied={copied} onCopy={handleCopyCode} />
          <p className="text-[13px] text-muted">在另一台设备输入此口令即可取件</p>
          <ShareLink link={shareLink} copied={linkCopied} onCopy={handleCopyLink} />
        </div>

        <div className="mt-6 flex items-center gap-2 rounded-[10px] bg-sunken px-4 py-3 text-[12px] text-muted">
          <ShieldCheck size={15} className="shrink-0 text-success" />
          <span>保持此页面打开；关闭会中断连接。{remainingTime ? `口令有效期 ${remainingTime}。` : ''}</span>
        </div>

        <Button variant="danger" fullWidth className="mt-4" icon={<X size={17} />} onClick={stopSharing}>停止分享</Button>
      </Card>

      <SenderDeviceList stats={individualStats} />
    </div>
  );
};

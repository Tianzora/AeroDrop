import React from 'react';
import { TransferState } from '../../../types';
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
    <div className="mx-auto w-full max-w-[560px] space-y-6 motion-rise">
      <div className="relative mx-auto w-full max-w-[460px] border border-border bg-raised px-8 pb-7 pt-8 shadow-[var(--shadow-2)]">
        <div className="flex items-center justify-between text-[11px] tracking-[.04em] text-subtle">
          <span>取件口令</span>
          <span>{remainingTime ? `有效期 ${remainingTime}` : ''}</span>
        </div>

        <div className="mt-6 flex flex-col items-center gap-3">
          <CodeDisplay code={transferCode} copied={copied} onCopy={handleCopyCode} />
          <p className="text-[13px] text-muted">在另一台设备输入此口令即可取件</p>
        </div>

        <div className="my-6 h-px bg-[repeating-linear-gradient(90deg,var(--border-strong)_0_6px,transparent_6px_12px)]" />

        <ShareLink link={shareLink} copied={linkCopied} onCopy={handleCopyLink} />

        <div className="mt-5 flex items-center justify-center gap-2 text-[12.5px] text-muted">
          <StatusDot status={waiting ? 'waiting' : 'transferring'} pulse={waiting} />
          <span>{waiting ? '等待接收方接入' : '接收方已接入'}{connectionStatus ? ` · ${connectionStatus}` : ''}</span>
        </div>
      </div>

      <div className="flex justify-center">
        <button type="button" onClick={stopSharing} className="text-[13px] text-muted underline underline-offset-4 transition-colors hover:text-danger">
          停止分享
        </button>
      </div>

      <SenderDeviceList stats={individualStats} />
    </div>
  );
};

import React from 'react';
import { Loader2, Check, X, Monitor } from 'lucide-react';
import { TransferState, FileMetadata } from '../../../types';
import { formatFileSize } from '../../../services/fileUtils';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Progress } from '../../ui/Progress';
import { Stat } from '../../ui/Stat';
import { StatusDot } from '../../ui/StatusDot';
import { SenderDeviceList } from './SenderDeviceList';
import type { SenderPeerTransferStat } from '../SenderUI';

export interface SenderTransferPanelProps {
  state: TransferState;
  preparingStage: 'fetching_ice' | 'connecting_signaling';
  metadata: FileMetadata | null;
  fileList: File[];
  currentFileIndex: number;
  totalProgress: number;
  activeTransfersCount: number;
  totalBytes: number;
  transferredBytes: number;
  overallEta: string;
  activeConnectionsCount: number;
  currentSpeed: string;
  avgSpeed: string;
  connectionStatus: string;
  individualStats: SenderPeerTransferStat[];
  stopSharing: () => void;
}

export const SenderTransferPanel: React.FC<SenderTransferPanelProps> = ({
  state, preparingStage, metadata, fileList, currentFileIndex, totalProgress, activeTransfersCount,
  totalBytes, transferredBytes, overallEta, activeConnectionsCount, currentSpeed, avgSpeed, connectionStatus, individualStats, stopSharing,
}) => {
  if (state === TransferState.GENERATING_CODE) {
    return (
      <Card className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Loader2 size={36} className="animate-spin text-accent" />
        <p className="text-[15px] font-bold text-ink">
          {preparingStage === 'fetching_ice' ? '正在获取网络配置…' : '正在连接信令服务…'}
        </p>
        <p className="text-[13px] text-muted">准备建立点对点通道</p>
      </Card>
    );
  }

  const connected = activeConnectionsCount > 0;
  const complete = totalProgress === 100 && activeTransfersCount === 0;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <StatusDot status={complete ? 'completed' : state === TransferState.TRANSFERRING ? 'transferring' : 'waiting'} pulse={!complete && state !== TransferState.TRANSFERRING} />
            <span className="text-[15px] font-bold text-ink">
              {complete ? '传输完成' : state === TransferState.TRANSFERRING ? '正在发送…' : '等待接收方接入…'}
            </span>
          </div>
          <span className="text-[12px] text-muted">{connectionStatus}</span>
        </div>

        {state !== TransferState.TRANSFERRING && !complete ? (
          <div className="mt-4 space-y-2 rounded-[4px] bg-sunken p-4">
            <p className="text-[13px] text-muted">把右侧 6 位口令告诉接收方，对方输入后即开始传输。</p>
            <p className="text-[12px] text-subtle">保持此页面打开；关闭会中断连接。</p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[12px] text-muted">
                <span>{activeConnectionsCount > 1 ? '所有设备总进度（平均）' : '总进度'}</span>
                <span className="font-mono tabular-nums">{totalProgress}%</span>
              </div>
              <Progress value={totalProgress} tone={complete ? 'success' : 'accent'} label="总进度" height={10} />
            </div>
            {metadata && (
              <p className="truncate text-[13px] text-muted">
                {fileList[currentFileIndex]?.name ?? `${currentFileIndex + 1}/${metadata.files.length}`}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Stat label={activeConnectionsCount > 1 ? '所有设备实时速度' : '实时速度'} value={currentSpeed} />
              <Stat label="平均速度" value={avgSpeed} />
            </div>
            <div className="flex items-center justify-between text-[12px] text-subtle">
              <span className="font-mono tabular-nums">{formatFileSize(transferredBytes)} / {formatFileSize(totalBytes)}</span>
              <span>预计剩余 {overallEta}</span>
            </div>
          </div>
        )}

        <Button variant="danger" fullWidth className="mt-4" icon={<X size={17} />} onClick={stopSharing}>停止分享</Button>
      </Card>

      {metadata && (
        <Card className="flex items-center gap-3 p-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] border border-border bg-sunken text-muted"><Monitor size={18} /></div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">{metadata.files.length} 个文件</p>
            <p className="text-[12px] text-muted font-mono">{formatFileSize(metadata.totalSize)}</p>
          </div>
          {complete && <Check size={20} className="text-success" />}
        </Card>
      )}

      <SenderDeviceList stats={individualStats} />
    </div>
  );
};

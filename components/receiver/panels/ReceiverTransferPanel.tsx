import React from 'react';
import { Card } from '../../ui/Card';
import { Progress } from '../../ui/Progress';
import { Button } from '../../ui/Button';
import { formatFileSize } from '../../../services/fileUtils';

export interface ReceiverTransferPanelProps {
  progress: number;
  downloadSpeed: string;
  eta: string;
  overallTransferredBytes: number;
  totalBytes: number;
  overallEta: string;
  onReset: () => void;
}

export const ReceiverTransferPanel: React.FC<ReceiverTransferPanelProps> = ({
  progress, downloadSpeed, eta, overallTransferredBytes, totalBytes, overallEta, onReset,
}) => (
  <Card className="p-5">
    <div className="mb-1.5 flex items-center justify-between text-[12px] font-semibold uppercase tracking-[.04em] text-muted">
      <span>当前文件进度</span>
      <span className="tabular-nums text-accent">{progress}%</span>
    </div>
    <Progress value={progress} label="当前文件进度" height={10} />
    <div className="mt-2 flex items-center justify-between text-[12px] text-muted">
      <span>{downloadSpeed}</span>
      <span>{eta}</span>
    </div>
    <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[12px] text-subtle">
      <span className="tabular-nums">{formatFileSize(overallTransferredBytes)} / {formatFileSize(totalBytes)}</span>
      <span>预计剩余 {overallEta}</span>
    </div>
    <Button variant="danger" fullWidth className="mt-4" onClick={onReset}>取消</Button>
  </Card>
);

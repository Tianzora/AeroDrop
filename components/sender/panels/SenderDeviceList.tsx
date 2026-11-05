import React from 'react';
import { Panel } from '../../ui/Panel';
import { Badge } from '../../ui/Badge';
import { StatusDot } from '../../ui/StatusDot';
import { Progress } from '../../ui/Progress';
import type { SenderPeerTransferStat } from '../SenderUI';

export const SenderDeviceList: React.FC<{ stats: SenderPeerTransferStat[] }> = ({ stats }) => {
  if (stats.length === 0) return null;
  return (
    <Panel title={`设备传输列表 (${stats.length})`} bodyClassName="p-0">
      <ul className="divide-y divide-border">
        {stats.map((stat) => (
          <li key={stat.peerId} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot status={stat.status === 'completed' ? 'completed' : stat.status === 'transferring' ? 'transferring' : 'waiting'} pulse={stat.status === 'transferring'} />
                <span className="truncate text-[13px] text-text" title={stat.peerId}>{stat.deviceName}</span>
                <Badge tone="neutral" dot={false} className="shrink-0">{stat.connectionType}</Badge>
              </div>
              <span className="shrink-0 text-[12px] tabular-nums text-muted">{stat.status === 'completed' ? '已完成' : stat.status === 'transferring' ? `${stat.progress}%` : '等待'}</span>
            </div>
            <div className="mt-2"><Progress value={stat.progress} tone={stat.status === 'completed' ? 'success' : 'accent'} height={5} label="设备进度" /></div>
          </li>
        ))}
      </ul>
    </Panel>
  );
};

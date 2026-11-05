import React from 'react';
import { cn } from './cn';

export type StatusKind = 'waiting' | 'transferring' | 'completed' | 'paused' | 'error';

const map: Record<StatusKind, string> = {
  waiting: 'bg-subtle',
  transferring: 'bg-accent',
  completed: 'bg-success',
  paused: 'bg-warning',
  error: 'bg-danger',
};

export const StatusDot: React.FC<{ status: StatusKind; pulse?: boolean; className?: string }> = ({ status, pulse, className }) => (
  <span className={cn('relative inline-flex h-2.5 w-2.5', className)} aria-hidden>
    {pulse && <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping', map[status])} />}
    <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', map[status])} />
  </span>
);

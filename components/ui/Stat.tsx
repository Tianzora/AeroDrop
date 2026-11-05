import React from 'react';
import { cn } from './cn';

export interface StatProps { label: string; value: React.ReactNode; className?: string; }

export const Stat: React.FC<StatProps> = ({ label, value, className }) => (
  <div className={cn('rounded-[4px] border border-border bg-sunken px-3 py-2.5', className)}>
    <div className="text-[11px] text-subtle font-medium">{label}</div>
    <div className="mt-0.5 text-[15px] font-bold text-ink font-mono tabular-nums">{value}</div>
  </div>
);

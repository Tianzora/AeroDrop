import React from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-muted border-border',
  accent: 'bg-accent/10 text-accent border-accent/25',
  success: 'bg-success/10 text-success border-success/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  warning: 'bg-warning/10 text-warning border-warning/25',
  info: 'bg-info/10 text-info border-info/25',
};
const dots: Record<BadgeTone, string> = {
  neutral: 'bg-subtle', accent: 'bg-accent', success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning', info: 'bg-info',
};

export interface BadgeProps { tone?: BadgeTone; dot?: boolean; children: React.ReactNode; className?: string; }

export const Badge: React.FC<BadgeProps> = ({ tone = 'neutral', dot = true, className, children }) => (
  <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold', tones[tone], className)}>
    {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dots[tone])} aria-hidden />}
    {children}
  </span>
);

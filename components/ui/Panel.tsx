import React from 'react';
import { cn } from './cn';

export interface PanelProps {
  title?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

export const Panel: React.FC<PanelProps> = ({ title, action, className, bodyClassName, children }) => (
  <section className={cn('bg-raised border border-border rounded-[12px] shadow-[var(--shadow-1)] overflow-hidden', className)}>
    {(title || action) && (
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
        <h2 className="text-[13px] font-semibold tracking-[.02em] text-muted">{title}</h2>
        {action}
      </header>
    )}
    <div className={cn('p-5', bodyClassName)}>{children}</div>
  </section>
);

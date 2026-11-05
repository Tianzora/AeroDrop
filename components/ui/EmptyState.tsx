import React from 'react';
import { cn } from './cn';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action, className }) => (
  <div className={cn('flex flex-col items-center text-center px-6 py-10', className)}>
    {icon && <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-sunken text-subtle">{icon}</div>}
    <p className="text-[15px] font-semibold text-text">{title}</p>
    {description && <p className="mt-1.5 max-w-[36ch] text-[13px] text-muted">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

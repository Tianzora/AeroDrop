import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from './cn';

export interface ErrorStateProps {
  title?: string;
  message?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ title = '出了点问题', message, actions, className }) => (
  <div className={cn('flex flex-col items-center text-center px-6 py-10', className)} role="alert">
    <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-danger/10 text-danger">
      <AlertCircle size={24} />
    </div>
    <p className="text-[17px] font-bold text-text">{title}</p>
    {message && <p className="mt-1.5 max-w-[40ch] text-[13px] text-muted">{message}</p>}
    {actions && <div className="mt-5 flex flex-wrap justify-center gap-3">{actions}</div>}
  </div>
);

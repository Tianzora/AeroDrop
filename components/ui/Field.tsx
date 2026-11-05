import React from 'react';
import { cn } from './cn';

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Field: React.FC<FieldProps> = ({ label, htmlFor, hint, error, required, className, children }) => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    <label htmlFor={htmlFor} className="text-[13px] font-semibold text-muted">
      {label}{required && <span className="text-danger"> *</span>}
    </label>
    {children}
    {error ? (
      <p className="text-[13px] text-danger flex items-center gap-1" role="alert">{error}</p>
    ) : hint ? (
      <p className="text-[13px] text-subtle">{hint}</p>
    ) : null}
  </div>
);

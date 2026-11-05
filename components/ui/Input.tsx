import * as React from 'react';
import { cn } from './cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex h-11 w-full rounded-[6px] border border-border bg-raised px-3.5 text-text shadow-[var(--shadow-1)]',
        'placeholder:text-subtle transition-colors duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // mobile >=16px to avoid iOS focus zoom; desktop 14px
        'text-[16px] sm:text-sm tabular-nums',
        invalid && 'border-danger focus-visible:ring-danger',
        className,
      )}
      {...rest}
    />
  );
});
Input.displayName = 'Input';

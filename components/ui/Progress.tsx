import React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from './cn';

export interface ProgressProps {
  value: number;
  tone?: 'accent' | 'success';
  label?: string;
  className?: string;
  height?: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

export const Progress: React.FC<ProgressProps> = ({ value, tone = 'accent', label, className, height = 8 }) => {
  const v = clamp(value);
  return (
    <ProgressPrimitive.Root
      value={v}
      aria-label={label}
      className={cn('relative w-full overflow-hidden rounded-[2px] border border-border bg-sunken', className)}
      style={{ height }}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full w-full origin-left rounded-[1px] transition-transform duration-300 ease-out',
          tone === 'success' ? 'bg-success' : 'bg-accent',
        )}
        style={{ transform: `scaleX(${v / 100})` }}
      />
    </ProgressPrimitive.Root>
  );
};

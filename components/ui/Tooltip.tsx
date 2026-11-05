import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './cn';

export interface TooltipProps {
  label: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}

export const TooltipProvider = TooltipPrimitive.Provider;

export const Tooltip: React.FC<TooltipProps> = ({ label, children, side = 'top', className }) => (
  <TooltipPrimitive.Root delayDuration={200}>
    <TooltipPrimitive.Trigger asChild>
      <span className="inline-flex">{children}</span>
    </TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side === 'top' ? 'top' : 'bottom'}
        sideOffset={6}
        className={cn(
          'z-50 select-none rounded-md bg-ink px-2 py-1 text-[12px] font-medium text-surface shadow-[var(--shadow-1)]',
          className,
        )}
      >
        {label}
        <TooltipPrimitive.Arrow className="fill-ink" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);

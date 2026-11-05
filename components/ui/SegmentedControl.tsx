import React from 'react';
import { cn } from './cn';

export interface SegmentedOption { value: string; label: string; icon?: React.ReactNode; }

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  size?: 'sm' | 'md';
}

// 注意：每个选项渲染为真正的 <button>（role=button），
// 以兼容 e2e 的 getByRole('button', { name: '发送'|'接收'|'共享' })。
export const SegmentedControl: React.FC<SegmentedControlProps> = ({ options, value, onChange, ariaLabel, className, size = 'md' }) => (
  <div role="group" aria-label={ariaLabel} className={cn('inline-flex items-center gap-1 rounded-full border border-border bg-sunken p-1', className)}>
    {options.map((opt) => {
      const active = opt.value === value;
      return (
        <button
          key={opt.value}
          type="button"
          aria-pressed={active}
          onClick={() => onChange(opt.value)}
          className={cn(
            'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-150 ease-out whitespace-nowrap',
            size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-9 px-4 text-[13px]',
            active ? 'bg-raised text-ink shadow-[var(--shadow-1)]' : 'text-muted hover:text-text',
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      );
    })}
  </div>
);

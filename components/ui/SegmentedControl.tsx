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

// 每个选项渲染为真正的 <button>，兼容 e2e getByRole('button', { name: '发送'|'接收'|'共享' })。
export const SegmentedControl: React.FC<SegmentedControlProps> = ({ options, value, onChange, ariaLabel, className, size = 'md' }) => {
  const n = Math.max(1, options.length);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="group" aria-label={ariaLabel} className={cn('relative inline-flex items-center rounded-full border border-border bg-sunken p-1', className)}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 rounded-full bg-raised shadow-[var(--shadow-1)] transition-transform duration-[180ms] ease-out"
        style={{ width: `calc((100% - 8px) / ${n})`, transform: `translateX(${idx * 100}%)` }}
      />
      <div className="relative grid w-full" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt.value)}
              className={cn(
                'relative z-10 inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-200 ease-out whitespace-nowrap',
                size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-10 px-5 text-[13.5px]',
                active ? 'text-ink' : 'text-muted hover:text-text',
              )}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

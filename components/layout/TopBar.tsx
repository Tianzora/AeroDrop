import React from 'react';
import { Package } from 'lucide-react';
import { cn } from '../ui/cn';
import type { Mode } from '../../services/initialRouteState';

export interface TopBarProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onBrandClick: () => void;
  banner?: React.ReactNode;
}

const OPTIONS = [
  { value: 'send', label: '发送' },
  { value: 'receive', label: '接收' },
  { value: 'screen', label: '共享' },
];

export const TopBar: React.FC<TopBarProps> = ({ mode, onModeChange, onBrandClick, banner }) => {
  const tabs = (cls?: string) => (
    <nav aria-label="模式" className={cn('flex items-center gap-9', cls)}>
      {OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onModeChange(o.value as Mode)}
            className={cn(
              'relative py-2 font-sans text-[13.5px] font-medium tracking-[.01em] transition-colors duration-200',
              active ? 'text-ink' : 'text-muted hover:text-text',
            )}
          >
            {o.label}
            <span className={cn('absolute inset-x-0 -bottom-[3px] h-[1.5px] origin-left bg-ink transition-transform duration-200', active ? 'scale-x-100' : 'scale-x-0')} />
          </button>
        );
      })}
    </nav>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur-md">
      <div className="mx-auto grid h-[76px] w-full max-w-[1120px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 sm:h-[88px] sm:px-10">
        <button type="button" onClick={onBrandClick} aria-label="AeroDrop 首页" className="flex items-center gap-3.5 justify-self-start">
          <span className="grid h-9 w-9 place-items-center rounded-[26.5%] bg-accent text-accent-contrast shadow-[var(--shadow-1)]">
            <Package size={20} />
          </span>
          <span className="font-serif text-[24px] leading-none tracking-[-.015em] text-ink">AeroDrop</span>
        </button>
        <div className="hidden justify-self-center sm:block">{tabs()}</div>
        <div className="flex items-center justify-self-end gap-2">{banner}</div>
      </div>
      <div className="px-5 pb-2 sm:hidden">{tabs('justify-between')}</div>
    </header>
  );
};

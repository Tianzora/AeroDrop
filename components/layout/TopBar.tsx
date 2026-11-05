import React, { useLayoutEffect, useRef, useState } from 'react';
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

const Tabs: React.FC<{ mode: Mode; onModeChange: (mode: Mode) => void; className?: string }> = ({ mode, onModeChange, className }) => {
  const navRef = useRef<HTMLElement>(null);
  const [ink, setInk] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const nav = navRef.current;
      if (!nav) return;
      const btn = nav.querySelector<HTMLButtonElement>(`[data-tab="${mode}"]`);
      if (btn) setInk({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [mode]);
  return (
    <nav ref={navRef} aria-label="模式" className={cn('relative flex items-center gap-9', className)}>
      {OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            data-tab={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onModeChange(o.value as Mode)}
            className={cn(
              'py-2 font-sans text-[13.5px] font-medium tracking-[.01em] transition-colors duration-200',
              active ? 'text-ink' : 'text-muted hover:text-text',
            )}
          >
            {o.label}
          </button>
        );
      })}
      <span
        aria-hidden
        className="absolute -bottom-[3px] h-[1.5px] rounded-full bg-ink"
        style={{ left: ink.left, width: ink.width, transition: 'left 460ms cubic-bezier(.22,1,.36,1), width 460ms cubic-bezier(.22,1,.36,1)' }}
      />
    </nav>
  );
};

export const TopBar: React.FC<TopBarProps> = ({ mode, onModeChange, onBrandClick, banner }) => (
  <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur-md">
    <div className="mx-auto grid h-[76px] w-full max-w-[1120px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 sm:h-[88px] sm:px-10">
      <button type="button" onClick={onBrandClick} aria-label="AeroDrop 首页" className="flex items-center gap-3.5 justify-self-start">
        <span className="grid h-9 w-9 place-items-center rounded-[26.5%] bg-accent text-accent-contrast shadow-[var(--shadow-1)]">
          <Package size={20} />
        </span>
        <span className="font-serif text-[24px] leading-none tracking-[-.015em] text-ink">AeroDrop</span>
      </button>
      <div className="hidden justify-self-center sm:block"><Tabs mode={mode} onModeChange={onModeChange} /></div>
      <div className="flex items-center justify-self-end gap-2">{banner}</div>
    </div>
    <div className="px-5 pb-2 sm:hidden"><Tabs mode={mode} onModeChange={onModeChange} className="justify-between" /></div>
  </header>
);

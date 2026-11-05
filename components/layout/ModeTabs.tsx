import React, { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../ui/cn';
import type { Mode } from '../../services/initialRouteState';

const OPTIONS = [
  { value: 'send', label: '发送' },
  { value: 'receive', label: '接收' },
  { value: 'screen', label: '共享' },
];

export interface ModeTabsProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  className?: string;
}

export const ModeTabs: React.FC<ModeTabsProps> = ({ mode, onModeChange, className }) => {
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

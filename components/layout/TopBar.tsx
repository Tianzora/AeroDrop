import React from 'react';
import { Package } from 'lucide-react';
import type { Mode } from '../../services/initialRouteState';

export interface TopBarProps {
  mode?: Mode;
  onModeChange?: (mode: Mode) => void;
  onBrandClick: () => void;
  banner?: React.ReactNode;
}

export const TopBar: React.FC<TopBarProps> = ({ onBrandClick, banner }) => (
  <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur-md">
    <div className="mx-auto flex h-[76px] w-full max-w-[1120px] items-center justify-between gap-4 px-6 sm:h-[88px] sm:px-10">
      <button type="button" onClick={onBrandClick} aria-label="AeroDrop 首页" className="flex items-center gap-3.5">
        <span className="grid h-9 w-9 place-items-center rounded-[26.5%] bg-accent text-accent-contrast shadow-[var(--shadow-1)]">
          <Package size={20} />
        </span>
        <span className="font-serif text-[24px] leading-none tracking-[-.015em] text-ink">AeroDrop</span>
      </button>
      <div className="flex items-center justify-end gap-2">{banner}</div>
    </div>
  </header>
);

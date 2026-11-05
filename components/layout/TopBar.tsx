import React from 'react';
import { Package } from 'lucide-react';
import { SegmentedControl } from '../ui/SegmentedControl';
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
  const change = (v: string) => onModeChange(v as Mode);
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-md">
      <div className="mx-auto grid h-14 w-full max-w-[1120px] grid-cols-[auto_1fr_auto] items-center gap-3 px-4 sm:px-5 lg:px-6">
        <button type="button" onClick={onBrandClick} aria-label="AeroDrop 首页" className="flex items-center gap-2.5 justify-self-start">
          <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-ink text-surface"><Package size={17} /></span>
          <span className="text-[17px] font-semibold tracking-[-.02em] text-ink">AeroDrop</span>
        </button>
        <div className="justify-self-center hidden sm:block">
          <SegmentedControl ariaLabel="模式" size="sm" options={OPTIONS} value={mode} onChange={change} />
        </div>
        <div className="justify-self-end flex items-center gap-2">{banner}</div>
      </div>
      <div className="px-4 pb-2.5 sm:hidden">
        <SegmentedControl
          ariaLabel="模式"
          size="sm"
          options={OPTIONS}
          value={mode}
          onChange={change}
          className="flex w-full [&>button]:flex-1"
        />
      </div>
    </header>
  );
};

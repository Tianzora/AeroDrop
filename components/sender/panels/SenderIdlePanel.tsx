import React from 'react';
import { cn } from '../../ui/cn';

export interface SenderIdlePanelProps {
  isDragOver: boolean;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const RIPPLE_CYCLE = 3.6;
const RIPPLE_T0 = Date.now();
const Rings = () => {
  const elapsed = ((Date.now() - RIPPLE_T0) / 1000) % RIPPLE_CYCLE;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="relative h-[min(560px,74vw)] w-[min(560px,74vw)]">
        <span className="ripple-core absolute inset-0 rounded-full" />
        {[0, 1.2, 2.4].map((d) => (
          <span
            key={d}
            className="ripple-ring absolute inset-0 rounded-full"
            style={{ animationDelay: `${(d - elapsed).toFixed(2)}s` }}
          />
        ))}
      </div>
    </div>
  );
};

export const SenderIdlePanel: React.FC<SenderIdlePanelProps> = ({ isDragOver, handleFileSelect, handleFolderSelect }) => (
  <div
    className={cn(
      'relative flex min-h-[520px] flex-col items-center justify-center px-6 py-16 text-center transition-colors',
      isDragOver && 'bg-accent/[.04]',
    )}
  >
    <input type="file" id="file-upload" className="hidden" multiple onChange={handleFileSelect} />
    <input type="file" id="folder-upload" className="hidden" webkitdirectory="" directory="" onChange={handleFolderSelect} />
    <Rings />
    <h1 data-morph="title" className="relative font-serif font-normal text-[clamp(36px,5.2vw,64px)] leading-[1.05] tracking-[-.022em] text-ink">
      发送文件
    </h1>
    <p data-morph="sub" className="relative mt-6 max-w-[58ch] text-[15px] leading-[1.7] text-muted">
      {isDragOver ? '松开即可添加' : '拖拽文件到这里，或点击下方选择文件'}
    </p>
    <div className="relative mt-10 flex items-center gap-6 sm:gap-8">
      <label
        htmlFor="file-upload"
        className="z-10 inline-flex cursor-pointer items-center rounded-[3px] bg-ink px-6 py-[13px] font-sans text-[14px] font-medium tracking-[.01em] text-surface transition-colors hover:bg-ink/90"
      >
        选择文件
      </label>
      <label
        htmlFor="folder-upload"
        className="z-10 inline-flex h-[46px] cursor-pointer items-center border-b border-border-strong font-sans text-[14px] font-medium tracking-[.01em] text-text transition-colors hover:border-accent hover:text-accent"
      >
        选择文件夹
      </label>
    </div>
    <label htmlFor="file-upload" aria-hidden className="absolute inset-0 cursor-pointer" />
  </div>
);

import React from 'react';
import { Upload, Folder } from 'lucide-react';
import { Button } from '../../ui/Button';
import { cn } from '../../ui/cn';

export interface SenderIdlePanelProps {
  isDragOver: boolean;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const SenderIdlePanel: React.FC<SenderIdlePanelProps> = ({ isDragOver, handleFileSelect, handleFolderSelect }) => (
  <div
    className={cn(
      'relative rounded-[14px] border-[1.5px] border-dashed bg-raised p-8 text-center transition-colors duration-150 ease-out sm:p-10',
      isDragOver ? 'border-accent bg-accent/5' : 'border-border-strong hover:border-accent/60',
    )}
  >
    <input type="file" id="file-upload" className="hidden" multiple onChange={handleFileSelect} />
    <input type="file" id="folder-upload" className="hidden" webkitdirectory="" directory="" onChange={handleFolderSelect} />
    <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-[14px] bg-accent/10 text-accent">
      <Upload size={26} />
    </div>
    <p className="text-[16px] font-bold text-ink">{isDragOver ? '松开即可添加' : '拖入文件，或点击选择'}</p>
    <p className="mt-1.5 text-[13px] text-muted">支持多文件、文件夹 · 单文件最大 4GB</p>
    <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
      <label htmlFor="file-upload" className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[9px] bg-ink px-4 text-[13px] font-semibold text-surface hover:bg-ink/90">
        选择文件
      </label>
      <label htmlFor="folder-upload" className="z-10 inline-flex h-10 cursor-pointer items-center gap-2 rounded-[9px] border border-border-strong bg-raised px-4 text-[13px] font-semibold text-text hover:bg-sunken">
        <Folder size={15} /> 选择文件夹
      </label>
    </div>
    <label htmlFor="file-upload" className="absolute inset-0 -z-0 cursor-pointer rounded-[14px]" aria-hidden />
  </div>
);

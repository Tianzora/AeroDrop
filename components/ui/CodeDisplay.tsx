import React from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from './cn';

export interface CodeDisplayProps {
  code: string;
  copied?: boolean;
  onCopy?: () => void;
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * 6 位口令展示。整串口令渲染在**同一个文本节点**里，便于 e2e getByText(code,{exact}) 命中。
 */
export const CodeDisplay: React.FC<CodeDisplayProps> = ({ code, copied, onCopy, size = 'lg', className }) => (
  <button
    type="button"
    onClick={onCopy}
    aria-label={copied ? '口令已复制' : '复制口令'}
    title={onCopy ? '点击复制口令' : undefined}
    className={cn(
      'group inline-flex items-baseline justify-center gap-3 font-serif font-normal tabular-nums leading-none text-accent transition-colors duration-150',
      size === 'lg' ? 'text-[46px] tracking-[.06em]' : 'text-[30px] tracking-[.05em]',
      onCopy ? 'cursor-pointer hover:text-accent/80' : 'cursor-default',
      className,
    )}
  >
    <span>{code}</span>
    {onCopy && (copied ? <Check size={16} className="text-success" /> : <Copy size={16} className="text-subtle opacity-60 group-hover:opacity-100" />)}
  </button>
);

export interface ShareLinkProps {
  link: string;
  copied?: boolean;
  onCopy: () => void;
}

export const ShareLink: React.FC<ShareLinkProps> = ({ link, copied, onCopy }) => (
  <div className="flex items-center gap-2 border-b border-border pb-2">
    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted select-all" title={link}>{link}</span>
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? '链接已复制' : '复制链接'}
      className="inline-flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-[.14em] text-muted transition-colors hover:text-accent"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已复制' : '复制'}
    </button>
  </div>
);

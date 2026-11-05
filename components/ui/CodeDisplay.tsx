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
 * 6 位口令展示。必须把整串口令渲染在**同一个文本节点**里，便于 e2e getByText(code,{exact}) 命中。
 * 视觉上用等宽 + 字距 + tabular-nums，不做逐位分格（逐位拆分会破坏整串文案匹配）。
 */
export const CodeDisplay: React.FC<CodeDisplayProps> = ({ code, copied, onCopy, size = 'lg', className }) => (
  <button
    type="button"
    onClick={onCopy}
    aria-label={copied ? '口令已复制' : '复制口令'}
    title={onCopy ? '点击复制口令' : undefined}
    className={cn(
      'group inline-flex items-center justify-center gap-3 rounded-[14px] border-2 px-6 font-mono font-bold tabular-nums leading-none',
      'transition-colors duration-150 ease-out',
      size === 'lg' ? 'h-[86px] text-[38px] tracking-[.14em]' : 'h-[60px] text-[26px] tracking-[.12em]',
      copied ? 'border-success/40 bg-success/10 text-success' : 'border-border-strong bg-raised text-accent hover:border-accent/60',
      className,
    )}
  >
    <span>{code}</span>
    {onCopy && (copied ? <Check size={20} className="text-success" /> : <Copy size={20} className="opacity-50 group-hover:opacity-100" />)}
  </button>
);

export interface ShareLinkProps {
  link: string;
  copied?: boolean;
  onCopy: () => void;
}

export const ShareLink: React.FC<ShareLinkProps> = ({ link, copied, onCopy }) => (
  <div className="flex items-center gap-2 rounded-[10px] border border-border bg-sunken px-3 py-2">
    <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-muted select-all" title={link}>{link}</span>
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? '链接已复制' : '复制分享链接'}
      className="shrink-0 inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-accent hover:bg-accent/10"
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? '已复制' : '复制'}
    </button>
  </div>
);

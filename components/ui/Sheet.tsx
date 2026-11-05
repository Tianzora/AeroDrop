import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from './cn';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}

export const Sheet: React.FC<SheetProps> = ({ open, onClose, title, children, className }) => (
  <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 motion-fade" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-border bg-raised shadow-[var(--shadow-2)] motion-sheet focus:outline-none',
          className,
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <DialogPrimitive.Title className="text-[16px] font-semibold text-ink">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <button
              aria-label="关闭"
              className="grid h-9 w-9 place-items-center rounded-[8px] text-muted transition-colors hover:bg-sunken hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X size={18} />
            </button>
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
);

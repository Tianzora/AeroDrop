import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const Dialog: React.FC<DialogProps> = ({ open, onClose, title, children, footer, className }) => (
  <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 motion-fade" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[512px] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-border bg-raised p-6 shadow-[var(--shadow-2)] motion-scale focus:outline-none',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <DialogPrimitive.Title className="text-[18px] font-bold text-ink">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <button
              aria-label="关闭"
              className="grid h-9 w-9 place-items-center rounded-[8px] text-muted transition-colors hover:bg-sunken hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X size={18} />
            </button>
          </DialogPrimitive.Close>
        </div>
        <div className="text-sm text-muted">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-3">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
);

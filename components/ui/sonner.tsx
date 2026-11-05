import type { CSSProperties } from 'react';
import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      closeButton
      toastOptions={{
        style: {
          background: 'color-mix(in srgb, var(--surface) 92%, var(--raised) 8%)',
          color: 'var(--text)',
          borderColor: 'var(--border)',
        } as CSSProperties,
        classNames: {
          toast: 'rounded-[4px] border shadow-[var(--shadow-2)] text-[13px]',
          description: 'text-muted',
          actionButton: 'bg-ink text-surface',
          cancelButton: 'bg-border/40 text-text',
        },
      }}
    />
  );
}

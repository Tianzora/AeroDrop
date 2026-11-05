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
          '--normal-bg': 'var(--accent)',
          '--normal-text': 'var(--accent-contrast)',
          '--normal-border': 'var(--accent)',
        } as CSSProperties,
        classNames: {
          toast:
            'rounded-[4px] border border-accent bg-accent text-accent-contrast shadow-[var(--shadow-2)] text-[13px]',
          description: 'text-accent-contrast/75',
          actionButton: 'bg-surface text-accent',
          cancelButton: 'bg-white/10 text-accent-contrast',
        },
      }}
    />
  );
}

import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'rounded-[4px] border border-border bg-raised text-text shadow-[var(--shadow-2)] text-[13px]',
          description: 'text-muted',
          actionButton: 'bg-ink text-surface',
          cancelButton: 'bg-sunken text-muted',
        },
      }}
    />
  );
}

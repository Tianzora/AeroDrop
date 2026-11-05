import React from 'react';

export interface AppShellProps {
  topBar: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  overlays?: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ topBar, children, footer, overlays }) => (
  <div className="flex min-h-[100dvh] flex-col bg-surface text-text">
    {topBar}
    <main className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1000px] flex-1 flex-col px-5 pb-20 pt-12 sm:px-6 sm:pt-16">
        {children}
        {footer}
      </div>
    </main>
    {overlays}
  </div>
);

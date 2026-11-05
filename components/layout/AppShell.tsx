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
    <main className="flex-1">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col px-4 pb-10 pt-6 sm:px-5 lg:px-6 lg:pt-8">
        {children}
        {footer}
      </div>
    </main>
    {overlays}
  </div>
);

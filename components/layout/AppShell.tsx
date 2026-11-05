import React from 'react';

export interface AppShellProps {
  topBar: React.ReactNode;
  notice?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  overlays?: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ topBar, notice, children, footer, overlays }) => (
  <div className="flex min-h-[100dvh] flex-col bg-surface text-text">
    {topBar}
    {notice && (
      <div>
        <div className="mx-auto flex w-full max-w-[1120px] items-center gap-2 px-5 py-1.5 text-[11.5px] leading-snug text-subtle sm:px-10">
          {notice}
        </div>
      </div>
    )}
    <main className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1000px] flex-1 flex-col px-5 pb-20 pt-12 sm:px-6 sm:pt-16">
        {children}
        {footer}
      </div>
    </main>
    {overlays}
  </div>
);

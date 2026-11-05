import * as React from 'react';
import { cn } from './cn';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('rounded-[4px] border border-border bg-raised text-text shadow-[var(--shadow-1)]', className)}
      {...rest}
    />
  );
});
Card.displayName = 'Card';

export const CardHeader = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 border-b border-border px-5 py-4', className)} {...rest} />
);
export const CardTitle = ({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-[15px] font-semibold tracking-[-.01em] text-text', className)} {...rest} />
);
export const CardDescription = ({ className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-[13px] text-muted', className)} {...rest} />
);
export const CardContent = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-5', className)} {...rest} />
);
export const CardFooter = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center gap-3 border-t border-border px-5 py-4', className)} {...rest} />
);

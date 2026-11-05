import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium rounded-[9px] border transition-[transform,background-color,color,border-color,box-shadow] duration-150 ease-out select-none disabled:pointer-events-none disabled:opacity-50 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-ink text-surface border-transparent hover:bg-ink/90 shadow-[var(--shadow-1)]',
        secondary: 'bg-raised text-text border-border-strong hover:bg-sunken',
        ghost: 'bg-transparent text-text border-transparent hover:bg-sunken',
        danger: 'bg-danger/10 text-danger border-danger/30 hover:bg-danger/15',
        outline: 'bg-transparent text-text border-border hover:bg-sunken',
      },
      size: { sm: 'h-9 px-3 text-[13px]', md: 'h-11 px-4 text-sm', lg: 'h-12 px-5 text-[15px]' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, fullWidth, icon, iconRight, asChild, className, children, disabled, ...rest },
  ref,
) {
  const Comp: React.ElementType = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), fullWidth && 'w-full', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </Comp>
  );
});

export { buttonVariants };

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from './cn';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  'aria-label'?: string;
  className?: string;
}

export const Select: React.FC<SelectProps> = ({ id, value, onValueChange, options, className, ...rest }) => (
  <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
    <SelectPrimitive.Trigger
      id={id}
      aria-label={rest['aria-label']}
      className={cn(
        'inline-flex h-11 w-full items-center justify-between gap-2 rounded-[6px] border border-border bg-raised px-3.5 text-[16px] shadow-[var(--shadow-1)] text-text transition-colors duration-200 hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 data-[state=open]:border-accent data-[state=open]:ring-2 data-[state=open]:ring-accent/30 sm:text-sm',
        className,
      )}
    >
      <SelectPrimitive.Value />
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={16} className="shrink-0 text-subtle" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        className="z-50 max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[6px] border border-border bg-raised text-text shadow-[var(--shadow-2)]"
      >
        <SelectPrimitive.Viewport className="p-1">
          {options.map((opt) => (
            <SelectPrimitive.Item
              key={opt.value}
              value={opt.value}
              className="relative flex cursor-pointer select-none items-center rounded-[4px] py-2 pl-3 pr-8 text-[14px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken data-[state=checked]:font-semibold"
            >
              <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
              <SelectPrimitive.ItemIndicator className="absolute right-2 text-accent">
                <Check size={14} />
              </SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>
          ))}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
);

export default Select;

import React from 'react';
import { cn } from './cn';

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  isMobile?: boolean;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}

/**
 * 6 位口令输入：可见的 6 个格子 + 一个透明的真实 input[type=text] 覆盖其上。
 * 保留单输入元素，兼容 e2e 的 locator('input[type="text"]').fill(...) 与键盘/粘贴。
 */
export const CodeInput: React.FC<CodeInputProps> = ({ value, onChange, inputRef, isMobile, length = 6, disabled, invalid, autoFocus }) => {
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');
  return (
    <div data-morph="action" className={cn('relative mx-auto w-full max-w-[380px]', invalid && 'motion-shake')}>
      <div className="flex justify-center gap-2 pointer-events-none" aria-hidden>
        {digits.map((d, i) => (
          <div
            key={i}
            className={cn(
              'flex h-16 w-12 items-end justify-center border-b-[1.5px] pb-1.5 font-serif text-[36px] font-normal tabular-nums transition-colors duration-200 ease-out',
              d ? 'border-ink text-ink' : 'border-border-strong text-subtle',
              invalid && 'border-danger',
            )}
          >
            {d || ''}
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        type="text"
        name="aerodrop-share-code"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        maxLength={length}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus ?? !isMobile}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, length))}
        aria-label="6 位口令"
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
      />
    </div>
  );
};

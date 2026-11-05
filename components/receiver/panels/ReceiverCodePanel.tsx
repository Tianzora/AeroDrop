import React from 'react';
import { ClipboardPaste, Delete } from 'lucide-react';
import { CodeInput } from '../../ui/CodeInput';

export interface ReceiverCodePanelProps {
  code: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isMobileDevice: boolean;
  onCodeChange: (value: string) => void;
  onDigitClick: (digit: string) => void;
  onPasteFromClipboard: () => void;
  onBackspace: () => void;
  onClear: () => void;
}

const KEY_CLS = 'flex h-12 items-center justify-center rounded-[4px] font-serif text-[22px] text-text transition-colors duration-150 hover:bg-ink/[.05] active:scale-[.98]';

export const ReceiverCodePanel: React.FC<ReceiverCodePanelProps> = ({
  code, inputRef, isMobileDevice, onCodeChange, onDigitClick, onPasteFromClipboard, onBackspace, onClear,
}) => (
  <div className="motion-rise">
    <div className="mb-10">
      <CodeInput value={code} onChange={onCodeChange} inputRef={inputRef} isMobile={isMobileDevice} />
    </div>
    <div className="mx-auto grid w-full max-w-[280px] grid-cols-3 gap-2">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
        <button key={num} type="button" onClick={() => onDigitClick(String(num))} className={KEY_CLS}>{num}</button>
      ))}
      <button type="button" onClick={onPasteFromClipboard} aria-label="粘贴 6 位口令" title="粘贴 6 位口令" className={KEY_CLS + ' text-accent'}>
        <ClipboardPaste size={18} />
      </button>
      <button type="button" onClick={() => onDigitClick('0')} className={KEY_CLS}>0</button>
      <button type="button" onClick={onBackspace} onContextMenu={(e) => { e.preventDefault(); onClear(); }} aria-label="退格" className={KEY_CLS + ' text-muted'}>
        <Delete size={18} />
      </button>
    </div>
  </div>
);

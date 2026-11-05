import React from 'react';
import { ClipboardPaste, Delete } from 'lucide-react';
import { CodeInput } from '../../ui/CodeInput';
import { Card } from '../../ui/Card';

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

const KEY_CLS = 'h-14 rounded-[12px] border border-border bg-raised text-[20px] font-semibold text-text transition-colors duration-150 ease-out hover:bg-sunken active:scale-[.98]';

export const ReceiverCodePanel: React.FC<ReceiverCodePanelProps> = ({
  code, inputRef, isMobileDevice, onCodeChange, onDigitClick, onPasteFromClipboard, onBackspace, onClear,
}) => (
  <Card className="p-5 motion-rise">
    <div className="mb-6">
      <CodeInput value={code} onChange={onCodeChange} inputRef={inputRef} isMobile={isMobileDevice} />
    </div>
    <div className="mx-auto grid w-full max-w-[300px] grid-cols-3 gap-2.5">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
        <button key={num} type="button" onClick={() => onDigitClick(String(num))} className={KEY_CLS}>{num}</button>
      ))}
      <button type="button" onClick={onPasteFromClipboard} aria-label="粘贴 6 位口令" title="粘贴 6 位口令" className={KEY_CLS + ' flex items-center justify-center text-accent'}>
        <ClipboardPaste size={20} />
      </button>
      <button type="button" onClick={() => onDigitClick('0')} className={KEY_CLS}>0</button>
      <button type="button" onClick={onBackspace} onContextMenu={(e) => { e.preventDefault(); onClear(); }} aria-label="退格" className={KEY_CLS + ' flex items-center justify-center text-muted'}>
        <Delete size={22} />
      </button>
    </div>
    <p className="mt-5 text-center text-[12px] text-subtle">口令由发送方提供，共 6 位数字</p>
  </Card>
);

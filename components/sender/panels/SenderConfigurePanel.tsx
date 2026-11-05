import React from 'react';
import { X, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { FileMetadata } from '../../../types';
import { formatFileSize } from '../../../services/fileUtils';
import type { FileType } from '../../../services/fileType';
import { FileTypeIcon } from '../../FileTypeIcon';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Field } from '../../ui/Field';
import { Card } from '../../ui/Card';
import type { SenderSelectedFile } from '../SenderUI';

export interface SenderConfigurePanelProps {
  metadata: FileMetadata;
  selectedFiles: SenderSelectedFile[];
  showFileList: boolean;
  onToggleFileList: () => void;
  stopSharing: () => void;
  expiryOption: string;
  setExpiryOption: React.Dispatch<React.SetStateAction<string>>;
  customCodeInput: string;
  setCustomCodeInput: React.Dispatch<React.SetStateAction<string>>;
  errorMsg: string;
  startSharing: () => void;
}

export const SenderConfigurePanel: React.FC<SenderConfigurePanelProps> = ({
  metadata, selectedFiles, showFileList, onToggleFileList, stopSharing,
  expiryOption, setExpiryOption, customCodeInput, setCustomCodeInput, errorMsg, startSharing,
}) => (
  <div className="space-y-4 motion-rise">
    <Card className="p-4">
      <div className="flex items-center gap-4">
        {metadata.files.length === 1 && selectedFiles[0] ? (
          <>
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[10px] border border-border bg-sunken text-muted">
              <FileTypeIcon type={selectedFiles[0].fileType} size={24} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-bold text-ink">{selectedFiles[0].name}</h3>
              <p className="mt-0.5 text-[12px] text-muted font-mono">{formatFileSize(selectedFiles[0].size)}</p>
            </div>
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-bold text-ink">已选择 {metadata.files.length} 个文件</h3>
            <p className="mt-0.5 text-[12px] text-muted">总大小 {formatFileSize(metadata.totalSize)}</p>
          </div>
        )}
        <button onClick={stopSharing} aria-label="移除所选文件" className="rounded-full p-1.5 text-subtle hover:bg-sunken hover:text-danger">
          <X size={18} />
        </button>
      </div>
      {metadata.files.length > 1 && (
        <div className="mt-4 overflow-hidden rounded-[10px] border border-border">
          <button onClick={onToggleFileList} className="flex w-full items-center justify-between bg-sunken px-4 py-2.5 text-[13px] font-semibold text-muted hover:bg-border/40">
            <span>文件列表 ({metadata.files.length})</span>
            {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showFileList && (
            <div className="max-h-56 overflow-y-auto border-t border-border p-1">
              {selectedFiles.map((file, i) => (
                <div key={i} className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-[12px] hover:bg-sunken">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <FileTypeIcon type={file.fileType} size={14} className="shrink-0 text-subtle" />
                    <span className="truncate text-text">{file.name}</span>
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-subtle">{formatFileSize(file.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>

    <Card className="space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="有效期" htmlFor="expiry-select">
          <select
            id="expiry-select"
            value={expiryOption}
            onChange={(e) => setExpiryOption(e.target.value)}
            className="h-11 w-full rounded-[10px] border border-border bg-raised px-3 text-[16px] text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-sm"
          >
            <option value="10m">10 分钟</option>
            <option value="1h">1 小时</option>
            <option value="1d">1 天</option>
            <option value="never">永久</option>
          </select>
        </Field>
        <Field label="自定义口令" htmlFor="custom-code" hint="留空则随机生成 6 位">
          <Input
            id="custom-code"
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="随机 6 位（可选）"
            value={customCodeInput}
            onChange={(e) => setCustomCodeInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            aria-label="自定义口令"
          />
        </Field>
      </div>
      {errorMsg && (
        <div className="flex items-center gap-2 rounded-[10px] bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <AlertCircle size={15} /> {errorMsg}
        </div>
      )}
      <Button fullWidth size="lg" onClick={startSharing}>创建分享</Button>
    </Card>
  </div>
);

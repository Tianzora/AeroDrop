import React from 'react';
import { Layers, ChevronDown, ChevronUp, PlayCircle, Download } from 'lucide-react';
import { FileMetadata } from '../../../types';
import { formatFileSize } from '../../../services/fileUtils';
import type { FileType } from '../../../services/fileType';
import { FileTypeIcon } from '../../FileTypeIcon';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { Panel } from '../../ui/Panel';

export interface ReceiverOfferPanelProps {
  metadata: FileMetadata;
  senderDeviceName: string;
  isMultiFile: boolean;
  selectedFiles: Array<{ name: string; size: number; fileType: FileType }>;
  showFileList: boolean;
  onToggleFileList: () => void;
  primaryFileName?: string;
  primaryFileType?: FileType | null;
  canResume: boolean;
  isStreaming: boolean;
  onResumeTransfer: () => void;
  onAcceptTransfer: () => void;
}

export const ReceiverOfferPanel: React.FC<ReceiverOfferPanelProps> = ({
  metadata, senderDeviceName, isMultiFile, selectedFiles, showFileList, onToggleFileList,
  primaryFileName, primaryFileType, canResume, isStreaming, onResumeTransfer, onAcceptTransfer,
}) => (
  <div className="space-y-4">
    <Card className="p-5">
      {senderDeviceName && (
        <p className="mb-4 text-[13px] text-muted">来自 <span className="font-semibold text-ink">{senderDeviceName}</span></p>
      )}
      <div className="flex items-start gap-4">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[4px] border border-border bg-sunken text-muted">
          {isMultiFile ? <Layers size={24} className="text-accent" /> : <FileTypeIcon type={primaryFileType ?? 'unknown'} size={24} />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[17px] font-bold text-ink">{isMultiFile ? `${metadata.files.length} 个文件` : primaryFileName}</h3>
          <p className="mt-1 text-[13px] text-muted tabular-nums">{formatFileSize(metadata.totalSize)}</p>
        </div>
      </div>

      {isMultiFile && selectedFiles.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-[4px] border border-border">
          <button onClick={onToggleFileList} className="flex w-full items-center justify-between bg-sunken px-4 py-2.5 text-[13px] font-semibold text-muted transition-colors duration-200 hover:bg-border/40">
            <span>文件列表 ({selectedFiles.length})</span>
            {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showFileList && (
            <div className="max-h-56 overflow-y-auto border-t border-border p-1">
              {selectedFiles.map((file, i) => (
                <div key={`${file.name}-${i}`} className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-[12px] transition-colors duration-200 hover:bg-sunken">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <FileTypeIcon type={file.fileType} size={14} className="shrink-0 text-subtle" />
                    <span className="truncate text-text">{file.name}</span>
                  </div>
                  <span className="shrink-0 tabular-nums text-subtle">{formatFileSize(file.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-5 space-y-2.5">
        {canResume && (
          <Button fullWidth size="lg" icon={<PlayCircle size={18} />} onClick={onResumeTransfer}>
            {isStreaming ? '重新开始' : '继续下载'}
          </Button>
        )}
        <Button
          fullWidth size="lg"
          variant={canResume ? 'secondary' : 'primary'}
          icon={canResume ? undefined : <Download size={18} />}
          onClick={onAcceptTransfer}
        >
          {canResume ? '重新下载所有' : '确认并下载'}
        </Button>
      </div>
    </Card>
    <Panel title="保存位置" bodyClassName="pt-3">
      <p className="text-[13px] text-muted">文件将保存到浏览器默认下载位置；若浏览器支持，会先询问保存目录。</p>
    </Panel>
  </div>
);

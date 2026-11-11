import React from 'react';
import { TransferState, FileMetadata } from '../../types';
import { formatFileSize } from '../../services/fileUtils';
import { Download, HardDriveDownload, Loader2, AlertCircle, Delete, ClipboardPaste, Layers, PlayCircle, ChevronDown, ChevronUp } from 'lucide-react';
import type { FileType } from '../../services/fileType';
import { FileTypeIcon } from '../FileTypeIcon';
import CodeSlots, { type CodeSlotsStatus } from '../CodeSlots';
import {
  getReceiverWaitingStatusCopy,
  type ReceiverWaitingStage,
} from '../../services/receiverStatusCopy';

export type ReceiverConnectingStage = ReceiverWaitingStage;

interface ReceiverUIProps {
  state: TransferState;
  code: string;
  codeStatus: CodeSlotsStatus;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isMobileDevice: boolean;
  onCodeChange: (value: string) => void;
  onDigitClick: (digit: string) => void;
  onPasteFromClipboard: () => void;
  onBackspace: () => void;
  onClear: () => void;
  connectingStage: ReceiverConnectingStage;
  reconnectAttempt: number;
  onReset: () => void;
  metadata: FileMetadata | null;
  senderDeviceName: string;
  isMultiFile: boolean;
  selectedFiles: Array<{
    name: string;
    size: number;
    fileType: FileType;
  }>;
  showFileList: boolean;
  onToggleFileList: () => void;
  primaryFileName?: string;
  primaryFileType?: FileType | null;
  canResume: boolean;
  isStreaming: boolean;
  onResumeTransfer: () => void;
  onAcceptTransfer: () => void;
  progress: number;
  downloadSpeed: string;
  eta: string;
  overallTransferredBytes: number;
  totalBytes: number;
  overallEta: string;
  errorMsg: string;
  onRetry: () => void;
}

function usePrefersDark(): boolean {
  const [dark, setDark] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

function useCodeSlotSize(): number {
  const compute = () => (typeof window === 'undefined' ? 44 : window.innerWidth < 360 ? 38 : 44);
  const [size, setSize] = React.useState(compute);
  React.useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export const ReceiverUI: React.FC<ReceiverUIProps> = ({
  state,
  code,
  inputRef,
  isMobileDevice,
  onCodeChange,
  onDigitClick,
  onPasteFromClipboard,
  onBackspace,
  onClear,
  connectingStage,
  reconnectAttempt,
  onReset,
  metadata,
  senderDeviceName,
  isMultiFile,
  selectedFiles,
  showFileList,
  onToggleFileList,
  primaryFileName,
  primaryFileType,
  canResume,
  isStreaming,
  onResumeTransfer,
  onAcceptTransfer,
  progress,
  downloadSpeed,
  eta,
  codeStatus,
  overallTransferredBytes,
  totalBytes,
  overallEta,
  errorMsg,
  onRetry,
}) => {
  const waitingStatus = getReceiverWaitingStatusCopy({
    stage: connectingStage,
    reconnectAttempt,
  });
  const prefersDark = usePrefersDark();
  const codeSlotSize = useCodeSlotSize();
  // 官方 CodeSlots 的五个颜色语义：accent = 落入的填充 / 成功扫光，ink = 光标与活跃格，
  // slot = 空格底色，digit = 填充上的数字，danger = 错误态。深浅色各一套，参数沿用用户调好的那版。
  const slotTone = prefersDark
    ? { accent: '#3b82f6', ink: '#f5f5f5', slot: '#334155', digit: '#ffffff', danger: '#ff3b30' }
    : { accent: '#3b82f6', ink: '#1e293b', slot: '#f8fafc', digit: '#ffffff', danger: '#dc2626' };
  // 打勾扫光期间（codeStatus==='success'）连接层可能已跑到 PEER_CONNECTED 并带来元数据，
  // 但成功动画必须播完再换页：这里纯渲染层压住确认/进度面板，直到 Receiver 把 codeStatus
  // 复位 idle。ERROR/COMPLETED 例外，故障/完成立即呈现。不延迟任何连接/仲裁逻辑。
  const showCodeEntry =
    state === TransferState.IDLE ||
    (codeStatus === 'success' && state !== TransferState.ERROR && state !== TransferState.COMPLETED);

  return (
    <div className="max-w-xl mx-auto p-4 sm:p-6 bg-white dark:bg-slate-800 rounded-card shadow-card border border-slate-100 dark:border-slate-700 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold text-slate-800 dark:text-white">接收文件</h2>
        {showCodeEntry && (
          <p className="text-slate-500 dark:text-slate-400">输入 6 位口令</p>
        )}
      </div>

      {showCodeEntry && (
        <div className="flex flex-col items-center">
          <div className="mb-3 flex justify-center">
            <CodeSlots
              length={6}
              value={code}
              onChange={onCodeChange}
              status={codeStatus}
              autoFocus={!isMobileDevice}
              inputRef={inputRef}
              ariaLabel="6 位口令"
              slotSize={codeSlotSize}
              gap={9}
              radius={12}
              bounce={0.2}
              settle={0.35}
              rise={8}
              cascade={20}
              accentColor={slotTone.accent}
              inkColor={slotTone.ink}
              slotColor={slotTone.slot}
              digitColor={slotTone.digit}
              dangerColor={slotTone.danger}
            />
          </div>
          {/* 输错口令的行内提示：占位高度固定，出现/消失都不推动键盘 */}
          <div className="mb-5 h-5 text-center" aria-live="polite">
            {errorMsg && (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-red-600 dark:text-red-400">
                <AlertCircle size={16} />
                {errorMsg}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 w-full max-w-[280px] mb-8">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button key={num} onClick={() => onDigitClick(num.toString())} className="h-14 sm:h-16 rounded-control bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xl font-semibold tabular-nums hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">
                {num}
              </button>
            ))}
            <button onClick={onPasteFromClipboard} aria-label="粘贴 6 位口令" title="粘贴 6 位口令" className="h-14 sm:h-16 rounded-control bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400 flex items-center justify-center hover:bg-brand-100 dark:hover:bg-brand-900/30 transition-colors shadow-sm border border-brand-100 dark:border-brand-900/30">
              <ClipboardPaste size={20} />
            </button>
            <button onClick={() => onDigitClick('0')} className="h-14 sm:h-16 rounded-control bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xl font-semibold tabular-nums hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">
              0
            </button>
            <button onClick={onBackspace} onContextMenu={(e) => { e.preventDefault(); onClear(); }} aria-label="删除" title="删除（长按清空）" className="h-14 sm:h-16 rounded-control bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">
              <Delete size={20} />
            </button>
          </div>
        </div>
      )}

      {state === TransferState.WAITING_FOR_PEER && codeStatus !== 'success' && (
        <div className="flex flex-col items-center py-10 animate-pop-in">
          <Loader2 size={32} className="animate-spin text-brand-500 mb-4" />
          <p className="text-slate-600 dark:text-slate-300 font-medium">{waitingStatus.title}</p>
          {waitingStatus.detail && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{waitingStatus.detail}</p>
          )}
          <button onClick={onReset} className="mt-8 px-6 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors shadow-sm active:scale-95">
            {waitingStatus.cancelLabel}
          </button>
        </div>
      )}

      {codeStatus !== 'success' && (state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && metadata && (
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-control p-6 animate-slide-up">
          {senderDeviceName && (
            <div className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              发送方设备: <span className="font-semibold text-slate-800 dark:text-slate-100">{senderDeviceName}</span>
            </div>
          )}
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-control shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-center text-slate-500 shrink-0">
              {isMultiFile ? (
                <Layers size={20} className="text-brand-500" />
              ) : (
                <FileTypeIcon
                  type={primaryFileType ?? 'unknown'}
                  size={20}
                  className="text-slate-500 dark:text-slate-300"
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-bold text-slate-800 dark:text-white text-base leading-tight mb-1 truncate">{isMultiFile ? `${metadata.files.length} 个文件` : primaryFileName}</h4>
              <p className="text-sm text-slate-500 dark:text-slate-400">{formatFileSize(metadata.totalSize)}</p>
            </div>
          </div>

          {isMultiFile && selectedFiles.length > 0 && (
            <div className="border border-slate-200 dark:border-slate-700 rounded-control overflow-hidden mb-6 animate-slide-up">
              <button onClick={onToggleFileList} className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 flex justify-between text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-700 dark:text-slate-300">
                <span>文件列表 ({selectedFiles.length})</span>
                {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {showFileList && (
                <div className="max-h-48 overflow-y-auto bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 p-1">
                  {selectedFiles.map((file, i) => (
                    <div key={`${file.name}-${i}`} className="flex justify-between items-center text-xs py-1.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-700 rounded">
                      <div className="flex items-center gap-2 truncate flex-1 mr-4 min-w-0">
                        <FileTypeIcon
                          type={file.fileType}
                          size={16}
                          className="text-slate-400 dark:text-slate-300 shrink-0"
                        />
                        <span className="truncate text-slate-600 dark:text-slate-300">{file.name}</span>
                      </div>
                      <span className="text-slate-500 dark:text-slate-400 font-mono">{formatFileSize(file.size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state === TransferState.PEER_CONNECTED && (
            <div className="space-y-3">
              {canResume && (
                <button onClick={onResumeTransfer} className="w-full bg-brand-600 text-white font-bold py-3 rounded-full hover:bg-brand-700 transition-ui motion-fast flex items-center justify-center gap-2 shadow-md">
                  <PlayCircle size={18} /> {isStreaming ? '重新开始' : '继续下载'}
                </button>
              )}
              <button onClick={onAcceptTransfer} className={`w-full font-bold py-3 rounded-full transition-ui motion-fast flex items-center justify-center gap-2 ${canResume ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200' : 'bg-brand-600 hover:bg-brand-700 text-white shadow-lg shadow-brand-600/25 hover:shadow-xl hover:shadow-brand-600/30 hover:-translate-y-0.5'}`}>
                <Download size={18} /> {canResume ? '重新下载所有' : '确认并下载'}
              </button>
            </div>
          )}

          {state === TransferState.TRANSFERRING && (
            <div className="space-y-3">
              <div className="flex justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase">
                <span>当前文件进度</span>
                <span className="tabular-nums">{progress}%</span>
              </div>
              <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                <div className="bg-brand-500 h-full origin-left transition-transform motion-base relative" style={{ transform: `scaleX(${progress / 100})` }}></div>
              </div>
              <div className="flex justify-between items-center text-xs text-slate-600 dark:text-slate-400 tabular-nums pt-1">
                <span>{downloadSpeed}</span>
                <span>{eta}</span>
              </div>
              <div className="flex justify-between items-center text-xs text-slate-600 dark:text-slate-400 tabular-nums pt-1">
                <span>{formatFileSize(overallTransferredBytes)} / {formatFileSize(totalBytes)}</span>
                <span>预计剩余 {overallEta}</span>
              </div>
              <button onClick={onReset} className="w-full h-11 mt-2 rounded-full bg-red-50 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20">
                取消
              </button>
            </div>
          )}
        </div>
      )}

      {state === TransferState.ERROR && (
        <div className="text-center py-8 animate-pop-in">
          <AlertCircle size={32} className="text-red-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-slate-800 dark:text-white">传输失败</h3>
          <p className="text-slate-500 dark:text-slate-400 mt-2 mb-6">{errorMsg}</p>
          <div className="flex gap-4 justify-center">
            <button onClick={onReset} className="px-6 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-full font-medium">
              取消
            </button>
            <button onClick={onRetry} className="px-6 py-2.5 bg-slate-200 text-slate-700 rounded-full font-medium hover:bg-slate-300">
              重试
            </button>
          </div>
        </div>
      )}

      {state === TransferState.COMPLETED && (
        <div className="text-center py-8 animate-pop-in">
          <HardDriveDownload size={32} className="text-green-500 mx-auto mb-6" />
          <h3 className="text-xl font-bold text-slate-800 dark:text-white">下载完成</h3>
          <button onClick={onReset} className="mt-8 px-6 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-full hover:bg-slate-200">
            接收下一个
          </button>
        </div>
      )}
    </div>
  );
};

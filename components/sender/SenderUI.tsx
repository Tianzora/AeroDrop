import React from 'react';
import { TransferState, FileMetadata } from '../../types';
import { formatFileSize } from '../../services/fileUtils';
import type { FileType } from '../../services/fileType';
import { Upload, AlertCircle, AlertTriangle, X, Check, Copy, Loader2, Folder, ChevronDown, ChevronUp, Monitor, StopCircle } from 'lucide-react';
import { SHARE_EXPIRED_REMAINING_TEXT } from '../../services/connectionGuidance';
import { motion, useReducedMotion } from 'motion/react';
import { FileTypeIcon } from '../FileTypeIcon';
import { ProgressTrack, TransferProgressCard } from '../TransferProgress';

const EASE_UI: [number, number, number, number] = [0.23, 1, 0.32, 1];

const StatusDot: React.FC<{ tone: 'live' | 'waiting' | 'done' }> = ({ tone }) => {
  const reduceMotion = useReducedMotion();
  const color =
    tone === 'done'
      ? 'bg-emerald-500'
      : tone === 'live'
        ? 'bg-brand-500'
        : 'bg-slate-400 dark:bg-night-400';

  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center" aria-hidden="true">
      {tone === 'live' && !reduceMotion && (
        <motion.span
          className={`absolute inset-0 rounded-full ${color}`}
          animate={{ scale: [1, 2.6], opacity: [0.45, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <motion.span
        className={`absolute inset-0 rounded-full ${color}`}
        animate={tone === 'waiting' && !reduceMotion ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
        transition={
          tone === 'waiting' && !reduceMotion ? { duration: 2.4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.15 }
        }
      />
    </span>
  );
};

export type SenderPeerTransferStat = {
  peerId: string;
  deviceName: string;
  connectionType: '直连' | '点对点' | '中继（速度会变慢）' | '检测中';
  speed: string;
  progress: number;
  status: 'waiting' | 'transferring' | 'completed';
};

export type SenderSelectedFile = {
  name: string;
  size: number;
  fileType: FileType;
};

interface SenderUIProps {
  state: TransferState;
  isDragOver: boolean;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  metadata: FileMetadata | null;
  showFileList: boolean;
  onToggleFileList: () => void;
  stopSharing: () => void;
  selectedFiles: SenderSelectedFile[];
  expiryOption: string;
  setExpiryOption: React.Dispatch<React.SetStateAction<string>>;
  customCodeInput: string;
  setCustomCodeInput: React.Dispatch<React.SetStateAction<string>>;
  errorMsg: string;
  startSharing: () => void;
  preparingStage: 'fetching_ice' | 'connecting_signaling';
  handleCopyCode: () => void;
  copied: boolean;
  transferCode: string;
  linkCopied: boolean;
  shareLink: string;
  handleCopyLink: () => void;
  remainingTime: string;
  /**
   * 口令/链接已作废时的说明文案（null = 仍有效）。和 remainingTime 分开：倒计时是
   * 会走的数字，作废是持久事实，传输还在跑时后者不能随时间消失。
   */
  shareRevokedMessage: string | null;
  connectionStatus: string;
  individualStats: SenderPeerTransferStat[];
  totalProgress: number;
  activeTransfersCount: number;
  currentFileIndex: number;
  fileList: File[];
  totalBytes: number;
  transferredBytes: number;
  overallEta: string;
  activeConnectionsCount: number;
  currentSpeedBytes: number;
  avgSpeedBytes: number;
}

export const SenderUI: React.FC<SenderUIProps> = ({
  state,
  isDragOver,
  handleFileSelect,
  handleFolderSelect,
  metadata,
  showFileList,
  onToggleFileList,
  stopSharing,
  selectedFiles,
  expiryOption,
  setExpiryOption,
  customCodeInput,
  setCustomCodeInput,
  errorMsg,
  startSharing,
  preparingStage,
  handleCopyCode,
  copied,
  transferCode,
  linkCopied,
  shareLink,
  handleCopyLink,
  remainingTime,
  shareRevokedMessage,
  connectionStatus,
  individualStats,
  totalProgress,
  activeTransfersCount,
  currentFileIndex,
  fileList,
  totalBytes,
  transferredBytes,
  overallEta,
  activeConnectionsCount,
  currentSpeedBytes,
  avgSpeedBytes,
}) => {
  const reduceMotion = useReducedMotion();
  const hasSingleDevice = individualStats.length === 1;
  // 分享到期后新接收者已被拒绝，但已有传输可能仍在继续：此时不能再让人复制旧口令/链接。
  const shareExpired = shareRevokedMessage !== null || remainingTime === SHARE_EXPIRED_REMAINING_TEXT;

  return (
    <div className="w-full max-w-xl mx-auto p-4 md:p-6 bg-white dark:bg-night-850 rounded-card shadow-card border border-slate-100 dark:border-night-750 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold text-slate-800 dark:text-night-100">发送文件</h2>
      </div>

      {state === TransferState.IDLE && (
        <div
          className={`relative border-2 border-dashed rounded-card p-8 md:p-10 flex flex-col items-center justify-center cursor-pointer transition-ui motion-base group ${
            isDragOver
              ? 'border-brand-500 bg-brand-50 dark:bg-night-800 scale-[1.02] shadow-xl'
              : 'border-slate-300 dark:border-night-700 hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-night-800/50'
          }`}
        >
          <input type="file" id="file-upload" className="hidden" multiple onChange={handleFileSelect} />
          <input type="file" id="folder-upload" className="hidden" webkitdirectory="" directory="" onChange={handleFolderSelect} />

          <div className={`w-16 h-16 bg-brand-50 dark:bg-night-800 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center mb-4 transition-transform motion-base ${isDragOver ? 'scale-110 rotate-12' : 'group-hover:scale-110'}`}>
            <Upload size={32} className={isDragOver ? 'text-brand-600 dark:text-brand-400' : 'text-brand-500 dark:text-brand-400'} />
          </div>
          <p className="text-xl font-medium text-slate-700 dark:text-night-200">{isDragOver ? '松开添加' : '点击上传或拖拽'}</p>
          <p className="text-sm text-slate-500 dark:text-night-400 mt-2 mb-4">支持多文件、文件夹</p>

          <label
            htmlFor="folder-upload"
            className="z-10 bg-white dark:bg-night-900 border border-slate-200 dark:border-night-700 px-4 py-2 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-night-800 hover:text-brand-600 transition-colors flex items-center gap-2 cursor-pointer shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <Folder size={16} /> 选择文件夹
          </label>
          <label htmlFor="file-upload" className="absolute inset-0 cursor-pointer"></label>
        </div>
      )}

      {state === TransferState.CONFIGURING && metadata && (
        <div className="space-y-6">
          <div className="bg-slate-50 dark:bg-night-900 p-4 rounded-control flex items-center gap-4 border border-slate-100 dark:border-night-750 animate-slide-up">
            {metadata.files.length === 1 && selectedFiles[0] ? (
              <>
                <div className="w-12 h-12 bg-white dark:bg-night-850 rounded-control shadow-sm border border-slate-100 dark:border-night-750 flex items-center justify-center text-slate-500 shrink-0">
                  <FileTypeIcon
                    type={selectedFiles[0].fileType}
                    size={20}
                    className="text-slate-500 dark:text-night-300"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-slate-800 dark:text-night-100 truncate">{selectedFiles[0].name}</h4>
                  <p className="text-xs text-slate-500 dark:text-night-400">{formatFileSize(selectedFiles[0].size)}</p>
                </div>
              </>
            ) : (
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-slate-800 dark:text-night-100">已选择 {metadata.files.length} 个文件</h4>
                <p className="text-xs text-slate-500 dark:text-night-400">总大小: {formatFileSize(metadata.totalSize)}</p>
              </div>
            )}
            <button onClick={stopSharing} aria-label="返回" className="relative p-2 -m-2 rounded-full text-slate-400 hover:text-red-500 transition-colors after:absolute after:-inset-1 after:content-['']"><X size={20} /></button>
          </div>

          {metadata.files.length > 1 && (
            <div className="border border-slate-200 dark:border-night-750 rounded-control overflow-hidden animate-slide-up">
              <button onClick={onToggleFileList} className="w-full px-4 py-2 bg-slate-50 dark:bg-night-900 flex justify-between text-sm hover:bg-slate-100 dark:hover:bg-night-800 transition-colors text-slate-700 dark:text-night-300">
                <span>文件列表 ({metadata.files.length})</span>
                {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {showFileList && (
                <div className="max-h-48 overflow-y-auto bg-white dark:bg-night-850 border-t border-slate-100 dark:border-night-750 p-1">
                  {selectedFiles.map((f, i) => (
                    <div key={i} className="flex justify-between items-center text-xs py-1.5 px-3 hover:bg-slate-50 dark:hover:bg-night-750 rounded">
                      <div className="flex items-center gap-2 truncate flex-1 mr-4 min-w-0">
                        <FileTypeIcon
                          type={f.fileType}
                          size={16}
                          className="text-slate-400 dark:text-night-300 shrink-0"
                        />
                        <span className="truncate text-slate-600 dark:text-night-300">{f.name}</span>
                      </div>
                      <span className="text-slate-500 dark:text-night-400 font-mono">{formatFileSize(f.size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 dark:text-night-400 mb-1 block">有效期</label>
                <select value={expiryOption} onChange={(e) => setExpiryOption(e.target.value)} className="w-full h-11 px-2 bg-white dark:bg-night-900 border border-slate-200 dark:border-night-750 rounded-control text-sm text-slate-800 dark:text-night-100">
                  <option value="10m">10 分钟</option>
                  <option value="1h">1 小时</option>
                  <option value="1d">1 天</option>
                  <option value="never">永久</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 dark:text-night-400 mb-1 block">自定义口令</label>
                <input type="text" inputMode="numeric" maxLength={6} placeholder="随机 6 位（可选）" value={customCodeInput} onChange={(e) => setCustomCodeInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} className="w-full h-11 px-2 bg-white dark:bg-night-900 border border-slate-200 dark:border-night-750 rounded-control text-sm text-slate-800 dark:text-night-100" />
              </div>
            </div>
            {errorMsg && <div className="text-red-500 text-sm flex items-center gap-2 bg-red-50 dark:bg-red-500/10 p-2 rounded"><AlertCircle size={16} /> {errorMsg}</div>}
            <button onClick={startSharing} className="w-full bg-brand-600 text-white font-bold py-3.5 rounded-full hover:bg-brand-700 shadow-card transition-ui motion-fast active:scale-[0.99]">创建分享</button>
          </div>
        </div>
      )}

      {state === TransferState.GENERATING_CODE && (
        <div className="py-12 flex flex-col items-center justify-center text-center animate-pop-in">
          <Loader2 size={32} className="animate-spin text-brand-500 mb-4" />
          <h3 className="text-xl font-bold text-slate-800 dark:text-night-100">
            {preparingStage === 'fetching_ice' ? '获取网络配置...' : '连接信令服务...'}
          </h3>
        </div>
      )}

      {(state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && (
        <div className="animate-pop-in">
          <section>
            <h3 className="text-xs font-medium text-slate-500 dark:text-night-400">分享口令</h3>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="flex items-baseline gap-[0.08em] font-mono text-[2.25rem] font-bold leading-none text-brand-600 sm:text-[2.5rem] dark:text-brand-400">
                {shareExpired ? (
                  <span className="font-sans text-lg font-medium text-slate-400 dark:text-night-400">已失效</span>
                ) : transferCode.split('').map((digit, index) => (
                  <motion.span
                    key={`${index}-${digit}`}
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.025 * index, duration: 0.22, ease: EASE_UI }}
                  >
                    {digit}
                  </motion.span>
                ))}
              </span>
              {!shareExpired && <button
                type="button"
                onClick={handleCopyCode}
                aria-label={copied ? '已复制分享口令' : '复制分享口令'}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                  copied
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'border-slate-200 text-slate-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-night-700 dark:text-night-300 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/10 dark:hover:text-brand-400'
                }`}
              >
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                {copied ? '已复制' : '复制'}
              </button>}
            </div>
          </section>

          <div className="my-5 -mx-5 border-t border-dashed border-slate-200 dark:border-night-700 md:-mx-6" />

          <div>
            <button
              type="button"
              onClick={handleCopyLink}
              disabled={shareExpired}
              aria-label="复制分享链接"
              className="group flex w-full items-center gap-3 py-2 text-left disabled:cursor-not-allowed"
            >
              <span className="w-16 shrink-0 text-xs font-medium text-slate-500 dark:text-night-400">分享链接</span>
              <span className={`min-w-0 flex-1 truncate font-mono text-xs ${
                shareExpired ? 'text-slate-400 line-through dark:text-night-500' : 'text-slate-600 dark:text-night-300'
              }`}>{shareExpired ? '链接已失效' : shareLink}</span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors group-hover:bg-slate-100 group-hover:text-slate-700 dark:group-hover:bg-night-800 dark:group-hover:text-night-200">
                {linkCopied ? (
                  <Check size={14} className="text-emerald-500" aria-hidden="true" />
                ) : (
                  <Copy size={13} aria-hidden="true" />
                )}
              </span>
            </button>
            {shareRevokedMessage && (
              <p className="flex items-start gap-1.5 pb-1 pl-16 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                {shareRevokedMessage}
              </p>
            )}
            <div className="flex items-center gap-3 py-2">
              <span className="w-16 shrink-0 text-xs font-medium text-slate-500 dark:text-night-400">有效期</span>
              <span className="text-sm tabular-nums text-slate-700 dark:text-night-200">
                {shareRevokedMessage ? SHARE_EXPIRED_REMAINING_TEXT : remainingTime || '--'}
              </span>
            </div>
            <div className="flex items-center gap-3 py-2">
              <span className="w-16 shrink-0 text-xs font-medium text-slate-500 dark:text-night-400">状态</span>
              <span className="text-sm font-medium text-brand-600 dark:text-brand-400">
                {/* 降级原因已经在上面的琥珀色提示里说完了：同一句话在状态位再复述一遍
                    只会让用户以为出了两个问题。 */}
                {connectionStatus === shareRevokedMessage && shareRevokedMessage
                  ? '链接已失效'
                  : connectionStatus || (state === TransferState.TRANSFERRING ? '传输中' : '等待连接')}
              </span>
            </div>
          </div>

          {individualStats.length > 0 && (
            <section className="mt-5">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-night-400">
                <Monitor size={13} aria-hidden="true" />
                设备传输列表 ({individualStats.length})
              </h3>
              <div className="mt-1 divide-y divide-slate-100 dark:divide-night-750/70">
                {individualStats.map((stat) => {
                  const statTone =
                    stat.status === 'completed' ? 'done' : stat.status === 'transferring' ? 'live' : 'waiting';
                  const statText =
                    stat.status === 'completed'
                      ? '已完成'
                      : stat.status === 'transferring'
                        ? hasSingleDevice
                          ? '传输中'
                          : `${stat.progress}%`
                        : state === TransferState.TRANSFERRING
                          ? '准备中'
                          : '等待接收';
                  const isRelay = stat.connectionType.includes('中继');

                  return (
                    <div key={stat.peerId} className="py-2.5">
                      <div className="flex items-center gap-2.5">
                        <StatusDot tone={statTone} />
                        <span
                          className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-night-100"
                          title={stat.peerId}
                        >
                          {stat.deviceName}
                        </span>
                        <span
                          className={`shrink-0 text-[11px] ${
                            isRelay ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-night-400'
                          }`}
                        >
                          {stat.connectionType}
                        </span>
                        <span
                          className={`w-14 shrink-0 text-right text-xs font-medium tabular-nums ${
                            statTone === 'done'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : statTone === 'live'
                                ? 'text-brand-600 dark:text-brand-400'
                                : 'text-slate-500 dark:text-night-400'
                          }`}
                        >
                          {statText}
                        </span>
                      </div>
                      {!hasSingleDevice && (
                        <div className="mt-2 flex items-center gap-3 pl-[16px]">
                          <div className="min-w-0 flex-1">
                            <ProgressTrack
                              value={stat.progress}
                              tone={stat.status === 'completed' ? 'success' : 'brand'}
                              label={`${stat.deviceName} 传输进度`}
                            />
                          </div>
                          <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500 dark:text-night-400">
                            {stat.speed}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {state === TransferState.TRANSFERRING && (
            <TransferProgressCard
              progress={totalProgress}
              transferredBytes={transferredBytes}
              totalBytes={totalBytes}
              fileName={fileList[currentFileIndex]?.name ?? metadata?.files[currentFileIndex]?.name}
              filePosition={
                (metadata?.files.length ?? 0) > 1
                  ? `第 ${currentFileIndex + 1} / ${metadata?.files.length} 个文件`
                  : undefined
              }
              currentSpeedBytes={currentSpeedBytes}
              averageSpeedBytes={avgSpeedBytes}
              eta={overallEta}
            />
          )}

          <div className="pt-4">
            <button onClick={stopSharing} className="w-full h-12 bg-red-600 text-white text-sm font-bold rounded-full shadow-md shadow-red-600/20 hover:bg-red-700 active:scale-[0.99] transition-colors flex items-center justify-center gap-2">
              <StopCircle size={18} /> {shareExpired ? '重新创建分享' : '停止分享'}
            </button>
          </div>
        </div>
      )}

      {state === TransferState.ERROR && (
        <div className="text-center py-8 animate-pop-in">
          <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4"><AlertCircle size={32} /></div>
          <h3 className="text-xl font-bold">发生错误</h3>
          <p className="text-slate-500 mt-2 mb-6">{errorMsg}</p>
          <button onClick={stopSharing} className="px-6 py-2 bg-slate-200 rounded-full">返回</button>
        </div>
      )}
    </div>
  );
};

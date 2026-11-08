import React from 'react';
import { TransferState, FileMetadata } from '../../types';
import { formatFileSize } from '../../services/fileUtils';
import type { FileType } from '../../services/fileType';
import { Upload, AlertCircle, X, Check, Loader2, Link as LinkIcon, Folder, ChevronDown, ChevronUp, Monitor, StopCircle } from 'lucide-react';
import { FileTypeIcon } from '../FileTypeIcon';

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
  currentSpeed: string;
  avgSpeed: string;
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
  currentSpeed,
  avgSpeed,
}) => {
  return (
    <div className="w-full max-w-xl mx-auto p-4 md:p-6 bg-white dark:bg-slate-800 rounded-card shadow-card border border-slate-100 dark:border-slate-700 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold text-slate-800 dark:text-white">发送文件</h2>
        <p className="text-slate-500 dark:text-slate-400">点对点加密传输 (支持文件夹/多文件)</p>
      </div>

      {state === TransferState.IDLE && (
        <div
          className={`relative border-2 border-dashed rounded-card p-8 md:p-10 flex flex-col items-center justify-center cursor-pointer transition-ui motion-base group ${
            isDragOver
              ? 'border-brand-500 bg-brand-50 dark:bg-slate-700 scale-[1.02] shadow-xl'
              : 'border-slate-300 dark:border-slate-600 hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
          }`}
        >
          <input type="file" id="file-upload" className="hidden" multiple onChange={handleFileSelect} />
          <input type="file" id="folder-upload" className="hidden" webkitdirectory="" directory="" onChange={handleFolderSelect} />

          <div className={`w-16 h-16 bg-brand-50 dark:bg-slate-700 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center mb-4 transition-transform motion-base ${isDragOver ? 'scale-110 rotate-12' : 'group-hover:scale-110'}`}>
            <Upload size={32} className={isDragOver ? 'text-brand-600 dark:text-brand-400' : 'text-brand-500 dark:text-brand-400'} />
          </div>
          <p className="text-xl font-medium text-slate-700 dark:text-slate-200">{isDragOver ? '松开添加' : '点击上传或拖拽'}</p>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 mb-4">支持多文件、文件夹</p>

          <label
            htmlFor="folder-upload"
            className="z-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-4 py-2 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-brand-600 transition-colors flex items-center gap-2 cursor-pointer shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <Folder size={16} /> 选择文件夹
          </label>
          <label htmlFor="file-upload" className="absolute inset-0 cursor-pointer"></label>
        </div>
      )}

      {state === TransferState.CONFIGURING && metadata && (
        <div className="space-y-6">
          <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-control flex items-center gap-4 border border-slate-100 dark:border-slate-800 animate-slide-up">
            {metadata.files.length === 1 && selectedFiles[0] ? (
              <>
                <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-control shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-center text-slate-500 shrink-0">
                  <FileTypeIcon
                    type={selectedFiles[0].fileType}
                    size={20}
                    className="text-slate-500 dark:text-slate-300"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-slate-800 dark:text-white truncate">{selectedFiles[0].name}</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{formatFileSize(selectedFiles[0].size)}</p>
                </div>
              </>
            ) : (
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-slate-800 dark:text-white">已选择 {metadata.files.length} 个文件</h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">总大小: {formatFileSize(metadata.totalSize)}</p>
              </div>
            )}
            <button onClick={stopSharing} aria-label="返回" className="relative p-2 -m-2 rounded-full text-slate-400 hover:text-red-500 transition-colors after:absolute after:-inset-1 after:content-['']"><X size={20} /></button>
          </div>

          {metadata.files.length > 1 && (
            <div className="border border-slate-200 dark:border-slate-700 rounded-control overflow-hidden animate-slide-up">
              <button onClick={onToggleFileList} className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 flex justify-between text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-700 dark:text-slate-300">
                <span>文件列表 ({metadata.files.length})</span>
                {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {showFileList && (
                <div className="max-h-48 overflow-y-auto bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 p-1">
                  {selectedFiles.map((f, i) => (
                    <div key={i} className="flex justify-between items-center text-xs py-1.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-700 rounded">
                      <div className="flex items-center gap-2 truncate flex-1 mr-4 min-w-0">
                        <FileTypeIcon
                          type={f.fileType}
                          size={16}
                          className="text-slate-400 dark:text-slate-300 shrink-0"
                        />
                        <span className="truncate text-slate-600 dark:text-slate-300">{f.name}</span>
                      </div>
                      <span className="text-slate-500 dark:text-slate-400 font-mono">{formatFileSize(f.size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">有效期</label>
                <select value={expiryOption} onChange={(e) => setExpiryOption(e.target.value)} className="w-full h-11 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-control text-sm text-slate-800 dark:text-slate-100">
                  <option value="10m">10 分钟</option>
                  <option value="1h">1 小时</option>
                  <option value="1d">1 天</option>
                  <option value="never">永久</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">自定义口令</label>
                <input type="text" inputMode="numeric" maxLength={6} placeholder="随机 6 位（可选）" value={customCodeInput} onChange={(e) => setCustomCodeInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} className="w-full h-11 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-control text-sm text-slate-800 dark:text-slate-100" />
              </div>
            </div>
            {errorMsg && <div className="text-red-500 text-sm flex items-center gap-2 bg-red-50 dark:bg-red-900/20 p-2 rounded"><AlertCircle size={16} /> {errorMsg}</div>}
            <button onClick={startSharing} className="w-full bg-brand-600 text-white font-bold py-3.5 rounded-full hover:bg-brand-700 shadow-card transition-ui motion-fast active:scale-[0.99]">创建分享</button>
          </div>
        </div>
      )}

      {state === TransferState.GENERATING_CODE && (
        <div className="py-12 flex flex-col items-center justify-center text-center animate-pop-in">
          <Loader2 size={32} className="animate-spin text-brand-500 mb-4" />
          <h3 className="text-xl font-bold text-slate-800 dark:text-white">
            {preparingStage === 'fetching_ice' ? '获取网络配置...' : '连接信令服务...'}
          </h3>
        </div>
      )}

      {(state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && (
        <div className="text-center space-y-6 animate-pop-in">
          <div className="relative inline-block" onClick={handleCopyCode}>
            <div className={`text-4xl font-mono font-bold tracking-widest px-8 py-4 rounded-card border-2 cursor-pointer transition-ui motion-fast ${copied ? 'bg-green-100 border-green-300 text-green-700' : 'bg-brand-50 border-brand-100 text-brand-600 dark:bg-slate-900 dark:border-slate-700 dark:text-brand-400'}`}>
              {transferCode}
            </div>
          </div>

          <div className={`max-w-xs mx-auto bg-slate-50 dark:bg-slate-900 p-3 rounded-control border flex items-center gap-2 ${linkCopied ? 'border-green-200 bg-green-50' : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="flex-1 min-w-0 text-left">
              <div className="text-xs text-slate-500 dark:text-slate-400">分享链接</div>
              <div className="text-sm font-mono text-slate-600 dark:text-slate-300 truncate select-all">{shareLink}</div>
            </div>
            <button onClick={handleCopyLink} aria-label="复制分享链接" className="inline-flex min-w-11 min-h-11 items-center justify-center rounded-control hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"><LinkIcon size={18} /></button>
          </div>

          <div className="flex justify-center gap-6 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 py-3 rounded-control">
            <span>有效期: {remainingTime}</span>
            <span>状态: <span className="font-bold text-brand-600 dark:text-brand-400">{connectionStatus || (state === TransferState.TRANSFERRING ? '传输中' : '等待连接')}</span></span>
          </div>

          {individualStats.length > 0 && (
            <div className="bg-slate-50 dark:bg-slate-900 rounded-control border border-slate-100 dark:border-slate-700 overflow-hidden mt-2 animate-slide-up text-left">
              <div className="px-4 py-2 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 flex justify-between items-center">
                <span>设备传输列表 ({individualStats.length})</span>
                <Monitor size={16} />
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-700 max-h-52 overflow-y-auto">
                {individualStats.map((stat) => (
                  <div key={stat.peerId} className="px-4 py-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-2 h-2 rounded-full ${stat.status === 'completed' ? 'bg-green-500' : stat.status === 'transferring' ? 'bg-brand-500 animate-pulse' : 'bg-slate-400'}`}></div>
                        <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200" title={stat.peerId}>{stat.deviceName}</span>
                        <span className="inline-block max-w-[6rem] shrink-0 truncate rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                          {stat.connectionType}
                        </span>
                      </div>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className={`font-medium ${stat.status === 'completed' ? 'text-green-700 dark:text-green-400' : stat.status === 'transferring' ? 'text-brand-600 dark:text-brand-400' : 'text-slate-600 dark:text-slate-300'}`}>
                          {stat.status === 'completed' ? '已完成' : stat.status === 'transferring' ? `${stat.progress}%` : state === TransferState.TRANSFERRING ? '准备中' : '等待接收'}
                        </span>
                        <span className="text-slate-700 dark:text-slate-300 font-mono w-16 text-right tabular-nums">{stat.speed}</span>
                      </div>
                    </div>
                    <div className="mt-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5 overflow-hidden">
                      <div className={`h-full origin-left transition-transform motion-base ${stat.status === 'completed' ? 'bg-green-500' : 'bg-brand-500'}`} style={{ transform: `scaleX(${Math.max(0, Math.min(100, stat.progress)) / 100})` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {state === TransferState.TRANSFERRING && (
            <div className="w-full space-y-5">
              <div className="flex flex-col items-center gap-2">
                {totalProgress === 100 && activeTransfersCount === 0 ? (
                  <Check size={32} className="text-green-500" />
                ) : (
                  <Loader2 size={32} className="animate-spin text-brand-500" />
                )}
                <div className="text-center w-full min-w-0">
                  <p className="text-base font-bold text-slate-700 dark:text-slate-200">
                    {totalProgress === 100 && activeTransfersCount === 0 ? '传输完成' : '正在发送...'}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400 font-medium mt-1 w-full truncate">
                    {currentFileIndex + 1}/{metadata?.files.length}: {fileList[currentFileIndex]?.name}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 px-1">
                  <span>{activeConnectionsCount > 1 ? '所有设备总进度 (平均)' : '总进度'}</span>
                  <span>{totalProgress}%</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                  <div className={`h-full origin-left transition-transform motion-base relative ${totalProgress === 100 ? 'bg-green-500' : 'bg-brand-500'}`} style={{ transform: `scaleX(${totalProgress / 100})` }}>
                  </div>
                </div>
                <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 px-1 tabular-nums">
                  <span>总任务字节: {formatFileSize(totalBytes)}</span>
                  <span>已完成字节: {formatFileSize(transferredBytes)}</span>
                </div>
                <div className="flex justify-end text-xs text-slate-500 dark:text-slate-400 px-1 tabular-nums">
                  <span>预计剩余 {overallEta}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-control border border-slate-100 dark:border-slate-700 text-center">
                  <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-0.5">{activeConnectionsCount > 1 ? '所有设备总实时速度' : '实时速度'}</p>
                  <p className="text-brand-600 dark:text-brand-400 font-bold font-mono tabular-nums">{currentSpeed}</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-control border border-slate-100 dark:border-slate-700 text-center">
                  <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-0.5">{activeConnectionsCount > 1 ? '所有设备总平均速度' : '平均速度'}</p>
                  <p className="text-brand-600 dark:text-brand-400 font-bold font-mono tabular-nums">{avgSpeed}</p>
                </div>
              </div>
            </div>
          )}

          <button onClick={stopSharing} className="w-full h-12 bg-red-600 text-white text-sm font-bold rounded-full shadow-md shadow-red-600/20 hover:bg-red-700 active:scale-[0.99] transition-colors flex items-center justify-center gap-2">
            <StopCircle size={18} /> 停止分享
          </button>
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

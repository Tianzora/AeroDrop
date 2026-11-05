import React from 'react';
import { TransferState, FileMetadata } from '../../types';
import type { FileType } from '../../services/fileType';
import { SenderIdlePanel } from './panels/SenderIdlePanel';
import { SenderConfigurePanel } from './panels/SenderConfigurePanel';
import { SenderTransferPanel } from './panels/SenderTransferPanel';
import { SenderPairingPanel } from './panels/SenderPairingPanel';
import { SenderErrorPanel } from './panels/SenderErrorPanel';

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

export const SenderUI: React.FC<SenderUIProps> = (props) => {
  const {
    state, isDragOver, handleFileSelect, handleFolderSelect, metadata, showFileList, onToggleFileList,
    stopSharing, selectedFiles, expiryOption, setExpiryOption, customCodeInput, setCustomCodeInput, errorMsg,
    startSharing, preparingStage, transferCode, copied, handleCopyCode, linkCopied, shareLink, handleCopyLink,
    remainingTime, connectionStatus, individualStats, totalProgress, activeTransfersCount, currentFileIndex,
    fileList, totalBytes, transferredBytes, overallEta, activeConnectionsCount, currentSpeed, avgSpeed,
  } = props;

  let panel: React.ReactNode = null;
  if (state === TransferState.IDLE) {
    panel = <SenderIdlePanel isDragOver={isDragOver} handleFileSelect={handleFileSelect} handleFolderSelect={handleFolderSelect} />;
  } else if (state === TransferState.CONFIGURING && metadata) {
    panel = (
      <SenderConfigurePanel
        metadata={metadata} selectedFiles={selectedFiles} showFileList={showFileList} onToggleFileList={onToggleFileList}
        stopSharing={stopSharing} expiryOption={expiryOption} setExpiryOption={setExpiryOption}
        customCodeInput={customCodeInput} setCustomCodeInput={setCustomCodeInput} errorMsg={errorMsg} startSharing={startSharing}
      />
    );
  } else if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED) {
    panel = (
      <SenderPairingPanel
        state={state} transferCode={transferCode} copied={copied} handleCopyCode={handleCopyCode}
        shareLink={shareLink} linkCopied={linkCopied} handleCopyLink={handleCopyLink} remainingTime={remainingTime}
        connectionStatus={connectionStatus} individualStats={individualStats} activeConnectionsCount={activeConnectionsCount}
        stopSharing={stopSharing}
      />
    );
  } else if (
    state === TransferState.GENERATING_CODE || state === TransferState.TRANSFERRING || state === TransferState.COMPLETED
  ) {
    panel = (
      <SenderTransferPanel
        state={state} preparingStage={preparingStage} metadata={metadata} fileList={fileList}
        currentFileIndex={currentFileIndex} totalProgress={totalProgress} activeTransfersCount={activeTransfersCount}
        totalBytes={totalBytes} transferredBytes={transferredBytes} overallEta={overallEta}
        activeConnectionsCount={activeConnectionsCount} currentSpeed={currentSpeed} avgSpeed={avgSpeed}
        connectionStatus={connectionStatus} individualStats={individualStats} stopSharing={stopSharing}
      />
    );
  } else if (state === TransferState.ERROR) {
    panel = <SenderErrorPanel errorMsg={errorMsg} stopSharing={stopSharing} />;
  }

  const title =
    state === TransferState.CONFIGURING ? '分享设置'
    : state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED ? '取件口令'
    : state === TransferState.GENERATING_CODE ? '准备连接'
    : state === TransferState.TRANSFERRING ? '正在传输'
    : state === TransferState.COMPLETED ? '传输完成'
    : state === TransferState.ERROR ? '出错了'
    : '发送文件';

  return (
    <div className="mx-auto flex min-h-[560px] w-full max-w-[760px] flex-col justify-center">
      {state !== TransferState.IDLE && (
        <header className="mb-8 text-center">
          <h1 data-morph="title" className="font-serif font-normal text-[clamp(28px,3.6vw,40px)] leading-[1.1] tracking-[-.02em] text-ink">{title}</h1>
        </header>
      )}
      <div key={state} className="motion-rise">{panel}</div>
    </div>
  );
};

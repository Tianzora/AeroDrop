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

  return (
    <div className="mx-auto w-full max-w-[620px]">
      <header className="mb-7">
        <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[.18em] text-subtle">Send · 发送</p>
        <h1 className="text-[30px] font-semibold leading-[1.08] tracking-[-.03em] text-ink sm:text-[34px]">发送文件</h1>
        <p className="mt-2 text-[14px] text-muted">点对点加密传输（支持文件夹 / 多文件）</p>
      </header>
      {panel}
    </div>
  );
};

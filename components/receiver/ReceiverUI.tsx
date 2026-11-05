import React from 'react';
import { TransferState, FileMetadata } from '../../types';
import type { FileType } from '../../services/fileType';
import type { ReceiverWaitingStage } from '../../services/receiverStatusCopy';
import { ReceiverCodePanel } from './panels/ReceiverCodePanel';
import { ReceiverConnectingPanel } from './panels/ReceiverConnectingPanel';
import { ReceiverOfferPanel } from './panels/ReceiverOfferPanel';
import { ReceiverTransferPanel } from './panels/ReceiverTransferPanel';
import { ReceiverDonePanel } from './panels/ReceiverDonePanel';
import { ReceiverErrorPanel } from './panels/ReceiverErrorPanel';

export type ReceiverConnectingStage = ReceiverWaitingStage;

interface ReceiverUIProps {
  state: TransferState;
  code: string;
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
  selectedFiles: Array<{ name: string; size: number; fileType: FileType }>;
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

export const ReceiverUI: React.FC<ReceiverUIProps> = (props) => {
  const { state, metadata } = props;
  let body: React.ReactNode = null;
  if (state === TransferState.IDLE) {
    body = (
      <ReceiverCodePanel
        code={props.code} inputRef={props.inputRef} isMobileDevice={props.isMobileDevice}
        onCodeChange={props.onCodeChange} onDigitClick={props.onDigitClick}
        onPasteFromClipboard={props.onPasteFromClipboard} onBackspace={props.onBackspace} onClear={props.onClear}
      />
    );
  } else if (state === TransferState.WAITING_FOR_PEER) {
    body = <ReceiverConnectingPanel connectingStage={props.connectingStage} reconnectAttempt={props.reconnectAttempt} onReset={props.onReset} />;
  } else if ((state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && metadata) {
    body = state === TransferState.PEER_CONNECTED ? (
      <ReceiverOfferPanel
        metadata={metadata} senderDeviceName={props.senderDeviceName} isMultiFile={props.isMultiFile}
        selectedFiles={props.selectedFiles} showFileList={props.showFileList} onToggleFileList={props.onToggleFileList}
        primaryFileName={props.primaryFileName} primaryFileType={props.primaryFileType}
        canResume={props.canResume} isStreaming={props.isStreaming}
        onResumeTransfer={props.onResumeTransfer} onAcceptTransfer={props.onAcceptTransfer}
      />
    ) : (
      <ReceiverTransferPanel
        progress={props.progress} downloadSpeed={props.downloadSpeed} eta={props.eta}
        overallTransferredBytes={props.overallTransferredBytes} totalBytes={props.totalBytes}
        overallEta={props.overallEta} onReset={props.onReset}
      />
    );
  } else if (state === TransferState.ERROR) {
    body = <ReceiverErrorPanel errorMsg={props.errorMsg} onReset={props.onReset} onRetry={props.onRetry} />;
  } else if (state === TransferState.COMPLETED) {
    body = <ReceiverDonePanel onReset={props.onReset} />;
  }

  const title =
    state === TransferState.COMPLETED ? '接收完成'
    : state === TransferState.ERROR ? '出错了'
    : state === TransferState.WAITING_FOR_PEER ? '正在连接'
    : (state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) ? '正在接收'
    : '接收文件';

  return (
    <div className="mx-auto flex min-h-[560px] w-full max-w-[620px] flex-col justify-center">
      <header className="mb-8 text-center">
        <h1 data-morph="title" className="font-serif font-normal text-[clamp(28px,3.6vw,40px)] leading-[1.1] tracking-[-.02em] text-ink">{title}</h1>
        {state === TransferState.IDLE && (
          <p data-morph="sub" className="mt-5 text-[15px] leading-[1.7] text-muted">输入发送方给你的 6 位口令</p>
        )}
      </header>
      <div key={state} className="motion-rise w-full">{body}</div>
    </div>
  );
};

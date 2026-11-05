export enum TransferState {
  IDLE = 'IDLE',
  CONFIGURING = 'CONFIGURING',
  GENERATING_CODE = 'GENERATING_CODE',
  WAITING_FOR_PEER = 'WAITING_FOR_PEER',
  PEER_CONNECTED = 'PEER_CONNECTED',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface TransferConstraints {
  expiresAt?: number; 
}

export interface FileInfo {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  fingerprint?: string; 
}

export interface FileMetadata {
  files: FileInfo[];
  totalSize: number;
  constraints?: TransferConstraints;
  protocolVersion?: number;
}

export type ConnectionTypeLabel = '直连' | '点对点' | '中继（速度会变慢）' | '检测中';

export type PeerTransferStatus = 'waiting' | 'transferring' | 'completed';
export type RouteAttemptKind = 'all' | 'relay';

export interface PeerConnectionSnapshot {
  peerId: string;
  deviceName: string;
  connectionType: ConnectionTypeLabel;
  speed: string;
  progress: number;
  status: PeerTransferStatus;
}

export interface TransferSessionState {
  state: TransferState;
  errorMsg: string;
}

export interface SenderSessionSnapshot extends TransferSessionState {
  transferCode: string;
  shareLink: string;
  connectionStatus: string;
  remainingTime: string;
  totalProgress: number;
  currentFileIndex: number;
  currentSpeed: string;
  avgSpeed: string;
  currentSpeedBytes: number;
  avgSpeedBytes: number;
  activeTransfersCount: number;
  activeConnectionsCount: number;
  totalBytes: number;
  transferredBytes: number;
  overallEta: string;
  metadata: FileMetadata | null;
  peers: PeerConnectionSnapshot[];
}

export interface ReceiverSessionSnapshot extends TransferSessionState {
  code: string;
  connectingStage: 'fetching_ice' | 'connecting_signaling' | 'connecting_peer' | 'waiting_response' | 'reconnecting' | '';
  reconnectAttempt: number;
  metadata: FileMetadata | null;
  senderDeviceName: string;
  canResume: boolean;
  isStreaming: boolean;
  progress: number;
  downloadSpeed: string;
  downloadSpeedBytes: number;
  eta: string;
  overallTransferredBytes: number;
  totalBytes: number;
  overallEta: string;
  currentFileIndex: number;
  totalFiles: number;
  currentFileName: string;
}

export interface NormalizedFileRequest {
  fileIndex: number;
  byteOffset: number;
  silent?: boolean;
  receiveWindowBytes: number;
}

export interface ChunkPayload {
  data: ArrayBuffer;
  index: number;
  total: number;
  fileIndex: number;
}

export interface FileStartPayload {
  fileIndex: number;
  fileName: string;
  fileSize: number;
  fileType: string;
  /** 续传时的起始偏移（0 表示从头传）。 */
  resumeOffset?: number;
  /** 断点之前已落盘前缀的 CRC32（8 位十六进制），接收端据此校验磁盘数据。 */
  prefixCrc32?: string;
}

export interface FileCompletePayload {
  fileIndex: number;
  fileName?: string; 
  hashAlgorithm?: 'crc32';
  fileHash?: string;
  hashStartOffset?: number;
  hashedBytes?: number;
}

export interface ResumePayload {
  fileIndex: number;
  byteOffset?: number;
  silent?: boolean;
  receiveWindowBytes: number;
  // Backward compatibility for older clients.
  chunkIndex?: number;
}

// 4: METADATA 可以是分片（METADATA_CHUNK）发送，避免超过 SCTP 单消息上限。
export const P2P_PROTOCOL_VERSION = 4;

export interface MetadataChunkPayload {
  transferId: string;
  index: number;
  total: number;
  // 完整 metadata JSON 的一个片段，接收端按 index 拼接后再 JSON.parse。
  data: string;
}

export interface AcceptTransferPayload {
  persistedOverallBytes: number;
  receiveWindowBytes: number;
}

export interface TransferProgressPayload {
  overallTransferredBytes: number;
  overallTotalBytes: number;
  speedBytes: number;
  receiveWindowBytes: number;
}

export interface RejectTransferPayload {
  reason?: string;
}

export interface TransferCancelledPayload {
  reason?: string;
}

export interface DeviceInfoPayload {
  deviceName?: string;
  sessionId?: string;
}

export interface HeartbeatPayload {
  t: number;
}

export interface RouteProbePayload {
  receiverSessionId: string;
  attemptId: string;
  attemptKind: RouteAttemptKind;
  deviceName: string;
}

export interface RouteReadyPayload {
  receiverSessionId: string;
  attemptId: string;
}

export interface RouteCommitPayload {
  receiverSessionId: string;
  attemptId: string;
  selectedKind: RouteAttemptKind;
}

export interface RouteAbortPayload {
  receiverSessionId: string;
  attemptId: string;
  reason: 'lost_race' | 'session_closed' | 'winner_selected';
}

export type P2PMessageMap = {
  METADATA: FileMetadata;
  METADATA_CHUNK: MetadataChunkPayload;
  FILE_START: FileStartPayload;
  FILE_CHUNK: ChunkPayload;
  FILE_COMPLETE: FileCompletePayload;
  ALL_FILES_COMPLETE: undefined;
  ALL_FILES_RECEIVED: undefined;
  TRANSFER_PROGRESS: TransferProgressPayload;
  ACCEPT_TRANSFER: AcceptTransferPayload;
  REJECT_TRANSFER: RejectTransferPayload;
  RESUME_REQUEST: ResumePayload;
  TRANSFER_CANCELLED: TransferCancelledPayload;
  DEVICE_INFO: DeviceInfoPayload;
  HEARTBEAT: HeartbeatPayload;
  ROUTE_PROBE: RouteProbePayload;
  ROUTE_READY: RouteReadyPayload;
  ROUTE_COMMIT: RouteCommitPayload;
  ROUTE_ABORT: RouteAbortPayload;
};

export type P2PMessage = {
  [K in keyof P2PMessageMap]:
    P2PMessageMap[K] extends undefined
      ? { type: K; payload?: undefined }
      : { type: K; payload: P2PMessageMap[K] }
}[keyof P2PMessageMap];

export type NormalizedTransferMessage =
  | { type: 'FILE_REQUEST'; payload: NormalizedFileRequest }
  | P2PMessage;

export type TypedP2PMessage<T extends keyof P2PMessageMap> =
  P2PMessageMap[T] extends undefined
    ? { type: T; payload?: undefined }
    : { type: T; payload: P2PMessageMap[T] };

export const createP2PMessage = <T extends keyof P2PMessageMap>(
  type: T,
  ...payload: P2PMessageMap[T] extends undefined ? [] : [P2PMessageMap[T]]
): TypedP2PMessage<T> => {
  if (payload.length === 0) {
    return { type } as TypedP2PMessage<T>;
  }
  return { type, payload: payload[0] } as TypedP2PMessage<T>;
}

export interface AeroFile {
  file: File;
  metadata: FileMetadata;
}

export interface AppNotification {
  id: string;
  message: string;
  type: 'success' | 'info' | 'error';
  timestamp: number;
}

export interface User {
  id: string;
  email: string;
  name?: string;
}



declare global {
  interface File {
    fullPath?: string;
  }

  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }

  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: {
      description?: string;
      accept: Record<string, string[]>;
    }[];
    excludeAcceptAllOption?: boolean;
  }

  interface FileSystemFileHandle {
    readonly kind: 'file';
    readonly name: string;
    createWritable(options?: any): Promise<FileSystemWritableFileStream>;
    getFile(): Promise<File>;
  }

  interface FileSystemDirectoryHandle {
    readonly kind: 'directory';
    readonly name: string;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  }

  interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string | Uint8Array): Promise<void>;
    seek(position: number): Promise<void>;
    truncate(size: number): Promise<void>;
    close(): Promise<void>;
  }

  
  interface FileSystemEntry {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly name: string;
    readonly fullPath: string;
    readonly filesystem: FileSystem;
  }

  interface FileSystemFileEntry extends FileSystemEntry {
    file(successCallback: (file: File) => void, errorCallback?: (error: any) => void): void;
  }

  interface FileSystemDirectoryEntry extends FileSystemEntry {
    createReader(): FileSystemDirectoryReader;
  }

  interface FileSystemDirectoryReader {
    readEntries(successCallback: (entries: FileSystemEntry[]) => void, errorCallback?: (error: any) => void): void;
  }

  interface BeforeInstallPromptEvent extends Event {
    readonly platforms: string[];
    readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
    prompt(): Promise<void>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }

  interface Navigator {
    standalone?: boolean;
  }
}

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

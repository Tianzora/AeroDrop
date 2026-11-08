import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TransferState, type FileMetadata } from '../../types';
import { ReceiverUI } from './ReceiverUI.tsx';

const singleFileMetadata: FileMetadata = {
  files: [{ name: 'setup.exe', size: 1024, type: 'application/x-msdownload', lastModified: 0 }],
  totalSize: 1024,
};

const baseProps: React.ComponentProps<typeof ReceiverUI> = {
  state: TransferState.PEER_CONNECTED,
  code: '',
  codeStatus: 'idle' as const,
  inputRef: { current: null },
  isMobileDevice: false,
  onCodeChange: () => {},
  onDigitClick: () => {},
  onPasteFromClipboard: () => {},
  onBackspace: () => {},
  onClear: () => {},
  connectingStage: '',
  reconnectAttempt: 0,
  onReset: () => {},
  metadata: singleFileMetadata,
  senderDeviceName: 'Windows',
  isMultiFile: false,
  selectedFiles: [{ name: 'setup.exe', size: 1024, fileType: 'executable' as const }],
  showFileList: false,
  onToggleFileList: () => {},
  primaryFileName: 'setup.exe',
  primaryFileType: 'executable' as const,
  canResume: false,
  isStreaming: false,
  onResumeTransfer: () => {},
  onAcceptTransfer: () => {},
  progress: 0,
  downloadSpeed: '0 KB/s',
  eta: '--',
  overallTransferredBytes: 0,
  totalBytes: 1024,
  overallEta: '--',
  errorMsg: '',
  onRetry: () => {},
};

test('renders the semantic icon for single-file receiver cards', () => {
  const html = renderToStaticMarkup(React.createElement(ReceiverUI, baseProps));
  assert.match(html, /lucide-file-cog/);
});

test('keeps the grouped multi-file icon for bundle cards', () => {
  const html = renderToStaticMarkup(
    React.createElement(ReceiverUI, {
      ...baseProps,
      isMultiFile: true,
      primaryFileType: 'executable' as const,
      metadata: {
        files: [
          { name: 'setup.exe', size: 1024, type: 'application/x-msdownload', lastModified: 0 },
          { name: 'notes.txt', size: 512, type: 'text/plain', lastModified: 0 },
        ],
        totalSize: 1536,
      },
    })
  );

  assert.match(html, /lucide-layers/);
  assert.doesNotMatch(html, /lucide-file-cog/);
});

test('shows a multi-file list toggle and expanded file rows when requested', () => {
  const html = renderToStaticMarkup(
    React.createElement(ReceiverUI, {
      ...baseProps,
      isMultiFile: true,
      showFileList: true,
      metadata: {
        files: [
          { name: 'setup.exe', size: 1024, type: 'application/x-msdownload', lastModified: 0 },
          { name: 'notes.txt', size: 512, type: 'text/plain', lastModified: 0 },
        ],
        totalSize: 1536,
      },
      selectedFiles: [
        { name: 'setup.exe', size: 1024, fileType: 'executable' as const },
        { name: 'notes.txt', size: 512, fileType: 'document' as const },
      ],
    })
  );

  assert.match(html, /文件列表 \(2\)/);
  assert.match(html, /setup\.exe/);
  assert.match(html, /notes\.txt/);
  assert.match(html, /lucide-file-cog/);
  assert.match(html, /lucide-file-text/);
});

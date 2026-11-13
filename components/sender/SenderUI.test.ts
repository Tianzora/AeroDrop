import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TransferState, type FileMetadata } from '../../types';
import { SenderUI } from './SenderUI.tsx';

const metadata: FileMetadata = {
  files: [
    { name: 'report.pdf', size: 1024, type: 'application/pdf', lastModified: 0 },
    { name: 'archive.zip', size: 2048, type: 'application/zip', lastModified: 0 },
  ],
  totalSize: 3072,
};

const baseProps = {
  state: TransferState.CONFIGURING,
  isDragOver: false,
  handleFileSelect: () => {},
  handleFolderSelect: () => {},
  metadata,
  showFileList: true,
  onToggleFileList: () => {},
  stopSharing: () => {},
  selectedFiles: [
    { name: 'report.pdf', size: 1024, fileType: 'document' as const },
    { name: 'archive.zip', size: 2048, fileType: 'archive' as const },
  ],
  expiryOption: '1h',
  setExpiryOption: () => {},
  customCodeInput: '',
  setCustomCodeInput: () => {},
  errorMsg: '',
  startSharing: () => {},
  preparingStage: 'fetching_ice' as const,
  handleCopyCode: () => {},
  copied: false,
  transferCode: '',
  linkCopied: false,
  shareLink: '',
  handleCopyLink: () => {},
  remainingTime: '',
  shareRevokedMessage: null,
  connectionStatus: '',
  individualStats: [],
  totalProgress: 0,
  activeTransfersCount: 0,
  currentFileIndex: 0,
  fileList: [],
  totalBytes: 0,
  transferredBytes: 0,
  overallEta: '--',
  activeConnectionsCount: 0,
  currentSpeedBytes: 0,
  avgSpeedBytes: 0,
};

test('shows the selected single file summary with icon, name, and size', () => {
  const singleFileMetadata: FileMetadata = {
    files: [{ name: 'report.pdf', size: 1024, type: 'application/pdf', lastModified: 0 }],
    totalSize: 1024,
  };

  const html = renderToStaticMarkup(
    React.createElement(SenderUI, {
      ...baseProps,
      metadata: singleFileMetadata,
      selectedFiles: [{ name: 'report.pdf', size: 1024, fileType: 'document' as const }],
      showFileList: false,
    })
  );

  assert.match(html, /report\.pdf/);
  assert.match(html, /lucide-file-text/);
  assert.doesNotMatch(html, /已选择 1 个文件/);
});

test('renders semantic file type icons in expanded sender file list', () => {
  const html = renderToStaticMarkup(React.createElement(SenderUI, baseProps));
  assert.match(html, /lucide-file-text/);
  assert.match(html, /lucide-archive/);
});

test('口令被注销后：有效期显示已失效、复制被禁、主按钮改成重新创建', () => {
  const html = renderToStaticMarkup(
    React.createElement(SenderUI, {
      ...baseProps,
      state: TransferState.WAITING_FOR_PEER,
      transferCode: '123456',
      shareLink: 'https://example.com/?code=123456',
      remainingTime: '09:58',
      shareRevokedMessage: '分享已失效，进行中的传输不受影响，新设备无法加入',
    })
  );

  assert.match(html, /进行中的传输不受影响/);
  assert.match(html, /重新创建分享/);
  // 30 秒提示会过期，但这条状态不会：有效期一栏必须一直显示已失效。
  assert.match(html, />已失效</);
  assert.doesNotMatch(html, /复制分享口令/);
});

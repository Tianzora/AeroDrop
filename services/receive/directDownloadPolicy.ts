import { RECEIVE_STORAGE } from '../../constants/transfer';

export type DirectDownloadFallbackReason =
  | 'unsupported-environment'
  | 'multi-file'
  | 'too-large'
  | null;

export interface DirectDownloadPolicyInput {
  fileCount: number;
  totalBytes: number;
  isIOS: boolean;
  isSafari: boolean;
  supportsSaveFilePicker: boolean;
  maxBytes?: number;
}

export interface DirectDownloadPolicy {
  useDirectDownload: boolean;
  fallbackReason: DirectDownloadFallbackReason;
}

/**
 * 自动判定本次接收是否走「不弹保存框」的直下路径，不依赖任何用户设置。
 *
 * 只对单文件生效，且只针对会用原生保存框拦一道的桌面 Chromium 系浏览器。
 * 判定为直下时文件先完整落到内存/IDB，再由 <a download> 落到浏览器默认下载目录；
 * 超过阈值不动这份优化，继续走原生流式写入（零内存、刷新后可续传）——直下必须先
 * 缓冲完整文件，大文件既费内存也无法断点续写。
 *
 * 不适用、保持原路径的场景：
 * - 多文件：一次目录授权即可按原结构直写、零内存、可续传；打包成 zip 反而多一步解压。
 * - iOS/Safari：下载必须经过系统保存面板，无法静默。
 * - 无 File System Access API 的浏览器（如 Firefox）：本来就通过 streamsaver 静默下载。
 */
export const resolveDirectDownloadPolicy = (
  input: DirectDownloadPolicyInput
): DirectDownloadPolicy => {
  if (input.isIOS || input.isSafari || !input.supportsSaveFilePicker || input.fileCount < 1) {
    return { useDirectDownload: false, fallbackReason: 'unsupported-environment' };
  }

  if (input.fileCount > 1) {
    return { useDirectDownload: false, fallbackReason: 'multi-file' };
  }

  const maxBytes = input.maxBytes ?? RECEIVE_STORAGE.DIRECT_DOWNLOAD_MAX_BYTES;
  if (!Number.isFinite(input.totalBytes) || input.totalBytes > maxBytes) {
    return { useDirectDownload: false, fallbackReason: 'too-large' };
  }

  return { useDirectDownload: true, fallbackReason: null };
};

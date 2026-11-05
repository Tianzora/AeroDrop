export type ReceiveSaveMode =
  | 'directory-direct'
  | 'archive-export'
  | 'per-file-save-queue';

export interface ReceiveSaveCapabilityInput {
  fileCount: number;
  isChromium: boolean;
  isIOS: boolean;
  isMobileDevice: boolean;
  isSafari: boolean;
  supportsArchiveExport: boolean;
  supportsDirectoryPicker: boolean;
}

export interface ReceiveSaveCapabilityResolution {
  isMultiFileTransfer: boolean;
  selectedMode: ReceiveSaveMode;
  orderedModes: ReceiveSaveMode[];
  shouldPromptForDirectory: boolean;
  capabilities: {
    canUseDirectoryDirect: boolean;
    canUseArchiveExport: boolean;
    canUsePerFileSaveQueue: boolean;
  };
  reasons: string[];
}

const canUseDirectoryDirect = (input: ReceiveSaveCapabilityInput): boolean =>
  input.fileCount > 1 &&
  input.isChromium &&
  !input.isIOS &&
  !input.isSafari &&
  !input.isMobileDevice &&
  input.supportsDirectoryPicker;

const canUseArchiveExport = (input: ReceiveSaveCapabilityInput): boolean =>
  input.fileCount > 1 && input.supportsArchiveExport;

export const resolveReceiveSaveCapability = (
  input: ReceiveSaveCapabilityInput
): ReceiveSaveCapabilityResolution => {
  const isMultiFileTransfer = input.fileCount > 1;
  const directoryDirect = canUseDirectoryDirect(input);
  const archiveExport = canUseArchiveExport(input);
  const orderedModes: ReceiveSaveMode[] = [];
  const reasons: string[] = [];

  if (directoryDirect) {
    orderedModes.push('directory-direct');
    reasons.push('directory-direct supported on desktop Chromium with directory picker');
  } else if (isMultiFileTransfer) {
    reasons.push('directory-direct unavailable for this browser/device combination');
  } else {
    reasons.push('single-file transfers stay on the existing receive-save flow');
  }

  if (archiveExport) {
    orderedModes.push('archive-export');
    reasons.push('archive export available for staged multi-file fallback');
  } else if (isMultiFileTransfer) {
    reasons.push('archive export unavailable; using per-file save queue fallback');
  }

  orderedModes.push('per-file-save-queue');

  return {
    isMultiFileTransfer,
    selectedMode: orderedModes[0],
    orderedModes,
    shouldPromptForDirectory: orderedModes[0] === 'directory-direct',
    capabilities: {
      canUseDirectoryDirect: directoryDirect,
      canUseArchiveExport: archiveExport,
      canUsePerFileSaveQueue: true,
    },
    reasons,
  };
};

/**
 * 组件侧的薄封装：把“浏览器/设备判定”交给调用方，避免这里硬编码 isMobileDevice: false
 * 把 canUseDirectoryDirect 的移动端拦截静默关掉。
 */
export const resolveMultiFileSaveMode = (input: {
  fileCount: number;
  isIOS: boolean;
  isSafari: boolean;
  supportsDirectoryPicker: boolean;
  supportsArchiveExport: boolean;
  isMobileDevice?: boolean;
  isChromium?: boolean;
}) => {
  const resolution = resolveReceiveSaveCapability({
    fileCount: input.fileCount,
    isChromium: input.isChromium ?? (!input.isIOS && !input.isSafari),
    isIOS: input.isIOS,
    isMobileDevice: input.isMobileDevice ?? false,
    isSafari: input.isSafari,
    supportsArchiveExport: input.supportsArchiveExport,
    supportsDirectoryPicker: input.supportsDirectoryPicker,
  });

  return {
    mode: resolution.selectedMode,
    supportsDirectoryDirect: resolution.capabilities.canUseDirectoryDirect,
    supportsArchiveExport: resolution.capabilities.canUseArchiveExport,
    shouldPromptForDirectory: resolution.shouldPromptForDirectory,
    reasons: resolution.reasons,
  };
};

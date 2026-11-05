/**
 * 刷新/重连后按检查点续传时，恢复「检查点文件之前那些已完成的文件」。
 *
 * 为什么需要单独抽出来：刷新后内存里的完成集合是空的，但发送端的信用窗口基线
 * （前面所有文件大小之和 + 当前文件偏移）仍按全部进度计算。不补回这些索引，
 * 接收端上报的进度永远比发送端的基线少一大截，信用窗口补不满，传输卡死；
 * 收尾时落盘数量也会不足而被判失败。
 */
export type RestoreCompletedFilesInput = {
  /** 检查点指向的文件索引；前面 0..fileIndex-1 视为已完成。 */
  checkpointFileIndex: number;
  /** 本次传输的元数据文件列表（只用 size）。 */
  files: readonly { size: number }[];
  /** 标记单个文件已完成并（可选）已直接落盘。 */
  markCompleted: (fileIndex: number, size: number, directSaved: boolean) => void;
};

export type RestoreCompletedFilesOptions = {
  directSaved?: boolean;
};

/**
 * 返回被补记的索引（测试与日志用）。越界索引会被忽略，单条失败不影响其余文件。
 */
export const restoreCompletedFilesForResume = (
  input: RestoreCompletedFilesInput,
  options: RestoreCompletedFilesOptions = {},
): number[] => {
  const limit = Math.min(
    Math.max(0, Math.floor(input.checkpointFileIndex)),
    input.files.length,
  );
  const restored: number[] = [];

  for (let fileIndex = 0; fileIndex < limit; fileIndex += 1) {
    const size = input.files[fileIndex]?.size ?? 0;
    try {
      input.markCompleted(fileIndex, size, options.directSaved === true);
      restored.push(fileIndex);
    } catch {
      // 补记失败不能阻止续传本身。
    }
  }

  return restored;
};

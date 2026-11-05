import { normalizeRelativePath } from './relativePath.ts';

export type VerifyCompletedFilesInput = {
  /** 检查点指向的文件索引；只校验它之前那批文件。 */
  checkpointFileIndex: number;
  files: readonly { name: string; size: number }[];
  /** 判断某个相对路径是否真的存在于目标目录，且大小一致。 */
  fileExists: (relativePath: string, expectedSize: number) => Promise<boolean>;
};

/**
 * 续传前确认「检查点之前的那些文件真的还在目标目录里」。
 *
 * 只有目录句柄没变、权限还在时才能直接沿用这些文件；如果用户被迫重新选了一个空目录，
 * 把它们当已完成会让发送端跳过这些文件，最后「成功」完成却少了文件。
 * 返回从 0 开始连续存在的前缀长度：调用方只应把这段当成已完成，其余从头重传。
 */
export const countVerifiedCompletedFiles = async (
  input: VerifyCompletedFilesInput
): Promise<number> => {
  const limit = Math.min(Math.max(0, Math.floor(input.checkpointFileIndex)), input.files.length);
  let verified = 0;

  for (let fileIndex = 0; fileIndex < limit; fileIndex += 1) {
    const file = input.files[fileIndex];
    if (!file) break;
    let relativePath: string;
    try {
      relativePath = normalizeRelativePath(file.name);
    } catch {
      break;
    }
    const exists = await input.fileExists(relativePath, file.size).catch(() => false);
    if (!exists) break;
    verified += 1;
  }

  return verified;
};

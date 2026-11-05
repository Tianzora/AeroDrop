import { crc32FinalHex, crc32Init, crc32Update } from '../hashUtils';

export type PrefixIntegrityVerdict = 'match' | 'mismatch' | 'skipped' | 'unreadable';

export interface VerifyPersistedPrefixInput {
  /** 已落盘前缀长度（= 续传偏移）。 */
  prefixLength: number;
  /** 发送端给出的前缀 CRC32（8 位十六进制）。 */
  expectedCrc32: string;
  /** 读取磁盘上 [offset, end) 的字节；读不到返回 null。 */
  readRange: (offset: number, end: number) => Promise<Uint8Array | null>;
  /** 超过该长度直接跳过校验，避免续传前扫几十 GB。 */
  maxVerifyBytes?: number;
  chunkSize?: number;
}

export const DEFAULT_MAX_PREFIX_VERIFY_BYTES = 256 * 1024 * 1024;

export const verifyPersistedPrefix = async (
  input: VerifyPersistedPrefixInput
): Promise<PrefixIntegrityVerdict> => {
  const limit = Math.floor(input.prefixLength);
  if (!Number.isFinite(limit) || limit <= 0) {
    return 'skipped';
  }

  if (limit > (input.maxVerifyBytes ?? DEFAULT_MAX_PREFIX_VERIFY_BYTES)) {
    return 'skipped';
  }

  const expected = (input.expectedCrc32 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(expected)) {
    return 'skipped';
  }

  const step = Math.max(1, Math.floor(input.chunkSize ?? 1024 * 1024));
  let state = crc32Init();

  for (let offset = 0; offset < limit; offset += step) {
    const end = Math.min(offset + step, limit);
    const bytes = await input.readRange(offset, end);
    if (!bytes) {
      // 读不到（句柄失效 / 权限不足）不代表数据损坏，调用方应按“未验证”处理。
      return 'unreadable';
    }
    if (bytes.byteLength !== end - offset) {
      return 'mismatch';
    }
    state = crc32Update(state, bytes);
  }

  return crc32FinalHex(state) === expected ? 'match' : 'mismatch';
};

import { crc32FinalHex, crc32Init, crc32Update } from '../hashUtils';

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value));
};

interface SliceLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface FileLike {
  size: number;
  slice(start: number, end: number): SliceLike;
}

const readSlice = async (file: FileLike, start: number, end: number): Promise<Uint8Array> => {
  const slice = file.slice(start, end);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
};

/** 超过该长度的前缀不再计算 CRC（续传前扫几十 GB 不划算）。 */
export const DEFAULT_MAX_PREFIX_CRC_BYTES = 256 * 1024 * 1024;

export const computePrefixCrc32 = async (
  file: FileLike,
  length: number,
  chunkSize = 1024 * 1024
): Promise<string> => {
  const limit = Math.max(0, Math.min(Math.floor(length), Math.max(0, file.size)));
  const step = Math.max(1, Math.floor(chunkSize));
  let state = crc32Init();

  for (let offset = 0; offset < limit; offset += step) {
    const end = Math.min(offset + step, limit);
    const bytes = await readSlice(file, offset, end);
    state = crc32Update(state, toBytes(bytes));
  }

  return crc32FinalHex(state);
};

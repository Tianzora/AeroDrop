/**
 * 分片 METADATA 的重组状态机（从 Receiver 组件里抽出来，便于单测与复用）。
 *
 * 发送端在 metadata 的序列化结果超过 METADATA_CHUNKING.MAX_MESSAGE_BYTES 时会拆成
 * 多条 METADATA_CHUNK；接收端必须按 transferId 聚成一组、按 index 回填、忽略重复，
 * 收齐后拼回原始 JSON（解析交给调用方，便于给出更具体的错误文案）。
 */
export type MetadataChunkInput = {
  transferId: string;
  index: number;
  total: number;
  data: string;
};

export type MetadataChunkResult =
  | { status: 'pending'; received: number; total: number }
  | { status: 'complete'; json: string }
  | { status: 'invalid'; reason: 'malformed' | 'incomplete' };

export interface MetadataChunkAssembler {
  push: (chunk: Partial<MetadataChunkInput> | null | undefined) => MetadataChunkResult;
  reset: () => void;
  getState: () => { transferId: string | null; received: number; total: number };
}

type Buffer = {
  transferId: string;
  total: number;
  received: number;
  chunks: Map<number, string>;
};

const isChunkIndex = (value: unknown, total: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < total;

export const createMetadataChunkAssembler = (): MetadataChunkAssembler => {
  let buffer: Buffer | null = null;

  const reset = () => {
    buffer = null;
  };

  return {
    reset,
    getState: () => ({
      transferId: buffer?.transferId ?? null,
      received: buffer?.received ?? 0,
      total: buffer?.total ?? 0,
    }),
    push: (chunk) => {
      const transferId = typeof chunk?.transferId === 'string' ? chunk.transferId : '';
      const total = Number.isInteger(chunk?.total) ? (chunk?.total as number) : -1;
      const data = typeof chunk?.data === 'string' ? chunk.data : null;

      if (!transferId || total <= 0 || !isChunkIndex(chunk?.index, total) || data === null) {
        reset();
        return { status: 'invalid', reason: 'malformed' };
      }

      const index = chunk!.index as number;
      if (!buffer || buffer.transferId !== transferId || buffer.total !== total) {
        buffer = { transferId, total, received: 0, chunks: new Map() };
      }

      const active = buffer as Buffer;
      if (!active.chunks.has(index)) {
        active.chunks.set(index, data);
        active.received += 1;
      }

      if (active.received < active.total) {
        return { status: 'pending', received: active.received, total: active.total };
      }

      const parts: string[] = [];
      for (let cursor = 0; cursor < active.total; cursor += 1) {
        const part = active.chunks.get(cursor);
        if (typeof part !== 'string') {
          reset();
          return { status: 'invalid', reason: 'incomplete' };
        }
        parts.push(part);
      }

      reset();
      return { status: 'complete', json: parts.join('') };
    },
  };
};

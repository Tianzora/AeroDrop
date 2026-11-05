// 这是 module worker（见 crc32WorkerClient 的 `new Worker(..., { type: 'module' })`），
// 直接复用主线程同一份 CRC32 实现，避免两边各留一份表、改一处漏一处。
import { crc32FinalHex, crc32Init, crc32Update } from './hashUtils';

type Crc32WorkerRequest =
  | { type: 'reset'; requestId: number }
  | { type: 'update'; buffer: ArrayBuffer }
  | { type: 'finalize'; requestId: number };

type Crc32WorkerResponse =
  | { type: 'reset_ack'; requestId: number }
  | { type: 'finalize_result'; requestId: number; hashHex: string }
  | { type: 'error'; requestId?: number; message: string };

let state = crc32Init();

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Crc32WorkerRequest>) => void) | null;
  postMessage: (message: Crc32WorkerResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<Crc32WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'reset') {
      state = crc32Init();
      const response: Crc32WorkerResponse = { type: 'reset_ack', requestId: msg.requestId };
      workerScope.postMessage(response);
      return;
    }

    if (msg.type === 'update') {
      if (msg.buffer.byteLength > 0) {
        state = crc32Update(state, new Uint8Array(msg.buffer));
      }
      return;
    }

    if (msg.type === 'finalize') {
      const response: Crc32WorkerResponse = {
        type: 'finalize_result',
        requestId: msg.requestId,
        hashHex: crc32FinalHex(state),
      };
      workerScope.postMessage(response);
    }
  } catch (err) {
    const response: Crc32WorkerResponse = {
      type: 'error',
      requestId: (msg as any)?.requestId,
      message: err instanceof Error ? err.message : 'CRC32 worker failed',
    };
    workerScope.postMessage(response);
  }
};

export {};

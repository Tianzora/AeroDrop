// /api/share-code 的请求体读取：先看 Content-Length，再边读边限。
//
// 从 worker.ts 抽出来以便 node:test 覆盖（分块上传 / 无 body / 非法 JSON 都需要
// 失败场景断言；这些路径直接决定 Worker 内存会不会被超大 body 吃掉）。

import { SHARE_CODE_MAX_BODY_BYTES } from '../shareCodeRegistry';

export type ShareCodeBodyResult =
  | { ok: true; tooLarge: false; value: unknown }
  | { ok: false; tooLarge: boolean };

export const readShareCodeBody = async (request: Request): Promise<ShareCodeBodyResult> => {
  const contentLength = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > SHARE_CODE_MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }

  // 没有 Content-Length 的分块上传也必须边读边限：先 request.text() 再判断长度
  // 等于让调用方用超大 body 吃掉 Worker 内存。
  if (!request.body) {
    return { ok: false, tooLarge: false };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > SHARE_CODE_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
};

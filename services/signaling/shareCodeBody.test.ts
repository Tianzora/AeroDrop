import test from 'node:test';
import assert from 'node:assert/strict';

import { readShareCodeBody } from './shareCodeBody.ts';
import { SHARE_CODE_MAX_BODY_BYTES } from '../shareCodeRegistry.ts';

const post = (body: BodyInit | null, headers: HeadersInit = {}): Request =>
  new Request('https://drop.example/api/share-code', { method: 'POST', body, headers });

test('parses a valid JSON object body', async () => {
  const result = await readShareCodeBody(post(JSON.stringify({ peerId: 'peer-abc' })));
  assert.deepEqual(result, { ok: true, tooLarge: false, value: { peerId: 'peer-abc' } });
});

test('rejects a declared Content-Length over the limit before reading', async () => {
  const result = await readShareCodeBody(
    post('{}', { 'Content-Length': String(SHARE_CODE_MAX_BODY_BYTES + 1) })
  );
  assert.deepEqual(result, { ok: false, tooLarge: true });
});

test('rejects a chunked body that crosses the limit mid-stream', async () => {
  const chunk = 'x'.repeat(SHARE_CODE_MAX_BODY_BYTES);
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1;
      if (sent > 2) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await readShareCodeBody(
    new Request('https://drop.example/api/share-code', {
      method: 'POST',
      body: stream,
      // 有双工要求时 Node 的 Request 需要显式声明；这里只测读取路径。
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
  );

  assert.deepEqual(result, { ok: false, tooLarge: true });
  assert.equal(cancelled, true, '超过上限的流必须被取消，不能继续读进内存');
});

test('reports an absent body and invalid JSON as failures, not as empty objects', async () => {
  assert.deepEqual(await readShareCodeBody(post(null)), { ok: false, tooLarge: false });
  assert.deepEqual(await readShareCodeBody(post('not json')), { ok: false, tooLarge: false });
  // 非对象 JSON 由调用方的 validateShareCodeCreatePayload 负责；这里只保证解析成功。
  assert.deepEqual(await readShareCodeBody(post('[1,2,3]')), { ok: true, tooLarge: false, value: [1, 2, 3] });
});

import { expect, test } from '@playwright/test';

const FILE_BYTES = 2 * 1024 * 1024;
const SHARE_CODE = '764200';

type ProductIceConfig = {
  iceServers: RTCIceServer[];
  secure: boolean;
  iceCandidatePoolSize: number;
  iceTransportPolicy: RTCIceTransportPolicy;
  hasTurn: boolean;
  relayRecommended: boolean;
  relayReason: 'network' | null;
  fetchLatencyMs: number;
};

type IceRouteEvidence = {
  localCandidateType?: string;
  remoteCandidateType?: string;
  pathType?: string;
  protocol?: string;
};

const getProductIceConfig = (): ProductIceConfig => {
  const url = process.env.AERODROP_TURN_URL;
  const username = process.env.AERODROP_TURN_USERNAME;
  const credential = process.env.AERODROP_TURN_CREDENTIAL;
  const configuredValues = [url, username, credential].filter(Boolean).length;
  if (configuredValues > 0 && configuredValues < 3) {
    throw new Error('AERODROP_TURN_URL/USERNAME/CREDENTIAL must be configured together');
  }

  const hasTurn = configuredValues === 3;
  return {
    iceServers: hasTurn ? [{ urls: url!, username: username!, credential: credential! }] : [],
    secure: true,
    iceCandidatePoolSize: 1,
    iceTransportPolicy: 'all',
    hasTurn,
    relayRecommended: hasTurn,
    relayReason: hasTurn ? 'network' : null,
    fetchLatencyMs: 0,
  };
};

const createPayload = () => {
  const bytes = Buffer.allocUnsafe(FILE_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 1) {
    bytes[offset] = (offset * 31 + (offset >>> 8) + 17) & 0xff;
  }
  return bytes;
};

test('production Sender and Receiver transfer and persist a 2 MiB file', async ({ browser }) => {
  const iceConfig = getProductIceConfig();
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();

  // Only `--mode e2e` builds honor `__AERODROP_E2E__` (see services/e2eHooks.ts).
  // This spec targets the production bundle served by wrangler, so the override is
  // inert here and the app uses the worker-issued ICE config; the byte-level
  // assertions below rely on `__AERODROP_PRODUCT_SINK__` instead.
  await Promise.all([senderContext, receiverContext].map((context) => context.addInitScript((config) => {
    (window as Window & { __AERODROP_E2E__?: unknown }).__AERODROP_E2E__ = {
      getIceConfigOverride: () => config,
    };
  }, iceConfig)));

  await receiverContext.addInitScript(() => {
    type Sink = {
      chunks: Uint8Array[];
      size: number;
      closed: boolean;
    };

    const sink: Sink = { chunks: [], size: 0, closed: false };
    const sinkWindow = window as Window & { __AERODROP_PRODUCT_SINK__?: Sink };
    sinkWindow.__AERODROP_PRODUCT_SINK__ = sink;

    const handle = {
      kind: 'file' as const,
      name: 'aerodrop-product-2m.bin',
      createWritable: async () => ({
        write: async (value: ArrayBuffer | ArrayBufferView) => {
          const bytes = ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          sink.chunks.push(copy);
          sink.size += copy.byteLength;
        },
        close: async () => {
          sink.closed = true;
        },
        seek: async () => {},
        truncate: async () => {},
      }),
      getFile: async () => new File(sink.chunks, 'aerodrop-product-2m.bin'),
    };

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => handle,
    });
  });

  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    await Promise.all([sender.goto('/'), receiver.goto('/')]);

    const payload = createPayload();
    await sender.locator('#file-upload').setInputFiles({
      name: 'aerodrop-product-2m.bin',
      mimeType: 'application/octet-stream',
      buffer: payload,
    });
    await sender.locator('input[type="text"][inputmode="numeric"]').fill(SHARE_CODE);
    await sender.getByRole('button', { name: '创建分享' }).click();
    await expect(sender.getByText(SHARE_CODE, { exact: true })).toBeVisible();

    await receiver.getByRole('button', { name: '接收' }).click();
    await receiver.locator('input[type="text"]').fill(SHARE_CODE);
    const accept = receiver.getByRole('button', { name: /确认并下载|继续下载/ });
    await expect(accept).toBeVisible({ timeout: 15_000 });

    const startedAt = Date.now();
    await accept.click();
    await receiver.waitForFunction(
      (expectedBytes) => {
        const sink = (window as Window & {
          __AERODROP_PRODUCT_SINK__?: { size: number; closed: boolean };
        }).__AERODROP_PRODUCT_SINK__;
        return sink?.closed === true && sink.size === expectedBytes;
      },
      FILE_BYTES,
      { timeout: 30_000 },
    );

    const result = await receiver.evaluate(() => {
      const sink = (window as Window & {
        __AERODROP_PRODUCT_SINK__?: { chunks: Uint8Array[]; size: number };
      }).__AERODROP_PRODUCT_SINK__;
      if (!sink) throw new Error('Product transfer sink is unavailable');

      let offset = 0;
      for (const chunk of sink.chunks) {
        for (let index = 0; index < chunk.byteLength; index += 1) {
          const expected = (offset * 31 + (offset >>> 8) + 17) & 0xff;
          if (chunk[index] !== expected) {
            return { size: sink.size, mismatchOffset: offset };
          }
          offset += 1;
        }
      }
      return { size: sink.size, mismatchOffset: -1 };
    });

    const elapsedMs = Date.now() - startedAt;
    console.log(`AeroDrop product 2 MiB: ${elapsedMs}ms`);
    expect(result).toEqual({ size: FILE_BYTES, mismatchOffset: -1 });
    await expect(sender.getByText('文件发送完成！')).toBeVisible({ timeout: 5_000 });

    await receiver.waitForFunction(() => {
      const metrics = (window as Window & { __AERODROP_CONN_METRICS__?: Array<{ event?: string }> })
        .__AERODROP_CONN_METRICS__;
      return metrics?.some((entry) => entry.event === 'ice_route') === true;
    }, undefined, { timeout: 10_000 });
    const route = await receiver.evaluate(() => {
      const metrics = (window as Window & {
        __AERODROP_CONN_METRICS__?: Array<{ event?: string; data?: IceRouteEvidence }>;
      }).__AERODROP_CONN_METRICS__ ?? [];
      return metrics.filter((entry) => entry.event === 'ice_route').at(-1)?.data ?? null;
    });

    expect(route).not.toBeNull();
    const directCandidateTypes = ['host', 'srflx', 'prflx'];
    expect(directCandidateTypes).toContain(route?.localCandidateType);
    expect(directCandidateTypes).toContain(route?.remoteCandidateType);
    expect(route?.localCandidateType).not.toBe('relay');
    expect(route?.remoteCandidateType).not.toBe('relay');
    expect(route?.pathType).not.toBe('TURN');

    if (iceConfig.hasTurn) {
      console.log(`AeroDrop P2P priority with TURN available: ${JSON.stringify(route)}`);
    } else {
      console.log(`AeroDrop P2P route: ${JSON.stringify(route)}; TURN-present fallback competition not covered (AERODROP_TURN_* unset)`);
    }
    expect(elapsedMs).toBeLessThanOrEqual(process.env.CI ? 15_000 : 5_000);
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
});

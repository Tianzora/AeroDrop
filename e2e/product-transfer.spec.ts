import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

const FILE_BYTES = 2 * 1024 * 1024;

// 分享口令绑定在 Worker 的 Durable Object 里，重启本地 preview 也不会清空，
// 固定口令会在第二次运行时命中 409；每次运行用一个新口令。
const createShareCode = () => String(Math.floor(100_000 + Math.random() * 900_000));

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

test('serves SEO metadata and keeps share links out of search', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  expect(await robots.text()).toContain('Sitemap: https://drop.tianzora.uno/sitemap.xml');

  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('xml');
  expect(await sitemap.text()).toContain('<loc>https://drop.tianzora.uno/</loc>');

  const ogImage = await request.get('/og.png');
  expect(ogImage.status()).toBe(200);
  expect(ogImage.headers()['content-type']).toContain('image/png');

  // 分享链接不能被收录：文件分享用 ?code=，屏幕共享用 ?view=。
  expect((await request.get('/?code=123456')).headers()['x-robots-tag']).toBe('noindex');
  expect((await request.get('/?view=abc')).headers()['x-robots-tag']).toBe('noindex');
  expect((await request.get('/')).headers()['x-robots-tag']).toBeUndefined();
});

test('production Sender and Receiver transfer and download a 2 MiB file', async ({ browser }) => {
  const iceConfig = getProductIceConfig();
  const shareCode = createShareCode();
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();

  // Only `--mode e2e` builds honor `__AERODROP_E2E__` (see services/e2eHooks.ts).
  // This spec targets the production bundle served by wrangler, so the override is
  // inert here and the app uses the worker-issued ICE config. The receiver downloads
  // straight to the browser download directory, so bytes are verified through
  // Playwright's download capture.
  await Promise.all([senderContext, receiverContext].map((context) => context.addInitScript((config) => {
    (window as Window & { __AERODROP_E2E__?: unknown }).__AERODROP_E2E__ = {
      getIceConfigOverride: () => config,
    };
  }, iceConfig)));

  // The receiver downloads straight to the browser download directory for in-limit
  // transfers (no save picker), so the file is verified through Playwright's download capture.

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
    await sender.locator('input[type="text"][inputmode="numeric"]').fill(shareCode);
    await sender.getByRole('button', { name: '创建分享' }).click();
    await expect(sender.getByText(shareCode, { exact: true })).toBeVisible();

    await receiver.getByRole('button', { name: '接收' }).click();
    await receiver.locator('input[type="text"]').fill(shareCode);
    const accept = receiver.getByRole('button', { name: /确认并下载|继续下载/ });
    await expect(accept).toBeVisible({ timeout: 15_000 });

    const downloadPromise = receiver.waitForEvent('download', { timeout: 30_000 });
    const startedAt = Date.now();
    await accept.click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Receiver download did not produce a file');
    const received = await readFile(downloadPath);

    const result = (() => {
      const length = Math.min(received.length, FILE_BYTES);
      for (let offset = 0; offset < length; offset += 1) {
        const expected = (offset * 31 + (offset >>> 8) + 17) & 0xff;
        if (received[offset] !== expected) {
          return { size: received.length, mismatchOffset: offset };
        }
      }
      return { size: received.length, mismatchOffset: received.length === FILE_BYTES ? -1 : length };
    })();

    const elapsedMs = Date.now() - startedAt;
    console.log(`AeroDrop product 2 MiB: ${elapsedMs}ms`);
    expect(download.suggestedFilename()).toBe('aerodrop-product-2m.bin');
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

test('defers a share-code revoke and resumes it within the grace window', async ({ request }) => {
  // Worker 的分享接口只接受同源请求；Playwright 的 request 上下文默认不带 Origin。
  const origin = process.env.AERODROP_BASE_URL ?? 'http://127.0.0.1:8787';
  const headers = { Origin: origin };
  const peerId = randomUUID();
  const secret = `secret-${randomUUID()}`;
  const secretHash = createHmac('sha256', secret).update(peerId).digest('hex');

  const create = await request.post('/api/share-code', {
    headers,
    data: { peerId, secretHash, ttlSeconds: 3600 },
  });
  expect(create.status()).toBe(200);
  const { code } = (await create.json()) as { code: string };

  expect((await request.get(`/api/share-code?code=${code}`, { headers })).status()).toBe(200);

  const deferred = await request.post(`/api/share-code/${code}/revoke`, {
    headers,
    data: { peerId, secretHash, graceMs: 5_000 },
  });
  expect(deferred.status()).toBe(200);
  const deferredBody = (await deferred.json()) as { revoked: boolean; deferredUntil: number };
  expect(deferredBody.revoked).toBe(false);
  expect(deferredBody.deferredUntil).toBeGreaterThan(Date.now());

  // 宽限期内页面只是切后台：码必须仍然可兑换，否则返回时 resume 已无从谈起。
  expect((await request.get(`/api/share-code?code=${code}`, { headers })).status()).toBe(200);

  const wrongHash = createHmac('sha256', `${secret}-wrong`).update(peerId).digest('hex');
  expect(
    (
      await request.post(`/api/share-code/${code}/resume`, {
        headers,
        data: { peerId, secretHash: wrongHash },
      })
    ).status()
  ).toBe(403);

  const resumed = await request.post(`/api/share-code/${code}/resume`, {
    headers,
    data: { peerId, secretHash },
  });
  expect(resumed.status()).toBe(200);
  expect(((await resumed.json()) as { resumed: boolean }).resumed).toBe(true);
  expect((await request.get(`/api/share-code?code=${code}`, { headers })).status()).toBe(200);

  const finalRevoke = await request.post(`/api/share-code/${code}/revoke`, {
    headers,
    data: { peerId, secretHash },
  });
  expect(finalRevoke.status()).toBe(200);
  expect(((await finalRevoke.json()) as { revoked: boolean }).revoked).toBe(true);
  expect((await request.get(`/api/share-code?code=${code}`, { headers })).status()).toBe(404);
});

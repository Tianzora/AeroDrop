import { expect, test, type Browser, type Page } from '@playwright/test';

const CHUNK_BYTES = 64 * 1024;
const TWO_MIB = 2 * 1024 * 1024;
const ONE_HUNDRED_MIB = 100 * 1024 * 1024;

type IceSettings = {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
};

type TransferResult = {
  bytes: number;
  crc32: number;
  elapsedMs: number;
  maxStallMs: number;
  maxChunkBytes: number;
  maxBufferedAmount: number;
};

type SelectedRoute = {
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  protocol: string | null;
  relayProtocol: string | null;
  url: string | null;
};

const TURN_MATRIX = [
  { label: 'TURN UDP', envName: 'AERODROP_TURN_UDP_URL', scheme: 'turn:', relayProtocol: 'udp' },
  { label: 'TURN TCP', envName: 'AERODROP_TURN_TCP_URL', scheme: 'turn:', relayProtocol: 'tcp' },
  { label: 'TURNS TLS', envName: 'AERODROP_TURNS_TLS_URL', scheme: 'turns:', relayProtocol: 'tls' },
] as const;

const installPeer = async (page: Page, role: 'sender' | 'receiver', settings: IceSettings) => {
  await page.evaluate(
    ({ role, settings }) => {
      type Harness = {
        pc: RTCPeerConnection;
        channel: RTCDataChannel | null;
        role: 'sender' | 'receiver';
        transferPromise: Promise<TransferResult> | null;
      };

      const harnessWindow = window as Window & { __rtcHarness?: Harness };
      const pc = new RTCPeerConnection(settings);
      const harness: Harness = {
        pc,
        channel: null,
        role,
        transferPromise: null,
      };

      const crcTable = new Uint32Array(256);
      for (let index = 0; index < crcTable.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        }
        crcTable[index] = value >>> 0;
      }

      const configureReceiver = (channel: RTCDataChannel) => {
        channel.binaryType = 'arraybuffer';
        harness.channel = channel;
        harness.transferPromise = new Promise<TransferResult>((resolve, reject) => {
          let expectedBytes = 0;
          let receivedBytes = 0;
          let crc = 0xffffffff;
          let startedAt = 0;
          let lastProgressAt = 0;
          let maxStallMs = 0;
          let maxChunkBytes = 0;

          channel.addEventListener('message', (event) => {
            try {
              if (typeof event.data === 'string') {
                const message = JSON.parse(event.data) as { type: string; bytes: number };
                if (message.type !== 'START' || !Number.isSafeInteger(message.bytes) || message.bytes <= 0) {
                  throw new Error('Invalid transfer metadata');
                }
                expectedBytes = message.bytes;
                startedAt = performance.now();
                lastProgressAt = startedAt;
                return;
              }

              if (!startedAt || !(event.data instanceof ArrayBuffer)) {
                throw new Error('Received binary data before transfer metadata');
              }

              const now = performance.now();
              maxStallMs = Math.max(maxStallMs, now - lastProgressAt);
              lastProgressAt = now;

              const bytes = new Uint8Array(event.data);
              maxChunkBytes = Math.max(maxChunkBytes, bytes.byteLength);
              for (let index = 0; index < bytes.byteLength; index += 1) {
                const absoluteOffset = receivedBytes + index;
                const expected = (absoluteOffset * 31 + (absoluteOffset >>> 8) + 17) & 0xff;
                if (bytes[index] !== expected) {
                  throw new Error(`Byte mismatch at offset ${absoluteOffset}`);
                }
                crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
              }
              receivedBytes += bytes.byteLength;

              if (receivedBytes === expectedBytes) {
                const result: TransferResult = {
                  bytes: receivedBytes,
                  crc32: (crc ^ 0xffffffff) >>> 0,
                  elapsedMs: performance.now() - startedAt,
                  maxStallMs,
                  maxChunkBytes,
                  maxBufferedAmount: 0,
                };
                channel.send(JSON.stringify({ type: 'DONE', result }));
                resolve(result);
              } else if (receivedBytes > expectedBytes) {
                throw new Error(`Received ${receivedBytes} bytes, expected ${expectedBytes}`);
              }
            } catch (error) {
              reject(error);
            }
          });
          channel.addEventListener('close', () => {
            if (receivedBytes !== expectedBytes) reject(new Error('Data channel closed before transfer completed'));
          });
          channel.addEventListener('error', () => reject(new Error('Receiver data channel failed')));
        });
      };

      if (role === 'sender') {
        const channel = pc.createDataChannel('aerodrop-rtc-throughput', { ordered: true });
        channel.binaryType = 'arraybuffer';
        harness.channel = channel;
      } else {
        pc.addEventListener('datachannel', (event) => configureReceiver(event.channel));
      }

      harnessWindow.__rtcHarness = harness;
    },
    { role, settings },
  );
};

const waitForIceGathering = async (page: Page) => {
  await page.evaluate(async () => {
    const pc = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc;
    if (!pc) throw new Error('RTC harness is not installed');
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const onChange = () => {
        if (pc.iceGatheringState !== 'complete') return;
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  });
};

const connectPeers = async (sender: Page, receiver: Page, settings: IceSettings) => {
  await Promise.all([
    installPeer(sender, 'sender', settings),
    installPeer(receiver, 'receiver', settings),
  ]);

  await sender.evaluate(async () => {
    const pc = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc;
    if (!pc) throw new Error('Sender harness is not installed');
    await pc.setLocalDescription(await pc.createOffer());
  });
  await waitForIceGathering(sender);
  const offer = await sender.evaluate(() => {
    const description = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc.localDescription;
    if (!description) throw new Error('Sender did not create an offer');
    return { type: description.type, sdp: description.sdp };
  });

  await receiver.evaluate(async (remoteOffer) => {
    const pc = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc;
    if (!pc) throw new Error('Receiver harness is not installed');
    await pc.setRemoteDescription(remoteOffer);
    await pc.setLocalDescription(await pc.createAnswer());
  }, offer);
  await waitForIceGathering(receiver);
  const answer = await receiver.evaluate(() => {
    const description = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc.localDescription;
    if (!description) throw new Error('Receiver did not create an answer');
    return { type: description.type, sdp: description.sdp };
  });

  await sender.evaluate(async (remoteAnswer) => {
    const pc = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc;
    if (!pc) throw new Error('Sender harness is not installed');
    await pc.setRemoteDescription(remoteAnswer);
  }, answer);

  await Promise.all([
    sender.waitForFunction(() => {
      return (window as Window & { __rtcHarness?: { channel: RTCDataChannel | null } }).__rtcHarness?.channel?.readyState === 'open';
    }, undefined, { timeout: 15_000 }),
    receiver.waitForFunction(() => {
      return (window as Window & { __rtcHarness?: { channel: RTCDataChannel | null } }).__rtcHarness?.channel?.readyState === 'open';
    }, undefined, { timeout: 15_000 }),
  ]);
};

const runTransfer = async (
  sender: Page,
  receiver: Page,
  totalBytes: number,
  chunkBytes = CHUNK_BYTES,
) => {
  const receiverResultPromise = receiver.evaluate(async () => {
    const promise = (window as Window & { __rtcHarness?: { transferPromise: Promise<TransferResult> | null } }).__rtcHarness?.transferPromise;
    if (!promise) throw new Error('Receiver transfer promise is unavailable');
    return promise;
  });

  const senderResultPromise = sender.evaluate(
    async ({ totalBytes, chunkBytes }) => {
      const channel = (window as Window & { __rtcHarness?: { channel: RTCDataChannel | null } }).__rtcHarness?.channel;
      if (!channel || channel.readyState !== 'open') throw new Error('Sender data channel is not open');

      const crcTable = new Uint32Array(256);
      for (let index = 0; index < crcTable.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        }
        crcTable[index] = value >>> 0;
      }

      channel.bufferedAmountLowThreshold = 256 * 1024;
      const waitForBuffer = async () => {
        if (channel.bufferedAmount <= 1024 * 1024) return;
        await new Promise<void>((resolve, reject) => {
          const pc = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc;
          const timeout = window.setTimeout(() => {
            if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
              onLow();
              return;
            }
            cleanup();
            reject(new Error(
              `Timed out waiting for RTCDataChannel buffer to drain: buffered=${channel.bufferedAmount}, ` +
              `dc=${channel.readyState}, pc=${pc?.connectionState ?? 'unknown'}, ` +
              `ice=${pc?.iceConnectionState ?? 'unknown'}`,
            ));
          }, 10_000);
          const poll = window.setInterval(() => {
            if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow();
          }, 100);
          const onLow = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            reject(new Error('Data channel closed while waiting for buffer space'));
          };
          const cleanup = () => {
            window.clearTimeout(timeout);
            window.clearInterval(poll);
            channel.removeEventListener('bufferedamountlow', onLow);
            channel.removeEventListener('close', onClose);
          };
          channel.addEventListener('bufferedamountlow', onLow, { once: true });
          channel.addEventListener('close', onClose, { once: true });
          if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow();
        });
      };

      const done = new Promise<TransferResult>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Receiver did not acknowledge transfer')), 120_000);
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data !== 'string') return;
          const message = JSON.parse(event.data) as { type: string; result: TransferResult };
          if (message.type !== 'DONE') return;
          window.clearTimeout(timeout);
          channel.removeEventListener('message', onMessage);
          resolve(message.result);
        };
        channel.addEventListener('message', onMessage);
      });

      channel.send(JSON.stringify({ type: 'START', bytes: totalBytes }));
      let crc = 0xffffffff;
      let maxBufferedAmount = 0;
      for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
        await waitForBuffer();
        const length = Math.min(chunkBytes, totalBytes - offset);
        const chunk = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) {
          const absoluteOffset = offset + index;
          const value = (absoluteOffset * 31 + (absoluteOffset >>> 8) + 17) & 0xff;
          chunk[index] = value;
          crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
        }
        channel.send(chunk);
        maxBufferedAmount = Math.max(maxBufferedAmount, channel.bufferedAmount);
      }

      const result = await done;
      return {
        ...result,
        expectedCrc32: (crc ^ 0xffffffff) >>> 0,
        maxBufferedAmount,
      };
    },
    { totalBytes, chunkBytes },
  );
  const [senderResult, receiverResult] = await Promise.all([
    senderResultPromise,
    receiverResultPromise,
  ]);

  expect(receiverResult.bytes).toBe(totalBytes);
  expect(senderResult.bytes).toBe(totalBytes);
  expect(senderResult.crc32).toBe(senderResult.expectedCrc32);
  expect(receiverResult.crc32).toBe(senderResult.expectedCrc32);
  expect(receiverResult.maxChunkBytes).toBeLessThanOrEqual(chunkBytes);
  expect(senderResult.maxBufferedAmount).toBeLessThanOrEqual(1024 * 1024 + chunkBytes);

  return { ...receiverResult, maxBufferedAmount: senderResult.maxBufferedAmount };
};

const selectedRoute = async (page: Page): Promise<SelectedRoute> => {
  return page.evaluate(async () => {
    const pc = (window as Window & { __rtcHarness?: { pc: RTCPeerConnection } }).__rtcHarness?.pc;
    if (!pc) throw new Error('RTC harness is not installed');
    const stats = await pc.getStats();
    // lib.dom types RTCStatsReport as ReadonlyMap<string, any>; the selected
    // candidate-pair record carries fields that the base RTCStats type omits.
    let pair: any;
    for (const report of stats.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
        break;
      }
      if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') pair = report;
    }
    if (!pair) throw new Error('No selected ICE candidate pair found');
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      localCandidateType: local?.candidateType ?? null,
      remoteCandidateType: remote?.candidateType ?? null,
      protocol: local?.protocol ?? null,
      relayProtocol: local?.relayProtocol ?? null,
      url: local?.url ?? null,
    };
  });
};

const withConnectedPages = async <T>(
  browser: Browser,
  settings: IceSettings,
  run: (sender: Page, receiver: Page) => Promise<T>,
) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    await connectPeers(sender, receiver, settings);
    return await run(sender, receiver);
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
};

test.describe('native RTCDataChannel throughput', () => {
  const localIce: IceSettings = { iceServers: [], iceTransportPolicy: 'all' };

  test('transfers 2 MiB without long progress stalls', async ({ browser }) => {
    const result = await withConnectedPages(browser, localIce, (sender, receiver) => runTransfer(sender, receiver, TWO_MIB));
    const elapsedLimit = process.env.CI ? 10_000 : 2_000;
    const stallLimit = process.env.CI ? 2_000 : 500;

    console.log(`RTC 2 MiB: ${result.elapsedMs.toFixed(0)}ms, max stall ${result.maxStallMs.toFixed(0)}ms`);
    expect(result.elapsedMs).toBeLessThanOrEqual(elapsedLimit);
    expect(result.maxStallMs).toBeLessThanOrEqual(stallLimit);
  });

  test('transfers and validates 100 MiB of deterministic bytes', async ({ browser }) => {
    const result = await withConnectedPages(browser, localIce, (sender, receiver) => runTransfer(sender, receiver, ONE_HUNDRED_MIB));

    console.log(`RTC 100 MiB: ${result.elapsedMs.toFixed(0)}ms, max stall ${result.maxStallMs.toFixed(0)}ms`);
    expect(result.maxStallMs).toBeLessThanOrEqual(process.env.CI ? 5_000 : 2_000);
  });

  for (const route of TURN_MATRIX) {
    const testName = `${route.label} relays and validates 2 MiB`;
    const url = process.env[route.envName];
    const username = process.env.AERODROP_TURN_USERNAME;
    const credential = process.env.AERODROP_TURN_CREDENTIAL;
    const missing = [
      !url && route.envName,
      !username && 'AERODROP_TURN_USERNAME',
      !credential && 'AERODROP_TURN_CREDENTIAL',
    ].filter(Boolean);
    const missingMessage = `Missing required TURN matrix variables: ${missing.join(', ')}`;

    if (missing.length > 0) {
      test(testName, () => {
        if (process.env.AERODROP_REQUIRE_TURN_MATRIX === '1') throw new Error(missingMessage);
        test.skip(true, missingMessage);
      });
      continue;
    }

    test(testName, async ({ browser }) => {
      const settings: IceSettings = {
        iceServers: [{ urls: url!, username, credential }],
        iceTransportPolicy: 'relay',
      };
      await withConnectedPages(browser, settings, async (sender, receiver) => {
        const [senderRoute, receiverRoute] = await Promise.all([selectedRoute(sender), selectedRoute(receiver)]);
        for (const selected of [senderRoute, receiverRoute]) {
          expect(selected.localCandidateType).toBe('relay');
          expect(selected.url?.toLowerCase().startsWith(route.scheme)).toBe(true);
          expect(selected.relayProtocol).toBe(route.relayProtocol);
        }

        const result = await runTransfer(sender, receiver, TWO_MIB);
        console.log(
          `${route.label} 2 MiB: ${result.elapsedMs.toFixed(0)}ms, max stall ${result.maxStallMs.toFixed(0)}ms, ` +
          `candidate ${senderRoute.protocol}/${senderRoute.relayProtocol}`,
        );
        expect(result.maxStallMs).toBeLessThanOrEqual(process.env.CI ? 5_000 : 2_000);
      });
    });
  }
});

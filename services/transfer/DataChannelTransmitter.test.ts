import test from 'node:test';
import assert from 'node:assert/strict';

import type { DataConnection } from '../peerRuntime.ts';
import {
  isDataChannelMessageTooLargeError,
  resolveDataChannelChunkSize,
  resolveSharedBufferLimits,
  waitForDataChannelDrain,
} from './DataChannelTransmitter.ts';

const createTransport = (bufferedAmount: number) => {
  const dataChannel = Object.assign(new EventTarget(), {
    bufferedAmount,
    bufferedAmountLowThreshold: 0,
    readyState: 'open',
  }) as unknown as RTCDataChannel;
  const peerConnection = Object.assign(new EventTarget(), {
    connectionState: 'connected',
  }) as unknown as RTCPeerConnection;
  const conn = {
    open: true,
    peerConnection,
  } as DataConnection;

  return { conn, dataChannel };
};

test('resolves chunk size from route cap and negotiated SCTP maximum', () => {
  assert.equal(resolveDataChannelChunkSize(128 * 1024), 64 * 1024);
  assert.equal(resolveDataChannelChunkSize(128 * 1024, 16 * 1024), 16 * 1024);
  assert.equal(resolveDataChannelChunkSize(128 * 1024, 64 * 1024), 64 * 1024);
  assert.equal(resolveDataChannelChunkSize(128 * 1024, 256 * 1024), 128 * 1024);
});

test('shares the in-flight buffer budget across concurrent receivers', () => {
  const lanFlow = { highWaterMark: 2 * 1024 * 1024, lowWaterMark: 512 * 1024 };

  assert.deepEqual(resolveSharedBufferLimits(lanFlow, 1), lanFlow);

  const eight = resolveSharedBufferLimits(lanFlow, 8);
  assert.equal(eight.highWaterMark, 512 * 1024);
  assert.equal(eight.lowWaterMark, 256 * 1024);

  const sixteen = resolveSharedBufferLimits(lanFlow, 16);
  assert.equal(sixteen.highWaterMark, 256 * 1024);
  assert.equal(sixteen.lowWaterMark, 128 * 1024);

  const crowded = resolveSharedBufferLimits(lanFlow, 10_000);
  assert.ok(crowded.highWaterMark >= 1);
  assert.ok(crowded.highWaterMark > crowded.lowWaterMark);
});

test('waits for bufferedamountlow and rejects when the channel closes', async () => {
  const first = createTransport(2 * 1024 * 1024);
  const drained = waitForDataChannelDrain(first.conn, first.dataChannel, {
    highWaterMark: 1024 * 1024,
    lowWaterMark: 256 * 1024,
  });
  (first.dataChannel as unknown as { bufferedAmount: number }).bufferedAmount = 128 * 1024;
  first.dataChannel.dispatchEvent(new Event('bufferedamountlow'));
  await drained;

  const second = createTransport(2 * 1024 * 1024);
  const closed = waitForDataChannelDrain(second.conn, second.dataChannel, {
    highWaterMark: 1024 * 1024,
    lowWaterMark: 256 * 1024,
  });
  second.dataChannel.dispatchEvent(new Event('close'));
  await assert.rejects(closed, /closed while waiting/);
});

test('recognizes oversize send errors without treating arbitrary failures as oversize', () => {
  assert.equal(isDataChannelMessageTooLargeError(new TypeError('Message too large')), true);
  assert.equal(isDataChannelMessageTooLargeError(new Error('SCTP maxMessageSize exceeded')), true);
  assert.equal(isDataChannelMessageTooLargeError(new Error('connection closed')), false);
});

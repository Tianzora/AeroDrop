import test from 'node:test';
import assert from 'node:assert/strict';

import { METADATA_CHUNKING } from '../../constants/transfer.ts';
import { sendMetadataMessages } from './routeHandshake.ts';
import type { FileMetadata, P2PMessage } from '../../types/index.ts';

const collectMetadataMessages = (metadata: FileMetadata): P2PMessage[] => {
  const sent: P2PMessage[] = [];
  sendMetadataMessages((message) => sent.push(message), metadata);
  return sent;
};

const smallMetadata: FileMetadata = {
  files: [{ name: 'a.txt', size: 1, type: 'text/plain', lastModified: 0 }],
  totalSize: 1,
  protocolVersion: 4,
};

const buildLargeMetadata = (fileCount = 4000): FileMetadata => ({
  files: Array.from({ length: fileCount }, (_, index) => ({
    name: `folder-${index % 40}/file-${index}.bin`,
    size: 2048,
    type: 'application/octet-stream',
    lastModified: 0,
    fingerprint: `fp-${index}`,
  })),
  totalSize: fileCount * 2048,
  protocolVersion: 4,
});

test('keeps small metadata as a single METADATA message', () => {
  const sent = collectMetadataMessages(smallMetadata);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'METADATA');
});

test('splits oversized metadata into chunks that rejoin to the original payload', () => {
  const metadata = buildLargeMetadata();
  assert.ok(
    JSON.stringify(metadata).length > METADATA_CHUNKING.MAX_MESSAGE_BYTES,
    'fixture must be larger than one message',
  );

  const sent = collectMetadataMessages(metadata);
  assert.ok(sent.length > 1, 'oversized metadata must be split');

  const chunks = sent.map((message) => {
    assert.equal(message.type, 'METADATA_CHUNK');
    if (message.type !== 'METADATA_CHUNK') {
      throw new Error('unexpected message type');
    }
    return message.payload;
  });

  assert.equal(chunks[0]?.index, 0);
  assert.equal(chunks[0]?.total, sent.length);

  const joined = [...chunks]
    .sort((left, right) => left.index - right.index)
    .map((chunk) => chunk.data)
    .join('');

  assert.deepEqual(JSON.parse(joined), metadata);
});

test('every chunk shares one transfer id and stays inside the message budget', () => {
  const sent = collectMetadataMessages(buildLargeMetadata());

  const transferIds = new Set(
    sent.map((message) => (message.type === 'METADATA_CHUNK' ? message.payload.transferId : '')),
  );
  assert.equal(transferIds.size, 1);

  // SCTP rejects single messages above 256 KiB. Chunks carry raw JSON fragments,
  // and re-serializing doubles at worst when every quote needs escaping.
  const SCTP_SAFE_MESSAGE_BYTES = 256 * 1024;

  for (const message of sent) {
    if (message.type !== 'METADATA_CHUNK') {
      throw new Error('unexpected message type');
    }
    assert.ok(
      message.payload.data.length <= METADATA_CHUNKING.MAX_MESSAGE_BYTES,
      'raw chunk must respect the configured slice size',
    );
    assert.ok(
      JSON.stringify(message).length <= SCTP_SAFE_MESSAGE_BYTES,
      'each serialized chunk must stay below the SCTP message limit',
    );
  }
});

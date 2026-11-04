import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiverSessionRegistry } from './receiverSessionRegistry.ts';
import { createRouteCommitGate } from './routeCommitGate.ts';
import { createSenderRouteHandshakeHandler } from './routeHandshake.ts';
import type { FileMetadata, P2PMessage } from '../../types/index.ts';

type TestConn = {
  id: string;
  peer: string;
  sent: P2PMessage[];
  closed: boolean;
  send: (message: P2PMessage) => void;
  close: () => void;
};

type CommitEvent = {
  conn: TestConn;
  receiverSessionId: string;
  selectedKind: 'all' | 'relay';
  replacedConnectionId?: string;
};

const metadata: FileMetadata = {
  files: [{ name: 'a.txt', size: 1, type: 'text/plain', lastModified: 0 }],
  totalSize: 1,
  protocolVersion: 1,
};

const createConn = (id: string, peer = `peer-${id}`): TestConn => {
  const conn: TestConn = {
    id,
    peer,
    sent: [],
    closed: false,
    send(message) {
      conn.sent.push(message);
    },
    close() {
      conn.closed = true;
    },
  };

  return conn;
};

const createHarness = () => {
  const registry = createReceiverSessionRegistry();
  const commitGate = createRouteCommitGate();
  const commits: CommitEvent[] = [];

  const handler = createSenderRouteHandshakeHandler<TestConn>({
    registry,
    commitGate,
    metadata,
    deviceName: 'sender-device',
    getConnectionId: (conn) => conn.id,
    onRouteCommitted: (args) => {
      // The handler receives TestConn instances even though the option type is widened.
      commits.push({ ...args, conn: args.conn as TestConn });
    },
  });

  const sendProbe = (conn: TestConn, attemptId: string, attemptKind: 'all' | 'relay') =>
    handler.handleMessage(conn, {
      type: 'ROUTE_PROBE',
      payload: {
        receiverSessionId: 'receiver-1',
        attemptId,
        attemptKind,
        deviceName: 'receiver-device',
      },
    });

  const sendCommit = (conn: TestConn, attemptId: string, selectedKind: 'all' | 'relay' = 'all') =>
    handler.handleMessage(conn, {
      type: 'ROUTE_COMMIT',
      payload: {
        receiverSessionId: 'receiver-1',
        attemptId,
        selectedKind,
      },
    });

  return { registry, commitGate, handler, commits, sendProbe, sendCommit };
};

test('route probe registers the attempt and acknowledges it', () => {
  const { registry, sendProbe } = createHarness();
  const conn = createConn('conn-all');

  assert.equal(sendProbe(conn, 'a1', 'all'), true);
  assert.deepEqual(
    conn.sent.map((message) => message.type),
    ['ROUTE_READY']
  );
  assert.deepEqual(conn.sent[0].payload, {
    receiverSessionId: 'receiver-1',
    attemptId: 'a1',
  });
  assert.equal(conn.closed, false);
  assert.equal(registry.getSession('receiver-1')?.attempts.all?.connectionId, 'conn-all');
});

test('route commit without a registered attempt is rejected and closes the connection', () => {
  const { sendCommit } = createHarness();
  const conn = createConn('conn-all');

  assert.equal(sendCommit(conn, 'a2'), true);
  assert.equal(conn.closed, true);
  assert.deepEqual(conn.sent, []);
});

test('accepted commit sends device info and metadata once', () => {
  const { commits, sendProbe, sendCommit } = createHarness();
  const conn = createConn('conn-all');

  sendProbe(conn, 'a1', 'all');
  assert.equal(sendCommit(conn, 'a1'), true);

  assert.deepEqual(
    conn.sent.map((message) => message.type),
    ['ROUTE_READY', 'DEVICE_INFO', 'METADATA']
  );
  assert.deepEqual(commits, [
    {
      conn,
      receiverSessionId: 'receiver-1',
      selectedKind: 'all',
    },
  ]);
  assert.equal(conn.closed, false);
});

test('duplicate commit is acknowledged without resending metadata', () => {
  const { commits, sendProbe, sendCommit } = createHarness();
  const conn = createConn('conn-all');

  sendProbe(conn, 'a1', 'all');
  sendCommit(conn, 'a1');
  const sentAfterFirstCommit = conn.sent.length;

  assert.equal(sendCommit(conn, 'a1'), true);
  assert.equal(conn.sent.length, sentAfterFirstCommit);
  assert.equal(commits.length, 1);
  assert.equal(conn.closed, false);
});

test('conflicting commit closes the connection when the winner is still alive', () => {
  const { sendProbe, sendCommit } = createHarness();
  const relayConn = createConn('conn-relay');
  const allConn = createConn('conn-all');

  sendProbe(relayConn, 'a-relay', 'relay');
  sendProbe(allConn, 'a-all', 'all');
  assert.equal(sendCommit(allConn, 'a-all'), true);

  assert.equal(sendCommit(relayConn, 'a-relay', 'relay'), true);
  assert.equal(relayConn.closed, true);
  assert.deepEqual(
    relayConn.sent.map((message) => message.type),
    ['ROUTE_READY']
  );
});

test('reconnect candidate replaces the committed connection', () => {
  const { commits, sendProbe, sendCommit } = createHarness();
  const allConn = createConn('conn-all');
  const reconnectConn = createConn('conn-all-2');

  sendProbe(allConn, 'a-all', 'all');
  sendCommit(allConn, 'a-all');
  sendProbe(reconnectConn, 'a-reconnect', 'all');

  assert.equal(sendCommit(reconnectConn, 'a-reconnect'), true);
  assert.equal(reconnectConn.closed, false);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].replacedConnectionId, 'conn-all');
  assert.deepEqual(
    reconnectConn.sent.map((message) => message.type),
    ['ROUTE_READY', 'DEVICE_INFO', 'METADATA']
  );
});

test('released connection frees the session for a fresh commit', () => {
  const { registry, commitGate, commits, sendProbe, sendCommit } = createHarness();
  const firstConn = createConn('conn-all');
  const secondConn = createConn('conn-all-2');

  sendProbe(firstConn, 'a1', 'all');
  sendCommit(firstConn, 'a1');
  registry.releaseConnection('conn-all');
  commitGate.releaseConnection('conn-all');

  sendProbe(secondConn, 'a2', 'all');
  assert.equal(sendCommit(secondConn, 'a2'), true);

  assert.equal(secondConn.closed, false);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].replacedConnectionId, undefined);
  assert.equal(commitGate.getCommittedConnectionId('receiver-1'), 'conn-all-2');
});

test('route abort closes the connection and unrelated messages are not handled', () => {
  const { handler } = createHarness();
  const abortConn = createConn('conn-all');

  assert.equal(
    handler.handleMessage(abortConn, {
      type: 'ROUTE_ABORT',
      payload: { receiverSessionId: 'receiver-1', attemptId: 'a1', reason: 'lost_race' },
    }),
    true
  );
  assert.equal(abortConn.closed, true);

  const metadataConn = createConn('conn-relay');
  assert.equal(handler.handleMessage(metadataConn, { type: 'METADATA', payload: metadata }), false);
  assert.equal(metadataConn.closed, false);
});

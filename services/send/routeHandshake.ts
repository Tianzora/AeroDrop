import type { FileMetadata, P2PMessage } from '../../types';
import { METADATA_CHUNKING } from '../../constants/transfer.ts';
import type { createReceiverSessionRegistry } from './receiverSessionRegistry';
import type { createRouteCommitGate } from './routeCommitGate';

// The SCTP data channel rejects messages above ~256 KiB (Chrome). Send metadata
// either as one METADATA message or as a sequence of METADATA_CHUNK messages
// that the receiver rejoins before parsing.
export const sendMetadataMessages = (
  send: (message: P2PMessage) => void,
  metadata: FileMetadata,
): void => {
  const json = JSON.stringify(metadata);

  if (json.length <= METADATA_CHUNKING.MAX_MESSAGE_BYTES) {
    send({ type: 'METADATA', payload: metadata });
    return;
  }

  const chunkSize = METADATA_CHUNKING.MAX_MESSAGE_BYTES;
  const total = Math.ceil(json.length / chunkSize);
  const transferId = `metadata-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  for (let index = 0; index < total; index += 1) {
    send({
      type: 'METADATA_CHUNK',
      payload: {
        transferId,
        index,
        total,
        data: json.slice(index * chunkSize, (index + 1) * chunkSize),
      },
    });
  }
};

export type SenderRouteHandshakeConnection = {
  peer: string;
  send: (message: P2PMessage) => void;
  close: () => void;
};

type SenderRouteHandshakeOptions = {
  registry: ReturnType<typeof createReceiverSessionRegistry>;
  commitGate: ReturnType<typeof createRouteCommitGate>;
  metadata: FileMetadata;
  deviceName: string;
  onRouteCommitted?: (args: {
    conn: SenderRouteHandshakeConnection;
    receiverSessionId: string;
    selectedKind: 'all' | 'relay';
    replacedConnectionId?: string;
  }) => void;
};

export const createSenderRouteHandshakeHandler = <TConn extends SenderRouteHandshakeConnection>(
  options: SenderRouteHandshakeOptions & {
    getConnectionId: (conn: TConn) => string;
    onRouteCommitted?: (args: {
      conn: TConn;
      receiverSessionId: string;
      selectedKind: 'all' | 'relay';
      replacedConnectionId?: string;
    }) => void;
  }
) => ({
  handleMessage(conn: TConn, msg: P2PMessage) {
    if (msg.type === 'ROUTE_PROBE') {
      options.registry.registerAttempt({
        receiverSessionId: msg.payload.receiverSessionId,
        attemptId: msg.payload.attemptId,
        attemptKind: msg.payload.attemptKind,
        peerId: conn.peer,
        connectionId: options.getConnectionId(conn),
      });

      conn.send({
        type: 'ROUTE_READY',
        payload: {
          receiverSessionId: msg.payload.receiverSessionId,
          attemptId: msg.payload.attemptId,
        },
      });
      return true;
    }

    if (msg.type === 'ROUTE_COMMIT') {
      const connectionId = options.getConnectionId(conn);
      if (
        !options.registry.resolveAttemptForCommit(
          msg.payload.receiverSessionId,
          msg.payload.attemptId,
          connectionId
        )
      ) {
        conn.close();
        return true;
      }

      const commitClaim = options.commitGate.claimCommit(msg.payload.receiverSessionId, connectionId);
      let replacedConnectionId: string | undefined;

      if (commitClaim.status === 'conflict') {
        const committedConnectionId = options.commitGate.getCommittedConnectionId(
          msg.payload.receiverSessionId
        );

        if (
          !committedConnectionId ||
          !options.registry.isReconnectCandidate(msg.payload.receiverSessionId, connectionId)
        ) {
          conn.close();
          return true;
        }

        replacedConnectionId = committedConnectionId;
        options.commitGate.markCommitted(msg.payload.receiverSessionId, connectionId);
      } else if (commitClaim.status === 'duplicate') {
        return true;
      } else {
        replacedConnectionId = undefined;
      }
      options.registry.markCommitted(msg.payload.receiverSessionId, connectionId);

      try {
        conn.send({
          type: 'DEVICE_INFO',
          payload: { deviceName: options.deviceName },
        });
        sendMetadataMessages((message) => conn.send(message), options.metadata);
        const committedArgs = {
          conn,
          receiverSessionId: msg.payload.receiverSessionId,
          selectedKind: msg.payload.selectedKind,
          ...(replacedConnectionId ? { replacedConnectionId } : {}),
        };
        options.onRouteCommitted?.(committedArgs);
      } catch (error) {
        console.error('Failed to send committed route metadata', error);
      }
      return true;
    }

    if (msg.type === 'ROUTE_ABORT') {
      conn.close();
      return true;
    }

    return false;
  },
});

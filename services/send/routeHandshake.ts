import type { FileMetadata, P2PMessage } from '../../types';
import { METADATA_CHUNKING } from '../../constants/transfer.ts';
import type { createReceiverSessionRegistry } from './receiverSessionRegistry';
import type { createRouteCommitGate } from './routeCommitGate';

// The SCTP data channel rejects messages above ~256 KiB (Chrome). Send metadata
// either as one METADATA message or as a sequence of METADATA_CHUNK messages
// that the receiver rejoins before parsing. Budgets are measured on the encoded
// wire form (UTF-8 bytes + JSON escaping), not on JS code units: a CJK filename
// is one code unit but three bytes, and a quote becomes two bytes when escaped.
const encoder = new TextEncoder();

const METADATA_ENVELOPE_OVERHEAD_BYTES = 256;

const estimateEscapedUtf8Bytes = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += code === 0x22 || code === 0x5c ? 2 : 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const wireMessageBytes = (message: P2PMessage): number =>
  encoder.encode(JSON.stringify(message)).length;

export const splitMetadataJson = (
  json: string,
  maxMessageBytes: number = METADATA_CHUNKING.MAX_MESSAGE_BYTES,
): string[] => {
  const budget = Math.max(1024, maxMessageBytes - METADATA_ENVELOPE_OVERHEAD_BYTES);
  const chunks: string[] = [];
  let start = 0;

  while (start < json.length) {
    let bytes = 0;
    let end = start;
    while (end < json.length) {
      const code = json.charCodeAt(end);
      const charBytes =
        code < 0x80 ? (code === 0x22 || code === 0x5c ? 2 : 1) : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
      if (bytes + charBytes > budget && end > start) break;
      bytes += charBytes;
      end += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    }
    // Defensive: never emit a chunk whose real envelope is over budget.
    let sliceEnd = Math.min(end, json.length);
    while (sliceEnd > start + 1) {
      const candidate = json.slice(start, sliceEnd);
      if (estimateEscapedUtf8Bytes(candidate) + METADATA_ENVELOPE_OVERHEAD_BYTES <= maxMessageBytes) break;
      sliceEnd = start + Math.max(1, Math.floor((sliceEnd - start) * 0.9));
    }
    chunks.push(json.slice(start, sliceEnd));
    start = sliceEnd;
  }

  return chunks;
};

export const sendMetadataMessages = (
  send: (message: P2PMessage) => void,
  metadata: FileMetadata,
): void => {
  const single: P2PMessage = { type: 'METADATA', payload: metadata };

  if (wireMessageBytes(single) <= METADATA_CHUNKING.MAX_MESSAGE_BYTES) {
    send(single);
    return;
  }

  const json = JSON.stringify(metadata);
  const chunks = splitMetadataJson(json);
  const total = chunks.length;
  const transferId = `metadata-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  chunks.forEach((data, index) => {
    send({ type: 'METADATA_CHUNK', payload: { transferId, index, total, data } });
  });
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

/**
 * 观众侧连接看护的判定逻辑。
 *
 * 为什么要单独判：`peer.call()` 返回后，answer/stream 事件都在 ICE 连通之前就会到达，
 * 所以「收到 stream」不等于「能出画面」。如果不看 `connectionState`，ICE 失败时会一直
 * 停在黑屏，直到冻帧看护或用户手动重试，体验上就是「卡了两分钟」。
 */
export type ViewerConnectionDecision = 'ok' | 'wait' | 'retry';

/** disconnected 先给一段宽限：ICE 短暂抖动后自行恢复很常见，立刻重连会白烧重连预算。 */
export const VIEWER_DISCONNECT_GRACE_MS = 8_000;

export type ViewerConnectionState = RTCPeerConnectionState | 'unknown';

export const decideViewerConnection = (input: {
  state: ViewerConnectionState;
  disconnectedForMs?: number;
  graceMs?: number;
}): ViewerConnectionDecision => {
  const graceMs = input.graceMs ?? VIEWER_DISCONNECT_GRACE_MS;
  switch (input.state) {
    case 'connected':
      return 'ok';
    case 'failed':
      // ICE 已经放弃，再等也不会自愈。
      return 'retry';
    case 'closed':
      return 'retry';
    case 'disconnected': {
      const elapsed = Number.isFinite(input.disconnectedForMs) ? Math.max(0, input.disconnectedForMs ?? 0) : 0;
      return elapsed >= graceMs ? 'retry' : 'wait';
    }
    default:
      // new / connecting / unknown：还没到能判定的时候。
      return 'wait';
  }
};
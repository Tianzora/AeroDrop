/**
 * 分享端信令故障：重连 / 重建 peer / 落终态的判定。
 *
 * 这几条分支以前直接长在 ScreenShare 的恢复 effect 里，没有任何测试能证明「预算耗尽
 * 会进终态」。结果是两条最贵的路径（重建耗尽、首连看门狗）只能靠人工复现：
 * 用户看到的是永远停在「正在连接服务器」或者绿色 LIVE 挂着一条死链接。
 *
 * 判定只依赖计数和信令状态，不碰 DOM/Peer 对象，因此可以直接单测。
 */

export type SharerSignalingState =
  | 'connected'
  | 'connecting'
  | 'idle'
  | 'rejected'
  | 'exhausted'
  | 'destroyed';

export interface SharerRecoveryInput {
  /** 房号是否已经登记成功；没有房号就没有可复用的会话，只能重试完整初始化。 */
  hasShareRoom: boolean;
  /** 本次是第几次重连（已 +1）。 */
  attempt: number;
  maxAttempts: number;
  /** 没有 peer 对象或 peer 已 destroyed。 */
  peerMissing: boolean;
  /** 已经重建过多少次 peer。 */
  peerRebuilds: number;
  maxPeerRebuilds: number;
  signalingState: SharerSignalingState;
  /** 登记失败时记录下来的文案（限流/占用/网络各不相同，不能一律说信令不可达）。 */
  roomFailureMessage: string | null;
  unreachableMessage: string;
  reconnectExhaustedMessage: string;
  sessionRejectedMessage: string;
}

export type SharerRecoveryDecision =
  | { kind: 'terminal'; message: string }
  | { kind: 'initialize-peer' }
  | { kind: 'retry-signaling' }
  | { kind: 'rebuild-peer' }
  | { kind: 'wait' };

export const planSharerRecovery = (input: SharerRecoveryInput): SharerRecoveryDecision => {
  // 房号都没登记成功：没有会话可复用，重试一次完整初始化（含登记）。
  if (!input.hasShareRoom) {
    if (input.attempt > input.maxAttempts) {
      return { kind: 'terminal', message: input.roomFailureMessage ?? input.unreachableMessage };
    }
    return { kind: 'initialize-peer' };
  }

  // peer 对象没了但房号还在：重建即可，已经发出去的链接仍然有效。
  if (input.peerMissing) {
    if (input.peerRebuilds >= input.maxPeerRebuilds) {
      return { kind: 'terminal', message: input.reconnectExhaustedMessage };
    }
    return { kind: 'rebuild-peer' };
  }

  // 服务端明确拒绝（占用/未授权/限流）：同一个房号重试不会好。
  if (input.signalingState === 'rejected') {
    return { kind: 'terminal', message: input.sessionRejectedMessage };
  }

  if (input.signalingState === 'exhausted' || input.signalingState === 'destroyed') {
    if (input.peerRebuilds >= input.maxPeerRebuilds) {
      return { kind: 'terminal', message: input.reconnectExhaustedMessage };
    }
    return { kind: 'rebuild-peer' };
  }

  // WS 已经停了但还没到预算上限：先试着把信令拉起来，别急着销毁 peer
  // （销毁会换 peerId 并关掉所有观众的媒体连接）。
  if (input.signalingState === 'idle') return { kind: 'retry-signaling' };

  return { kind: 'wait' };
};

export interface SharerFirstConnectInput {
  isSharing: boolean;
  isPeerReady: boolean;
  elapsedMs: number;
  timeoutMs: number;
}

export type SharerFirstConnectDecision = 'wait' | 'timeout';

/**
 * 首连看门狗：登记成功但信令一直没 open 时不能永远停在「正在连接服务器」。
 * 已就绪或已停止共享都不该再判超时。
 */
export const planSharerFirstConnectWatchdog = ({
  isSharing,
  isPeerReady,
  elapsedMs,
  timeoutMs,
}: SharerFirstConnectInput): SharerFirstConnectDecision => {
  if (!isSharing || isPeerReady) return 'wait';
  const limit = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  return elapsedMs >= limit ? 'timeout' : 'wait';
};

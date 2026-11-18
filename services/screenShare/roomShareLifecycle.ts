/**
 * 方向 B：停止共享 ≠ 结束房间。
 *
 * 纯决策层：停共享只停视频发送（replaceTrack(null)），保留 room peer、星形 data 通道与
 * 聊天会话，房号继续按 30 分钟续期；只有「结束并离开」的 closeRoom（或页面卸载）才 revoke。
 * 分支判定收在这里，组件只按返回值执行，测试直接锁这些返回值。
 */

export interface StopScreenShareInput {
  hasPeer: boolean;
  hasShareRoom: boolean;
}

export interface StopScreenSharePlan {
  keepPeer: boolean;
  keepShareRoom: boolean;
  keepRoomChannels: boolean;
  keepMediaCalls: boolean;
  revokeRoom: boolean;
  stopVideoOnly: boolean;
  broadcastShareEnded: boolean;
  chatSession: 'keep' | 'reset';
}

export function planStopScreenShare(input: StopScreenShareInput): StopScreenSharePlan {
  const keep = input.hasPeer && input.hasShareRoom;
  return {
    keepPeer: keep,
    keepShareRoom: keep,
    keepRoomChannels: keep,
    keepMediaCalls: keep,
    revokeRoom: false,
    stopVideoOnly: true,
    broadcastShareEnded: true,
    chatSession: keep ? 'keep' : 'reset',
  };
}

export interface RestartScreenShareInput {
  hasPeer: boolean;
  hasShareRoom: boolean;
  peerReady: boolean;
  roomExpired: boolean;
}

export interface RestartScreenSharePlan {
  reuseRoom: boolean;
  initializePeer: boolean;
  resetChat: boolean;
  renegotiate: boolean;
  replaceExistingTracks: boolean;
}

export function planRestartScreenShare(input: RestartScreenShareInput): RestartScreenSharePlan {
  const reuse =
    input.hasPeer && input.hasShareRoom && input.peerReady && !input.roomExpired;
  return {
    reuseRoom: reuse,
    initializePeer: !reuse,
    resetChat: !reuse,
    renegotiate: false,
    replaceExistingTracks: reuse,
  };
}

export interface RemoteShareEndedInput {
  /** true = 分享方是整个房间离开（window_closed），不是单纯停共享。 */
  peerLeavingRoom?: boolean;
}

export interface RemoteShareEndedPlan {
  destroyPeer: boolean;
  closeRoomChat: boolean;
  keepStreamRef: boolean;
  pauseVideo: boolean;
  clearPersistedSession: boolean;
}

export function planRemoteShareEnded(input: RemoteShareEndedInput = {}): RemoteShareEndedPlan {
  const leaving = input.peerLeavingRoom === true;
  return {
    destroyPeer: leaving,
    closeRoomChat: leaving,
    keepStreamRef: !leaving,
    pauseVideo: !leaving,
    clearPersistedSession: leaving,
  };
}

/**
 * 停共享只摘视频轨，不要动音频：M2 语音复用同一条 PC，把 audio sender 一起
 * replaceTrack(null) 会在画面暂停时顺带把人声静音。
 */
export function pauseActiveCallVideo(
  calls: ReadonlyArray<{ peerConnection: RTCPeerConnection | null }>,
): void {
  calls.forEach((call) => {
    call.peerConnection?.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') return;
      void sender.replaceTrack(null);
    });
  });
}
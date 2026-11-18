import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pauseActiveCallVideo,
  planRemoteShareEnded,
  planRestartScreenShare,
  planStopScreenShare,
} from './roomShareLifecycle.ts';

test('停共享后保留 room peer、星形通道、媒体连接与聊天会话，且不 revoke', () => {
  const plan = planStopScreenShare({ hasPeer: true, hasShareRoom: true });

  assert.equal(plan.keepPeer, true);
  assert.equal(plan.keepShareRoom, true);
  assert.equal(plan.keepRoomChannels, true);
  assert.equal(plan.keepMediaCalls, true);
  assert.equal(plan.chatSession, 'keep');
  assert.equal(plan.revokeRoom, false);
  assert.equal(plan.broadcastShareEnded, true);
});

test('没有房间时不假装保留：连接与聊天都收掉（但也不 revoke 一个不存在的房间）', () => {
  const plan = planStopScreenShare({ hasPeer: false, hasShareRoom: false });

  assert.equal(plan.keepPeer, false);
  assert.equal(plan.keepShareRoom, false);
  assert.equal(plan.chatSession, 'reset');
  assert.equal(plan.revokeRoom, false);
});

test('房间仍活跃：重新共享复用同一 room peer/房号，不重建 peer、不 reset 聊天', () => {
  const plan = planRestartScreenShare({
    hasPeer: true,
    hasShareRoom: true,
    peerReady: true,
    roomExpired: false,
  });

  assert.equal(plan.reuseRoom, true);
  assert.equal(plan.initializePeer, false);
  assert.equal(plan.resetChat, false);
  assert.equal(plan.renegotiate, false);
  assert.equal(plan.replaceExistingTracks, true);
});

test('房号过期或信令未就绪：不能复用，回到重建路径', () => {
  assert.equal(
    planRestartScreenShare({ hasPeer: true, hasShareRoom: true, peerReady: true, roomExpired: true })
      .reuseRoom,
    false,
  );
  assert.equal(
    planRestartScreenShare({ hasPeer: true, hasShareRoom: true, peerReady: false, roomExpired: false })
      .initializePeer,
    true,
  );
});

test('远端 share-ended 只暂停画面：不 destroy peer、不关房间聊天、保留 streamRef', () => {
  const plan = planRemoteShareEnded();

  assert.equal(plan.destroyPeer, false);
  assert.equal(plan.closeRoomChat, false);
  assert.equal(plan.keepStreamRef, true);
  assert.equal(plan.pauseVideo, true);
  assert.equal(plan.clearPersistedSession, false);
});

test('远端整房离开（window_closed）走全断：destroy peer、关聊天、清持久会话', () => {
  const plan = planRemoteShareEnded({ peerLeavingRoom: true });

  assert.equal(plan.destroyPeer, true);
  assert.equal(plan.closeRoomChat, true);
  assert.equal(plan.keepStreamRef, false);
  assert.equal(plan.pauseVideo, false);
  assert.equal(plan.clearPersistedSession, true);
});

test('停共享只把 video sender replaceTrack(null)，跳过 audio 轨', () => {
  const released: Array<{ label: string; kind: string } | null> = [];
  const makeSender = (label: string, kind: string) => ({
    track: { kind },
    replaceTrack: async (track: MediaStreamTrack | null) => {
      released.push(track === null ? null : { label, kind: track.kind });
    },
  });
  const callA = {
    peerConnection: {
      getSenders: () => [makeSender('a-video', 'video'), makeSender('a-audio', 'audio')],
    } as unknown as RTCPeerConnection,
  };
  const callB = {
    peerConnection: {
      getSenders: () => [makeSender('b-video', 'video'), makeSender('b-audio', 'audio')],
    } as unknown as RTCPeerConnection,
  };

  pauseActiveCallVideo([callA, callB]);

  assert.deepEqual(released, [null, null]);
});
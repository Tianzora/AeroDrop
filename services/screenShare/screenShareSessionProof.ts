/**
 * 屏幕共享的 proof 粘合层：重建凭证、proof 落盘与清理的唯一入口。
 *
 * 这三件事必须成对出现（组装凭证要用 proof、服务端下发 proof 要落盘、终态要清理）。
 * 分散写在组件里时任何一处漏掉都只在「共享跑过静态摘要宽限期 + 重连耗尽」时才暴露，
 * 而且组件里没法在 Node 测试里驱动。把 room 与 storage 都做成入参之后，重建路径
 * 可以被单测直接覆盖。
 */

import {
  forgetSessionProof,
  recallSessionProof,
  rememberSessionProof,
  type ProofStorage,
} from './sessionProofStore.ts';
import {
  createScreenSharePeerCredentials,
  type ScreenSharePeerCredentials,
  type ScreenShareRoomCredentials,
} from './screenSharePeerCredentials.ts';

/** 房号凭证 + 房号自身的 peerId：proof 按 peerId 落盘，和信令侧的会话键一致。 */
export type ScreenShareSessionRoom = ScreenShareRoomCredentials & { peerId: string };

/**
 * 重建 PeerRuntime 时用的信令凭证：能从 storage 取回 proof 就只出示 proof，
 * 取不到（首次连接、storage 不可用、已被清理）才退回首连的静态摘要。
 */
export const resolveScreenSharePeerCredentials = (
  room: ScreenShareSessionRoom,
  storage?: ProofStorage | null
): ScreenSharePeerCredentials =>
  createScreenSharePeerCredentials(room, recallSessionProof(room.peerId, storage));

/** 服务端每次注册都轮换 proof：接住最新的一个，重建时才有可用的凭证。 */
export const rememberScreenShareSessionProof = (
  room: ScreenShareSessionRoom,
  proof: string,
  storage?: ProofStorage | null
): boolean => rememberSessionProof(room.peerId, proof, storage);

/** 停止分享、进入终态、房号被撤销时清理：旧 proof 属于已撤销的房号，留着只是残留凭证。 */
export const forgetScreenShareSessionProof = (
  room: ScreenShareSessionRoom,
  storage?: ProofStorage | null
): void => forgetSessionProof(room.peerId, storage);

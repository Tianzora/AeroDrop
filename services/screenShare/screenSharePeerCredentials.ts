/**
 * 屏幕共享信令凭证的组装：有 proof 就只带 proof。
 *
 * 服务端在首次绑定后开一个静态摘要（sessionSecretHash）的宽限窗口，窗口过后只认
 * 轮换的 proof（`services/signaling/sessionBinding.ts` 会拒）。所以重建 PeerRuntime
 * 时如果还照抄首次连接的摘要，长时共享一旦断到重连耗尽就再也回不来。
 */

export type ScreenShareRoomCredentials = {
  code: string;
  secret: string;
  secretHash: string;
};

export type ScreenSharePeerCredentials = {
  signalingCode: string;
  signalingToken: string;
  sessionProof?: string;
  /** 只有还没有 proof 的首次连接才带静态摘要。 */
  sessionSecretHash?: string;
};

export const createScreenSharePeerCredentials = (
  room: ScreenShareRoomCredentials,
  sessionProof: string | null | undefined
): ScreenSharePeerCredentials => {
  const base = { signalingCode: room.code, signalingToken: room.secret };
  if (sessionProof) {
    return { ...base, sessionProof };
  }
  return { ...base, sessionSecretHash: room.secretHash };
};

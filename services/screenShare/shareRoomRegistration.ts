/**
 * 屏幕共享房号的服务端登记。
 *
 * 旧实现是客户端自造 `AERO-` + 6 位 base36，不经 `/api/share-code`：没有 TTL、
 * 不能撤销、可以被枚举，而且和文件传输的身份模型（HMAC + TTL + 撤销）不一致。
 * 现在房号复用同一套登记：先定随机 peerId，再向 `/api/share-code` 领取 6 位数字
 * 口令与 secret，信令 WS 带着 code+token 注册；观众链接语义仍是 `?view=<peerId>`。
 *
 * 结束分享时注销；注销失败也只会活到 TTL 上限，不会永久占用。
 */

import { SCREEN_SHARE_ROOM_TTL_SECONDS } from '../../constants/transfer.ts';
import { requestShareCode, revokeShareSession } from '../shareCodeSession.ts';

export type ScreenShareRoom = {
  peerId: string;
  code: string;
  secret: string;
  secretHash: string;
  expiresAt: number;
};

export type ScreenShareRoomFailure = { status: 'failed'; message: string };

export type ScreenShareRoomRegistration =
  | { status: 'ok'; room: ScreenShareRoom }
  | ScreenShareRoomFailure;

const PEER_ID_PREFIX = 'AERO-';
// 9 字节 → 18 位 hex（72 bit）：可枚举性远低于旧的 6 位 base36（约 31 bit）。
const PEER_ID_ENTROPY_BYTES = 9;

/** 纯函数：把熵字节格式化成服务端接受的 peerId（`^[A-Za-z0-9_-]{8,128}$`）。 */
export const formatScreenSharePeerId = (entropy: Uint8Array): string => {
  const hex = Array.from(entropy, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${PEER_ID_PREFIX}${hex}`;
};

export const createScreenSharePeerId = (): string => {
  const entropy = new Uint8Array(PEER_ID_ENTROPY_BYTES);
  crypto.getRandomValues(entropy);
  return formatScreenSharePeerId(entropy);
};

/** 登记失败也要给出可操作文案：限流/占用/网络三种原因不能都说成「重试」。 */
export const describeScreenShareRoomFailure = (status: string): string => {
  switch (status) {
    case 'taken':
      return '共享房间号已被占用，请重新开始共享';
    case 'rate-limited':
      return '创建共享房间过于频繁，请稍后再试';
    default:
      return '共享房间登记失败，请检查网络后重试';
  }
};

export const registerScreenShareRoom = async (input?: {
  peerId?: string;
}): Promise<ScreenShareRoomRegistration> => {
  const peerId = input?.peerId ?? createScreenSharePeerId();
  const result = await requestShareCode({
    peerId,
    ttlSeconds: SCREEN_SHARE_ROOM_TTL_SECONDS,
  });

  if (result.status !== 'ok') {
    return { status: 'failed', message: describeScreenShareRoomFailure(result.status) };
  }

  return {
    status: 'ok',
    room: {
      peerId,
      code: result.code,
      secret: result.secret,
      secretHash: result.secretHash,
      expiresAt: result.expiresAt,
    },
  };
};

/**
 * 续期：同 peerId + 同 secret + 同口令重新登记只延长过期时间，不换码、不改绑定，
 * 所以已发出去的链接在长时间分享里仍然有效。
 */
export const renewScreenShareRoom = async (room: ScreenShareRoom): Promise<boolean> => {
  const result = await requestShareCode({
    peerId: room.peerId,
    requestedCode: room.code,
    ttlSeconds: SCREEN_SHARE_ROOM_TTL_SECONDS,
    secret: room.secret,
  });
  return result.status === 'ok';
};

/** 停止分享/终态失败时撤销房号；失败按已失效处理，不让注销异常影响本地收尾。 */
export const revokeScreenShareRoom = async (
  room: ScreenShareRoom | null | undefined,
): Promise<boolean> => {
  if (!room) return false;
  try {
    return await revokeShareSession({
      code: room.code,
      peerId: room.peerId,
      secret: room.secret,
    });
  } catch {
    return false;
  }
};

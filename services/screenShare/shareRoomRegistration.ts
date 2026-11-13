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

/** 登记失败原因：重试策略与文案都按它分流，不再一律当成「网络不可达」。 */
export type ScreenShareRoomFailureReason = 'taken' | 'rate-limited' | 'failed';

export type ScreenShareRoomFailure = {
  status: 'failed';
  reason: ScreenShareRoomFailureReason;
  message: string;
  /** 429 时服务端给的冷却时间（其它原因没有）。 */
  retryAfterMs?: number;
};

export type ScreenShareRoomRegistration =
  | { status: 'ok'; room: ScreenShareRoom }
  | ScreenShareRoomFailure;

const toFailureReason = (status: string): ScreenShareRoomFailureReason => {
  switch (status) {
    case 'taken':
      return 'taken';
    case 'rate-limited':
      return 'rate-limited';
    default:
      return 'failed';
  }
};

/**
 * 限流是服务端明确的「现在不给」：重试只会继续吃 429，调用方必须直接进终态。
 * taken 还能换一个随机 peerId 自愈，failed 可能只是网络抖动，两者交给退避重试。
 */
export const isTerminalScreenShareRoomFailure = (
  reason: ScreenShareRoomFailureReason,
): boolean => reason === 'rate-limited';

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
    return {
      status: 'failed',
      reason: toFailureReason(result.status),
      message: describeScreenShareRoomFailure(result.status),
      ...(result.status === 'rate-limited' ? { retryAfterMs: result.retryAfterMs } : {}),
    };
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

/**
 * 页面正在卸载（刷新/关标签/跳走）时的撤销。
 *
 * 这条路径上没人等返回值，普通 fetch 会被文档销毁直接取消，房号就一直活到 TTL，
 * 旧链接在 24 小时内仍能被别人打开。keepalive 让请求越过页面卸载继续发出；
 * 正常停止分享仍走 revokeScreenShareRoom（能拿到结果、能重试）。
 */
export const revokeScreenShareRoomBeacon = (
  room: ScreenShareRoom | null | undefined,
): boolean => {
  if (!room) return false;
  try {
    void fetch(`/api/share-code/${encodeURIComponent(room.code)}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: room.peerId, secretHash: room.secretHash }),
      keepalive: true,
      cache: 'no-store',
    }).catch(() => false);
    return true;
  } catch {
    return false;
  }
};

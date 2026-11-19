/**
 * 房间成员身份帧（昵称 + 头像）。
 *
 * 走已经存在的 `aero-room` DataChannel，形状为 `{ type: 'peer-profile', name, avatar }`，
 * 和聊天文本（带 `text`）、共享控制帧（share-*）互不冲突。
 *
 * 安全边界：接收方始终用真实的 `conn.peer` 作为该身份的键；`name`/`avatar` 只用于显示，
 * 不参与身份校验、权限或聊天去重。
 */
import { DEFAULT_AVATAR, isProfileAvatar, sanitizeProfileName } from '../profile/localProfile';

export const PEER_PROFILE_MESSAGE_TYPE = 'peer-profile';

export interface DisplayProfile {
  name: string;
  avatar: string;
}

export interface PeerProfileMessage extends DisplayProfile {
  type: typeof PEER_PROFILE_MESSAGE_TYPE;
}

export function isPeerProfileMessage(value: unknown): value is PeerProfileMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === PEER_PROFILE_MESSAGE_TYPE &&
    typeof record.name === 'string' &&
    typeof record.avatar === 'string'
  );
}

/** 校验并清洗对端身份；名字为空视为无效帧。 */
export function sanitizePeerProfile(value: unknown): DisplayProfile | null {
  if (!isPeerProfileMessage(value)) return null;
  const name = sanitizeProfileName(value.name, '');
  if (!name) return null;
  return {
    name,
    avatar: isProfileAvatar(value.avatar) ? value.avatar : DEFAULT_AVATAR,
  };
}

export function createPeerProfileMessage(profile: DisplayProfile): PeerProfileMessage {
  return {
    type: PEER_PROFILE_MESSAGE_TYPE,
    name: sanitizeProfileName(profile.name, '访客') || '访客',
    avatar: isProfileAvatar(profile.avatar) ? profile.avatar : DEFAULT_AVATAR,
  };
}
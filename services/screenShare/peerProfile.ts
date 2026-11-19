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

export const PEER_PROFILE_LIST_MESSAGE_TYPE = 'peer-profile-list';

/**
 * 房主在身份上被信任：这里只限制帧大小/条目数，避免恶意房主用超大映射撑爆内存。
 * 键是真实 conn.peer（不是可伪造的显示名），长度上限只防御异常信令。
 */
export const PEER_PROFILE_LIST_MAX_ENTRIES = 64;
export const PEER_PROFILE_LIST_MAX_KEY_LENGTH = 128;

/**
 * 房主汇总的成员身份映射帧：`{ type: 'peer-profile-list', profiles: { [peerId]: {name,avatar} } }`。
 * 键必须是对端真实的 `conn.peer`（房主从信令来源取得），名字/头像只用于显示。
 */
export interface PeerProfileListMessage {
  type: typeof PEER_PROFILE_LIST_MESSAGE_TYPE;
  profiles: Record<string, DisplayProfile>;
}

export function isPeerProfileListMessage(value: unknown): value is PeerProfileListMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === PEER_PROFILE_LIST_MESSAGE_TYPE &&
    !!record.profiles &&
    typeof record.profiles === 'object' &&
    !Array.isArray(record.profiles)
  );
}

/** 校验并清洗房主广播的成员映射；坏条目（空键、空名）直接丢弃，非法头像回落默认。 */
export function sanitizePeerProfileMap(value: unknown): Record<string, DisplayProfile> {
  if (!isPeerProfileListMessage(value)) return {};
  const out: Record<string, DisplayProfile> = {};
  let count = 0;
  for (const [peerId, raw] of Object.entries(value.profiles)) {
    if (count >= PEER_PROFILE_LIST_MAX_ENTRIES) break;
    if (!peerId || peerId.length > PEER_PROFILE_LIST_MAX_KEY_LENGTH) continue;
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as unknown as Record<string, unknown>;
    const name = sanitizeProfileName(entry.name, '');
    if (!name) continue;
    out[peerId] = {
      name,
      avatar: isProfileAvatar(entry.avatar) ? entry.avatar : DEFAULT_AVATAR,
    };
    count += 1;
  }
  return out;
}

export function createPeerProfileListMessage(
  profiles: Record<string, DisplayProfile>
): PeerProfileListMessage {
  return {
    type: PEER_PROFILE_LIST_MESSAGE_TYPE,
    profiles: sanitizePeerProfileMap({ type: PEER_PROFILE_LIST_MESSAGE_TYPE, profiles }),
  };
}
/** 把本机身份补进成员映射（房主广播时用）；selfPeerId 为空时返回副本。 */
export function withSelfProfile(
  profiles: Record<string, DisplayProfile>,
  selfPeerId: string | null,
  selfProfile: DisplayProfile
): Record<string, DisplayProfile> {
  if (!selfPeerId) return { ...profiles };
  return { ...profiles, [selfPeerId]: selfProfile };
}

/** 把一个真实 conn.peer 的身份写入映射（不修改原对象）。 */
export function mergePeerProfile(
  profiles: Record<string, DisplayProfile>,
  peerId: string,
  profile: DisplayProfile
): Record<string, DisplayProfile> {
  return { ...profiles, [peerId]: profile };
}

/** 删除已断开的成员；未命中时也返回新对象，保证 React 状态一定刷新。 */
export function removePeerProfile(
  profiles: Record<string, DisplayProfile>,
  peerId: string
): Record<string, DisplayProfile> {
  const next = { ...profiles };
  delete next[peerId];
  return next;
}
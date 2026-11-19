/**
 * 本机身份（昵称 + 预设头像）。
 *
 * 只做「呈现层」身份：数据存在本机 localStorage，不参与任何 peer 身份校验。
 * 房间内聊天去重/限流仍以真实 `conn.peer` 为准（见 services/chat/chatCore.ts）。
 */

/** localStorage 键。首版直接覆盖写入，不做旧版迁移。 */
export const LOCAL_PROFILE_STORAGE_KEY = 'aerodrop.profile.v2';

/** 预设头像（与原型一致的 12 个 emoji）。 */
export const PROFILE_AVATARS = [
  '🐟',
  '🦊',
  '🐼',
  '🐯',
  '🐳',
  '🦉',
  '🐧',
  '🦄',
  '🐙',
  '🦁',
  '🐨',
  '🐸',
] as const;

export const DEFAULT_AVATAR: string = PROFILE_AVATARS[0];

/** 昵称最大长度（与原型 input maxlength 一致）。 */
export const PROFILE_NAME_MAX_LENGTH = 16;

const GUEST_NAME_PREFIX = '访客-';

export interface LocalProfile {
  name: string;
  avatar: string;
}

/** 生成 4 位随机访客名，例如「访客-0000」。允许重名。 */
export function createGuestName(random: () => number = Math.random): string {
  const value = Math.floor(random() * 10000);
  return `${GUEST_NAME_PREFIX}${String(value).padStart(4, '0')}`;
}

export function isProfileAvatar(value: unknown): value is string {
  return typeof value === 'string' && (PROFILE_AVATARS as readonly string[]).includes(value);
}

/** 昵称规整：trim + 截断到 16 字；空串回退到给定名字。 */
export function sanitizeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, PROFILE_NAME_MAX_LENGTH);
  return trimmed || fallback;
}

/** 把 localStorage 里读到的任意值规整成合法身份；非法时回退访客名 + 默认头像。 */
export function normalizeProfile(value: unknown, fallbackName: string): LocalProfile {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const rawAvatar = record?.avatar;
  return {
    name: sanitizeProfileName(record?.name, fallbackName),
    avatar: isProfileAvatar(rawAvatar) ? rawAvatar : DEFAULT_AVATAR,
  };
}
/**
 * 本机身份的全局 store（useSyncExternalStore）。
 *
 * 组件树多处需要「同一个身份」：标题栏 chip、聊天里自己的消息、语音成员列表。
 * 用一个模块级 store + localStorage 持久化，避免各组件各读一份导致不同步。
 */
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_AVATAR,
  LOCAL_PROFILE_STORAGE_KEY,
  createGuestName,
  isProfileAvatar,
  normalizeProfile,
  sanitizeProfileName,
  type LocalProfile,
} from './localProfile';

interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const getStorage = (): ProfileStorage | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    // 隐私模式 / 被策略禁用时 localStorage 访问会抛错，降级为纯内存。
    return null;
  }
};

// 未设置身份时，会话内固定同一个访客名，避免每次重渲染漂移。
let guestFallback: string | null = null;
const getGuestFallback = (): string => (guestFallback ??= createGuestName());

let cached: LocalProfile | null = null;
const listeners = new Set<() => void>();

const readFromStorage = (): LocalProfile => {
  const storage = getStorage();
  let raw: string | null = null;
  try {
    raw = storage?.getItem(LOCAL_PROFILE_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  return normalizeProfile(parsed, getGuestFallback());
};

/** 稳定快照：引用不变，满足 useSyncExternalStore 的缓存要求。 */
export function getLocalProfileSnapshot(): LocalProfile {
  if (!cached) cached = readFromStorage();
  return cached;
}

export function setLocalProfile(next: LocalProfile): LocalProfile {
  const normalized: LocalProfile = {
    name: sanitizeProfileName(next.name, getGuestFallback()),
    avatar: isProfileAvatar(next.avatar) ? next.avatar : DEFAULT_AVATAR,
  };
  cached = normalized;
  const storage = getStorage();
  try {
    storage?.setItem(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // 配额不足/被禁用：内存里仍然生效，只是不落盘。
  }
  listeners.forEach((listener) => listener());
  return normalized;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocalProfile(): {
  profile: LocalProfile;
  setProfile: (next: LocalProfile) => void;
} {
  const profile = useSyncExternalStore(
    subscribe,
    getLocalProfileSnapshot,
    getLocalProfileSnapshot,
  );
  return { profile, setProfile: setLocalProfile };
}

/** 仅测试用：清空内存缓存（不触碰 localStorage）。 */
export function __resetLocalProfileCacheForTests(): void {
  cached = null;
  guestFallback = null;
}
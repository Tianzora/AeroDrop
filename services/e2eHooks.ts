import type { IceConfigResult } from './stunService';

export interface AeroDropPeerRuntimeModuleLike {
  default: new (...args: any[]) => unknown;
}

export interface AeroDropShareCodeOverride {
  code: string;
  expiresAt: number;
}

export interface AeroDropE2EHooks {
  getIceConfigOverride?: () => IceConfigResult;
  createPeerRuntimeModule?: () => Promise<AeroDropPeerRuntimeModuleLike> | AeroDropPeerRuntimeModuleLike;
  // 口令服务需要 Worker；E2E 在 vite preview 下没有 Worker，用这两个钩子替代。
  createShareCodeOverride?: (input: {
    peerId: string;
    secretHash: string;
    code?: string;
  }) => AeroDropShareCodeOverride | null;
  resolveShareCodeOverride?: (code: string) => { peerId: string; expiresAt: number } | null;
}

export const getAeroDropE2EHooks = (): AeroDropE2EHooks | null => {
  // Test-only entry point: `preview:e2e` builds with `--mode e2e`, while production
  // bundles report MODE=production, so these hooks stay unreachable there and the
  // `__AERODROP_E2E__` global cannot swap the peer runtime or the ICE config.
  if (import.meta.env?.MODE !== 'e2e') {
    return null;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  const hooks = (window as Window & { __AERODROP_E2E__?: AeroDropE2EHooks }).__AERODROP_E2E__;
  return hooks ?? null;
};

/**
 * 屏幕共享会话凭证（sessionProof）的落盘位置。
 *
 * proof 只在 `registered` 帧里下发，PeerRuntime 存在实例内存里；屏幕共享重建 peer 时
 * 是**新建实例**，于是重建只有静态摘要。服务端的静态摘要窗口只给首次绑定开一次，过了
 * 就只认 proof：重建必然 4010，分享终态、房号被撤、已发链接全废。这里把最近一次
 * proof 按房号的 peerId 存进 sessionStorage，重建时传回去。
 *
 * 存 sessionStorage 而不是内存：刷新/前进后退后同一个标签页里仍能接上同一房号。
 */

const KEY_PREFIX = 'aerodrop:screen-share:session-proof:';

export type ProofStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const keyFor = (peerId: string): string => `${KEY_PREFIX}${peerId}`;

const resolveStorage = (storage: ProofStorage | null | undefined): ProofStorage | null => {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 隐私模式/被策略禁用时访问 sessionStorage 会抛：没有落盘也不能影响共享本身。
    return null;
  }
};

export const rememberSessionProof = (
  peerId: string,
  proof: string,
  storage?: ProofStorage | null
): boolean => {
  const target = resolveStorage(storage);
  if (!target || !peerId || !proof) return false;
  try {
    target.setItem(keyFor(peerId), proof);
    return true;
  } catch {
    return false;
  }
};

export const recallSessionProof = (
  peerId: string,
  storage?: ProofStorage | null
): string | null => {
  const target = resolveStorage(storage);
  if (!target || !peerId) return null;
  try {
    const proof = target.getItem(keyFor(peerId));
    return typeof proof === 'string' && proof.length > 0 ? proof : null;
  } catch {
    return null;
  }
};

/** 停止分享、进入终态或房号被撤销时必须清掉：旧 proof 对新房号没有意义，留着只是残留凭证。 */
export const forgetSessionProof = (peerId: string, storage?: ProofStorage | null): void => {
  const target = resolveStorage(storage);
  if (!target || !peerId) return;
  try {
    target.removeItem(keyFor(peerId));
  } catch {
    // 同上：清理失败不该打断停止流程。
  }
};

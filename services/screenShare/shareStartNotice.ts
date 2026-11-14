/**
 * 「屏幕共享已开始」提示的时机。
 *
 * 采集一拿到流就弹「已开始」是在骗人：房号还在登记、信令还没 open，观众此刻打不开
 * 链接。文案必须等信令真正 ready 之后才产出，而且只产出一次——后续的
 * 'signaling:restored' 不是「开始」，是「恢复」。
 */

export interface ShareStartNotice {
  /** 采集成功后记下这次分享的音频后缀，等 ready 再拼文案。 */
  queue(suffix: string): void;
  /** 分享结束/失败时丢弃，避免下一次分享里冒出一条上一轮的提示。 */
  clear(): void;
  /** 只在 ready 时调用；没有待发提示时返回 null，因此可以安全地重复调用。 */
  takeOnReady(): string | null;
}

export const createShareStartNotice = (): ShareStartNotice => {
  let pending: string | null = null;
  return {
    queue(suffix: string) {
      pending = suffix;
    },
    clear() {
      pending = null;
    },
    takeOnReady() {
      if (pending === null) return null;
      const suffix = pending;
      pending = null;
      return `屏幕共享已开始${suffix}`;
    },
  };
};

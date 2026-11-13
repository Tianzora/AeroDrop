/**
 * 接管时「出口 IP 会话席位」的归属决策。
 *
 * 席位计数放在 `SignalingSessionLimiter`（每 clientKey 一个计数）。同 clientKey 的接管
 * 只是把席位上挂的 socket 换掉，不改变计数；如果沿用「先 release 再 tryAcquire」的写法，
 * tryAcquire 失败时计数会少 1，而且失败路径提前 return，旧 socket 也不会被关闭。
 *
 * 把这个决策单独拎出来，是为了让「转移 vs 新领」在测试里可断言，而不是埋在
 * fetch 的 if 里。
 */

export type SignalingSessionSeatPlan =
  /** 席位从旧 socket 转移过来：不 release、不 tryAcquire。 */
  | { kind: 'transfer' }
  /** 需要新领一个席位（不同出口 IP 的接管或全新连接）。 */
  | { kind: 'acquire' };

export const planSignalingSessionSeat = (input: {
  isTakeover: boolean;
  existingClientKey?: string | null;
  clientKey: string;
}): SignalingSessionSeatPlan =>
  input.isTakeover && input.existingClientKey === input.clientKey
    ? { kind: 'transfer' }
    : { kind: 'acquire' };

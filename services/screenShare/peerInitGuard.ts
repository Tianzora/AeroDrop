/**
 * 单飞闸门：同一时刻只放行一次异步初始化。
 *
 * 屏幕共享的 initializePeer 有三处触发：开始共享、首连看门狗、恢复 effect 的退避计时器。
 * 弱网下单次初始化（拉 ICE 配置 + 服务端登记房号 + 建 peer）会超过看门狗/退避间隔，
 * 于是同一时刻会有第二次调用。并发调用各自登记房号，后到者覆盖 shareRoomRef，
 * 先到者的房号从此没人撤销：白占 24 小时 TTL，还消耗同 IP 的 /api/share-code 预算
 * （会让限流提前命中，把可用的分享打成终态）。
 *
 * 语义选择：已在飞时直接放弃这一次，不排队。初始化是幂等的重建动作，排队只会在
 * 慢网络下堆出一串重复登记；在飞那次的失败会自己唤醒恢复流程。
 */

export type SingleFlight = {
  isInFlight(): boolean;
  /** 抢到闸门返回 true；已有调用在飞返回 false（调用方应放弃这一次）。 */
  tryEnter(): boolean;
  /** 释放闸门。必须在 finally 里调用，任何失败路径都不能把后续重试永久锁死。 */
  leave(): void;
  /**
   * 已经占着闸门超过 maxHoldMs。等待本身有超时兜底，恒为 true 只可能意味着
   * 某条路径绕过了兜底：此时调用方可以弃用这个对象再换一个新的，别让整个分享卡死。
   */
  isStale(now: number, maxHoldMs: number): boolean;
};

export const createSingleFlight = (): SingleFlight => {
  let enteredAt: number | null = null;
  return {
    isInFlight: () => enteredAt !== null,
    tryEnter: () => {
      if (enteredAt !== null) return false;
      enteredAt = Date.now();
      return true;
    },
    leave: () => {
      enteredAt = null;
    },
    isStale: (now, maxHoldMs) => enteredAt !== null && now - enteredAt > maxHoldMs,
  };
};

/**
 * 闸门的持有者。会话收尾（停止分享、终态失败）必须 `reset()` 换一个新闸门：
 * 直接清掉旧闸门的占位会让「还在飞的那次初始化」和「新会话的初始化」共用一个对象，
 * 旧调用结束时 leave() 会把新会话刚抢到的闸门放掉，并发登记又回来了；
 * 而不换新对象的话，新会话的 initializePeer 只会在闸门处拿到 false 被静默丢弃
 * ——用户点了「停止 → 立刻再开始」，界面就停在「正在连接服务器」。
 */
export type SingleFlightSlot = {
  current(): SingleFlight;
  /** 换一个新闸门；旧调用结束时的 leave() 只影响它自己那一个。 */
  reset(): SingleFlight;
};

export const createSingleFlightSlot = (): SingleFlightSlot => {
  let flight = createSingleFlight();
  return {
    current: () => flight,
    reset: () => {
      flight = createSingleFlight();
      return flight;
    },
  };
};

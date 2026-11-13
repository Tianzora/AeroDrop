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
};

export const createSingleFlight = (): SingleFlight => {
  let inFlight = false;
  return {
    isInFlight: () => inFlight,
    tryEnter: () => {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    leave: () => {
      inFlight = false;
    },
  };
};

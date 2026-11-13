/**
 * 一次信令注册的「动作序列」决策。
 *
 * `SignalingHub.fetch` 里原本把判定、领名额、驱逐旧 socket、发 `registered`、落库
 * 混在一段 if 里，评审的结论是这段编排层零测试（名额释放/冲突拒绝的顺序只能靠人读）。
 * 这里把顺序抽成纯函数：输入是判定结果（谁先占位），输出是有序动作，fetch 只负责
 * 逐条执行。三条顺序不变量因此可以在单测里断言：
 *
 * 1. 冲突拒绝必须排在任何名额动作之前——被拒的连接不能领走会话名额，也不能改
 *    `sessionsByPeer` 把对方挤成幽灵连接。
 * 2. 席位（进程内 limiter）与分片全局槽位都在驱逐旧 socket 之前领：领不到就直接
 *    拒绝，旧连接保持存活（半接管会让双方都没有可用连接）。
 * 3. `send-registered` 必须早于 `commit-binding`：proof 明文只在帧里下发一次，
 *    先落库会让「帧丢了」变成客户端永久 4010。
 *
 * 上限判定本身仍然只有一处（`SignalingSessionLimiter.tryAcquire` / shard 0 的全局
 * 名额表）。plan 只编码顺序，不预判名额，避免 check-then-act 漂移。
 */

import type { SignalingSessionSeatPlan } from './sessionSeat';
import { SIGNALING_BINDING_UNAVAILABLE_RETRY_AFTER_SECONDS } from '../../constants/signaling';

// 常量唯一来源在 constants/signaling.ts；re-export 保持既有测试导入路径。
export { SIGNALING_BINDING_UNAVAILABLE_RETRY_AFTER_SECONDS };

export type SignalingRegistrationAction =
  /** 拒绝本次注册：`identity` 是绑定判定拒绝，`race` 是并发抢占输给了后来的连接。 */
  | { kind: 'reject-conflict'; reason: 'identity' | 'race' }
  /** 分片模式下向 shard 0 领全局会话名额。 */
  | { kind: 'reserve-global-slot' }
  /** 领（或从旧 socket 转移）进程内会话席位。 */
  | { kind: 'reserve-seat'; mode: SignalingSessionSeatPlan['kind'] }
  /** 关掉被接管的旧 socket（在名额都到手之后）。 */
  | { kind: 'eject-existing' }
  /** 投递 `registered`（可能带新 proof）。 */
  | { kind: 'send-registered' }
  /** 把 `registered` 里下发的新 proof 落库（由投递助手与上一步成对执行）。 */
  | { kind: 'commit-binding' };

export type SignalingSessionRace = 'none' | 'same' | 'different';

/**
 * 判定 `await` 之后 `sessionsByPeer` 里的 socket 还是不是我们做判定时看到的那个。
 *
 * 绑定判定（分片模式下是回源 RPC）会让出事件循环；两个新连接并发注册同一 peerId 时
 * 都可能看到「没有现存连接」，从而都认为自己是首个连接。后写入的那个会把先写入的
 * socket 从 map 里顶掉，但那个 socket 已经收到了 `registered`、仍挂在 DO 上——幽灵连接
 * 就是这么来的。所以落定前重读一次，赢家之外的那条按冲突拒绝。
 */
export const classifySignalingSessionRace = <TSocket>(input: {
  planned: TSocket | undefined;
  current: TSocket | undefined;
}): SignalingSessionRace => {
  if (input.current === undefined) return 'none';
  return input.current === input.planned ? 'same' : 'different';
};

export const planSignalingRegistration = (input: {
  /** 做判定时 `sessionsByPeer` 里是否有别的 socket。 */
  existingSession: 'none' | 'takeover';
  /** 落定前重读的结果（见 classifySignalingSessionRace）。 */
  race: SignalingSessionRace;
  admission: 'allowed' | 'rejected';
  seat: SignalingSessionSeatPlan;
  shardCount: number;
  /** 本次 admission 是否签发了待落库的 proof 轮换。 */
  pendingRotation: boolean;
}): SignalingRegistrationAction[] => {
  // 先判并发再判身份：输了竞争的连接不该再因为身份判定而多占一次「先到者优先」的语义。
  if (input.race === 'different') return [{ kind: 'reject-conflict', reason: 'race' }];
  if (input.admission === 'rejected') return [{ kind: 'reject-conflict', reason: 'identity' }];

  const actions: SignalingRegistrationAction[] = [];
  // 单例 DO 的「每客户端 12 会话」由进程内 limiter 计；分片模式必须回源 shard 0 的全局表。
  if (input.shardCount > 1) actions.push({ kind: 'reserve-global-slot' });
  actions.push({ kind: 'reserve-seat', mode: input.seat.kind });
  if (input.existingSession === 'takeover') actions.push({ kind: 'eject-existing' });
  actions.push({ kind: 'send-registered' });
  if (input.pendingRotation) actions.push({ kind: 'commit-binding' });
  return actions;
};

/**
 * 绑定权威副本（shard 0）回源失败时 WS 升级的 `Retry-After`（秒）。
 *
 * 升级失败必须发生在 accept 之前：先 accept 再发 error 会让客户端看到一条已建立的
 * 连接，且服务端没有名额可回收，只能等对端超时。客户端按 Retry-After 退避重连。
 */

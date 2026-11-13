import type { SignalingRegistrationAction } from './registrationPlan';

/**
 * 注册动作的执行结果：要么在某个动作上提前返回一条 101/503 响应，
 * 要么所有动作都跑完、返回正常的 101 升级响应（由调用方构造）。
 */
export type RegistrationExecution =
  | { kind: 'respond'; response: Response }
  | { kind: 'done' };

/**
 * 执行注册动作序列所需的副作用端口。
 *
 * 顺序本身由 `planSignalingRegistration` 决定（纯函数、有单测）；这里只负责「按顺序把每个
 * 动作翻译成一次副作用调用」。把这些副作用抽成端口，是为了让「名额领取失败要不要回滚」
 * 「竞争判定之后还能不能驱逐旧 socket」这类只有真实时序才暴露的规则可被单测钉住——
 * 之前它们住在一个 200 行的 DO 方法里，任何回归都不会有测试变红。
 */
export interface RegistrationExecutionPorts {
  /** 给新连接回 session-conflict 终态并关闭（旧会话保持服务）。 */
  rejectConflict(): Promise<Response>;
  /**
   * 领取全局会话名额（分片模式才存在）。返回槽位 id 表示成功，返回 null 表示满额。
   * 实现需要自己记录 `signal_session_slot_rejected` 之类的指标：端口只管结果。
   */
  reserveGlobalSlot(): Promise<string | null>;
  /** 领取本实例的会话席位；false 表示这个出口 IP 已满。 */
  acquireSeat(): boolean;
  /** 把已经领到的名额还回去（槽位 + 席位），供失败与竞争路径复用。 */
  rollbackQuota(): Promise<void>;
  /**
   * 在每次 await 之后重读会话表：如果同一 peerId 已经被别的连接落定，回滚名额并返回
   * 一条 101 冲突响应；没有竞争返回 null。实现内部负责回滚。
   */
  rejectRaced(): Promise<Response | null>;
  /** 驱逐同 peerId 的旧 socket（发 unavailable-id + close 4011）。实现自己吞掉发送/关闭异常。 */
  ejectExisting(): void;
  /** 写会话表/attachment，投递 registered 帧，并在投递成功后落库轮换后的 proof。 */
  sendRegistered(): Promise<void>;
  /** 名额满：发 rate-limited 终态并关闭，返回 101 响应。 */
  sendRateLimited(): Response;
}

export const executeRegistrationPlan = async (
  actions: readonly SignalingRegistrationAction[],
  ports: RegistrationExecutionPorts
): Promise<RegistrationExecution> => {
  for (const action of actions) {
    switch (action.kind) {
      case 'reject-conflict': {
        return { kind: 'respond', response: await ports.rejectConflict() };
      }
      case 'reserve-global-slot': {
        const slotId = await ports.reserveGlobalSlot();
        if (slotId === null) {
          return { kind: 'respond', response: ports.sendRateLimited() };
        }
        const raced = await ports.rejectRaced();
        if (raced) return { kind: 'respond', response: raced };
        break;
      }
      case 'reserve-seat': {
        // transfer：席位此刻记在旧 socket 上，接管逻辑会把它从 clientBySocket 摘除，
        // 所以这里既不 acquire 也不 release。
        if (action.mode !== 'acquire') break;
        if (!ports.acquireSeat()) {
          await ports.rollbackQuota();
          return { kind: 'respond', response: ports.sendRateLimited() };
        }
        const raced = await ports.rejectRaced();
        if (raced) return { kind: 'respond', response: raced };
        break;
      }
      case 'eject-existing': {
        // 驱逐是不可逆的：先确认没有竞争，再动旧 socket。反过来的话，竞争失败的连接会
        // 把正在服务的旧会话踢掉，自己又退回冲突，双方都没人服务。
        const raced = await ports.rejectRaced();
        if (raced) return { kind: 'respond', response: raced };
        ports.ejectExisting();
        break;
      }
      case 'send-registered': {
        const raced = await ports.rejectRaced();
        if (raced) return { kind: 'respond', response: raced };
        await ports.sendRegistered();
        break;
      }
      case 'commit-binding':
        // 与 send-registered 成对：顺序契约只住在 sendRegistered 的实现里
        // （先投递 registered、成功后才落库），这里不再排一次。
        break;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }
  return { kind: 'done' };
};

/**
 * 发送页状态行的「运维提示」优先级。
 *
 * senderSession 在信令已失效但仍有在途传输时不会跳错误页，只往状态行写一句
 * 「分享已失效，进行中的传输不受影响，新设备无法加入」。但同一个位置每 3 秒会被
 * 连接数统计覆盖（「已连接 N 个设备」），没有优先级时那句提示最多活 3 秒，
 * 用户等于看不到。
 *
 * 于是状态行的两个写入方各自走一条入口：会话层用 announce（带存活窗口），
 * 连接数轮询用 routine（窗口内不写）。判定集中在这里，组件里不再散落 if。
 * 窗口过期后不需要定时器：下一次 routine 写入自然接管。
 */

export type ConnectionStatusNotice = { readonly text: string; readonly expiresAt: number };

/** 状态行更新结果：apply 为 false 表示这条写入应被忽略（提示窗口内）。 */
export type ConnectionStatusUpdate = { readonly apply: boolean; readonly status: string };

/** 提示存活窗口：够用户读完，又不至于长期压住真实的连接数。 */
export const CONNECTION_STATUS_NOTICE_MS = 30_000;

/** 记录一条运维提示；窗口从这里开始算。 */
export const createConnectionStatusNotice = (
  text: string,
  now: number,
): ConnectionStatusNotice => ({
  text,
  expiresAt: now + CONNECTION_STATUS_NOTICE_MS,
});

/** 提示是否仍在有效窗口内（恰好在 expiresAt 时刻算过期，让常规统计接管）。 */
export const isConnectionStatusNoticeActive = (
  notice: ConnectionStatusNotice | null | undefined,
  now: number,
): boolean => notice != null && now < notice.expiresAt;

/** 常规统计（连接数轮询）现在能不能写状态行。 */
export const shouldApplyRoutineConnectionStatus = (
  notice: ConnectionStatusNotice | null | undefined,
  now: number,
): boolean => !isConnectionStatusNoticeActive(notice, now);

/** 状态行最终文案：窗口内提示优先，否则用常规统计值。 */
export const resolveConnectionStatus = (
  notice: ConnectionStatusNotice | null | undefined,
  routineStatus: string,
  now: number,
): string => (isConnectionStatusNoticeActive(notice, now) ? notice!.text : routineStatus);

export type ConnectionStatusController = {
  /** 会话层入口。空字符串表示恢复（open/resume/start/stop），同时清掉窗口。 */
  announce(text: string, now: number): ConnectionStatusUpdate;
  /** 常规统计入口。窗口内返回 apply=false，调用方应保持当前状态行不动。 */
  routine(status: string, now: number): ConnectionStatusUpdate;
  isNoticeActive(now: number): boolean;
};

/**
 * 状态行控制器：组件把它放进 ref，两个写入方都只调用它。
 * 有状态是为了让「窗口」跟着会话走，而不是每次渲染重算。
 */
export const createConnectionStatusController = (): ConnectionStatusController => {
  let notice: ConnectionStatusNotice | null = null;
  return {
    announce(text, now) {
      if (!text) {
        notice = null;
        return { apply: true, status: '' };
      }
      notice = createConnectionStatusNotice(text, now);
      return { apply: true, status: notice.text };
    },
    routine(status, now) {
      if (isConnectionStatusNoticeActive(notice, now)) {
        return { apply: false, status: notice!.text };
      }
      return { apply: true, status };
    },
    isNoticeActive: (now) => isConnectionStatusNoticeActive(notice, now),
  };
};

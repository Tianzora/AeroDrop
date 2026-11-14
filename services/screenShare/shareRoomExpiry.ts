/**
 * 房号过期看门狗的排期。
 *
 * 旧实现是每 60s 轮询一次「现在过期了吗」：房号恰好在下个整分前 1 秒过期，界面就
 * 最多还有 59s 挂着绿色「正在共享」和一条已经作废的链接。一次性定时器直接对齐到
 * expiresAt 本身，过期那一刻就翻转，续期成功（expiresAt 变远）时由调用方重新排期。
 */

export interface ShareRoomExpirySchedule {
  /** 距离 expiresAt 还有多久；已经过期返回 0（调用方应立即翻转）。 */
  delayMs: number;
  expiresAt: number;
}

export const planShareRoomExpiryCheck = (
  room: { expiresAt: number },
  now: number,
): ShareRoomExpirySchedule | null => {
  if (!Number.isFinite(room.expiresAt)) return null;
  const remaining = room.expiresAt - now;
  return { delayMs: remaining > 0 ? remaining : 0, expiresAt: room.expiresAt };
};

/**
 * `registered` 帧与 proof 轮换落库的先后顺序。
 *
 * proof 明文只在 `registered` 里下发一次。如果先落库再发帧，帧一旦丢失（socket 抖动、
 * 页面挂起），客户端手里就只有旧 proof；旧 proof 超出 `SESSION_PROOF_GRACE_MS` 后
 * 每次重连都会被判 4010 终态，而且没有任何自愈路径。
 *
 * 所以顺序固定为「先投递、后落库」：投递失败就不落库（客户端没拿到新 proof，服务端
 * 也不该让旧的作废）；落库失败只记账，因为帧已经在客户端手里，回滚反而更糟。
 */

export type SessionAdmissionDeliveryOutcome =
  /** 帧已投递，轮换已落库。 */
  | 'delivered'
  /** 帧投递失败：轮换没有落库，旧凭证继续有效。 */
  | 'send-failed'
  /** 帧已投递但落库失败：记录后继续，客户端下次重连会再轮换一次。 */
  | 'commit-failed';

export const deliverRegisteredThenCommit = async (input: {
  sendRegistered: () => void;
  commit: () => Promise<void> | void;
  onCommitError?: (error: unknown) => void;
}): Promise<SessionAdmissionDeliveryOutcome> => {
  try {
    input.sendRegistered();
  } catch {
    return 'send-failed';
  }

  try {
    await input.commit();
    return 'delivered';
  } catch (error) {
    input.onCommitError?.(error);
    return 'commit-failed';
  }
};

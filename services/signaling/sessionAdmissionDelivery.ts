/**
 * `registered` 帧与 proof 轮换落库的先后顺序。
 *
 * proof 明文只在 `registered` 里下发一次。如果先落库再发帧，帧一旦丢失（socket 抖动、
 * 页面挂起），客户端手里就只有旧 proof；旧 proof 超出 `SESSION_PROOF_GRACE_MS` 后
 * 每次重连都会被判 4010 终态，而且没有任何自愈路径。
 *
 * 所以顺序固定为「先投递、后落库」：投递失败就不落库（客户端没拿到新 proof，服务端
 * 也不该让旧的作废）；落库失败只记账，因为帧已经在客户端手里，回滚反而更糟。
 *
 * 落库会重试（`SESSION_COMMIT_ATTEMPTS` 次，短退避）：DO storage / shard 0 的瞬时失败
 * 不该把一次成功注册变成「客户端有新 proof、服务端只有旧 proof」的长期错位——那要等到
 * 下一次重连才会被纠正。重试仍失败时调用 `recover`，把新 proof 的摘要挂进绑定行的
 * recent_hashes，客户端下次带新 proof 重连仍然能进（见 appendPendingSessionProof）。
 */

export type SessionAdmissionDeliveryOutcome =
  /** 帧已投递，轮换已落库。 */
  | 'delivered'
  /** 帧投递失败：轮换没有落库，旧凭证继续有效。 */
  | 'send-failed'
  /** 帧已投递但落库失败：记录后继续，客户端下次重连会再轮换一次。 */
  | 'commit-failed';

import {
  SESSION_COMMIT_ATTEMPTS,
  SESSION_COMMIT_RETRY_DELAY_MS,
} from '../../constants/signaling';

// 常量唯一来源在 constants/signaling.ts；这里 re-export 保持既有测试的导入路径。
export { SESSION_COMMIT_ATTEMPTS, SESSION_COMMIT_RETRY_DELAY_MS };

export const deliverRegisteredThenCommit = async (input: {
  sendRegistered: () => void;
  commit: (attempt: number) => Promise<void> | void;
  /** 重试之间的等待，注入以便测试不真的睡。 */
  wait?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  attempts?: number;
  onCommitAttemptFailed?: (error: unknown, attempt: number) => void;
  /** 只在重试耗尽后调用一次（旧的「单次 commit」语义不变）。 */
  onCommitError?: (error: unknown, attempts: number) => void;
  /** 尽力自愈：让已下发的新 proof 也能被接受。失败不影响 outcome。 */
  recover?: () => Promise<void> | void;
  onRecoverError?: (error: unknown) => void;
}): Promise<SessionAdmissionDeliveryOutcome> => {
  try {
    input.sendRegistered();
  } catch {
    return 'send-failed';
  }

  const attempts = Math.max(1, Math.trunc(input.attempts ?? SESSION_COMMIT_ATTEMPTS));
  const retryDelayMs = input.retryDelayMs ?? SESSION_COMMIT_RETRY_DELAY_MS;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await input.commit(attempt);
      return 'delivered';
    } catch (error) {
      lastError = error;
      input.onCommitAttemptFailed?.(error, attempt);
      if (attempt < attempts) await wait(retryDelayMs * attempt);
    }
  }

  input.onCommitError?.(lastError, attempts);

  if (input.recover) {
    try {
      await input.recover();
    } catch (error) {
      input.onRecoverError?.(error);
    }
  }

  return 'commit-failed';
};

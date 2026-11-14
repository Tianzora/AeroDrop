/**
 * 信令面的结构化指标。
 *
 * Workers 的日志就是指标载体：一行一个 JSON，按 `type` 与 `event` 过滤即可在 Logs /
 * Logpush / 自建管道里做计数与告警。这里不依赖任何付费服务，也不写死导出目标，
 * 只保证「发生什么、带哪些字段」在代码里是单一事实来源。
 *
 * 约定：字段只放可枚举的少量标量（分片号、片数、目标片、失败原因），不放 peerId 之外
 * 的用户数据，也不放任何凭证——日志泄露的代价比少一条指标高得多。
 */
export type SignalingTelemetryEvent =
  /** 一次 WS 握手被路由到某个分片。 */
  | 'signal_shard_selected'
  /** 跨片投递成功。 */
  | 'signal_cross_shard_delivered'
  /** 跨片投递失败（目标不在片内、RPC 失败、或目标已下线）。 */
  | 'signal_cross_shard_failed'
  /** 全局会话名额拒绝了一个新注册。 */
  | 'signal_session_slot_rejected'
  /** 全局名额表不可达（shard 0 抖动）：注册按可重试的 503 结束，而不是绕过上限。 */
  | 'signal_session_slot_unavailable'
  /** 会话接管被拒（缺 proof / proof 不匹配）。 */
  | 'signal_session_conflict'
  /** 分片模式的握手预算耗尽。 */
  | 'signal_handshake_budget_exhausted'
  /** 跨片回源查口令失败。 */
  | 'signal_share_code_lookup_failed'
  /** 一次跨片回源同时答复了多条查询（说明合并生效）。 */
  | 'signal_share_code_lookup_batched'
  /** shard 0 的会话绑定表不可达：本次接管按身份不可验证处理。 */
  | 'signal_session_binding_unavailable'
  /** proof 轮换已在 registered 之后签发，但落库失败（帧已发，无法回滚）。 */
  | 'signal_session_binding_commit_failed'
  /** 迟到的 proof 轮换落库发现绑定已被更晚的注册接管，放弃写入（CAS 失配）。 */
  | 'signal_session_binding_commit_superseded'
  | 'signal_session_registration_send_failed'
  /** 口令查询未命中（含全局未知码预算耗尽）：只记标量，不记码/peerId。 */
  | 'share_code_lookup_miss';

export type SignalingTelemetryFieldValue = string | number | boolean | null | undefined;
export type SignalingTelemetryFields = Record<string, SignalingTelemetryFieldValue>;

export type SignalingTelemetrySnapshot = Partial<Record<SignalingTelemetryEvent, number>>;

export type SignalingTelemetry = {
  /** 记一条事件：计数 + 输出一行 JSON。 */
  record(event: SignalingTelemetryEvent, fields?: SignalingTelemetryFields): void;
  /** 当前 isolate 内的计数快照（测试与本地排障用，不对外暴露）。 */
  snapshot(): SignalingTelemetrySnapshot;
  reset(): void;
};

const encodeLine = (
  event: SignalingTelemetryEvent,
  at: number,
  fields: SignalingTelemetryFields
): string => {
  const payload: Record<string, unknown> = { type: 'signaling_metric', event, at };
  for (const [key, value] of Object.entries(fields)) {
    // undefined 会被 JSON.stringify 丢掉，显式跳过以保持行内形状稳定。
    if (value === undefined) continue;
    payload[key] = value;
  }
  return JSON.stringify(payload);
};

export const createSignalingTelemetry = (
  sink: (line: string) => void,
  now: () => number = () => Date.now()
): SignalingTelemetry => {
  const counters = new Map<SignalingTelemetryEvent, number>();

  return {
    record(event, fields = {}) {
      counters.set(event, (counters.get(event) ?? 0) + 1);
      try {
        sink(encodeLine(event, now(), fields));
      } catch {
        // 日志失败不能影响信令主流程；计数已经加过了。
      }
    },
    snapshot() {
      const snapshot: SignalingTelemetrySnapshot = {};
      for (const [event, count] of counters) snapshot[event] = count;
      return snapshot;
    },
    reset() {
      counters.clear();
    },
  };
};
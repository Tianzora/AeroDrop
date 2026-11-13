import { CONNECTION_TIMINGS } from '../../constants/transfer.ts';

export type ViewerHeartbeatVerdict =
  | { action: 'keep'; refresh: boolean }
  | { action: 'close'; reason: 'transport-failed' | 'heartbeat-timeout' | 'hard-timeout' };

export type ViewerHeartbeatSnapshot = {
  /** 最近一次收到该观众心跳的时间；null/undefined 表示还没有基线。 */
  lastHeartbeatAt: number | null | undefined;
  now: number;
  connectionState?: RTCPeerConnectionState | string | null;
  dataChannelOpen: boolean;
  /** 分享端自己的标签页是否在后台：后台时setInterval 会被节流，不能按流逝时间判死。 */
  tabHidden: boolean;
};

export type ViewerHeartbeatOptions = {
  heartbeatTimeoutMs?: number;
  hardTimeoutMs?: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * 观众心跳的判定点。原实现只看「距上次心跳 10 秒」，而后台标签页会把发送端的
 * 3 秒心跳节流到分钟级，于是活着的观众被周期性踢掉（观看端随后自动重连，表现为
 * 每隔十几秒黑一下）。这里先看传输本身：
 * 1. PC 已 failed/closed → 直接关，与心跳无关；
 * 2. PC connected 且数据通道 open → 传输健康，刷新心跳基线、绝不判死；
 * 3. 否则超过 5 分钟没心跳 → 硬超时关闭；
 * 4. 超过 30 秒没心跳：分享端自己后台时豁免，其余关闭。
 */
export const decideViewerHeartbeat = (
  snapshot: ViewerHeartbeatSnapshot,
  options: ViewerHeartbeatOptions = {},
): ViewerHeartbeatVerdict => {
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? CONNECTION_TIMINGS.SCREEN_SHARE_VIEWER_HEARTBEAT_TIMEOUT_MS;
  const hardTimeoutMs =
    options.hardTimeoutMs ?? CONNECTION_TIMINGS.SCREEN_SHARE_VIEWER_HARD_HEARTBEAT_TIMEOUT_MS;
  const state = snapshot.connectionState;

  if (state === 'failed' || state === 'closed') {
    return { action: 'close', reason: 'transport-failed' };
  }

  // 传输仍然健康时心跳只是冗余信息：BWE/ICE 已经证明这条链路活着。
  if (state === 'connected' && snapshot.dataChannelOpen) {
    return { action: 'keep', refresh: true };
  }

  if (!isFiniteNumber(snapshot.lastHeartbeatAt)) {
    // 还没有基线（通道刚开、或数据通道一直没 open）：交给连接超时兜底，不在这里杀。
    return { action: 'keep', refresh: false };
  }

  const gapMs = snapshot.now - snapshot.lastHeartbeatAt;
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    return { action: 'keep', refresh: false };
  }

  if (gapMs >= hardTimeoutMs) {
    return { action: 'close', reason: 'hard-timeout' };
  }

  if (gapMs >= heartbeatTimeoutMs) {
    if (snapshot.tabHidden) {
      return { action: 'keep', refresh: false };
    }
    return { action: 'close', reason: 'heartbeat-timeout' };
  }

  return { action: 'keep', refresh: false };
};

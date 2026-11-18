import type { MediaConnection } from '../peerRuntime';
import { CONNECTION_TIMINGS } from '../../constants/transfer';
import {
  resolvePerViewerBitrateCap,
  shouldDowngradeQuality,
  shouldUpgradeQuality,
  type ScreenShareQualityLevel,
} from './bitratePolicy';
import { logDebug } from '../diagnostics';

type QualityLevel = ScreenShareQualityLevel;

export interface BandwidthMonitorEntry {
  timer: ReturnType<typeof setInterval>;
  pc: RTCPeerConnection;
}

export interface BandwidthMonitorDeps {
  monitors: Map<string, BandwidthMonitorEntry>;
  peerQualityLevels: Map<string, QualityLevel>;
  peerRelay: Map<string, boolean>;
  peerAppliedCaps: Map<string, number>;
  getUniqueViewerCount: () => number;
  applyBitrateConstraints: (pc: RTCPeerConnection, level: QualityLevel, cap?: number) => Promise<boolean>;
  setPeerQualityLevel: (peerId: string, level: QualityLevel) => void;
  notifyQualityChange: (message: string) => void;
}
export function startBandwidthMonitoring(call: MediaConnection, deps: BandwidthMonitorDeps): void {
    const pc = call.peerConnection;
    if (!pc) return;
    const existing = deps.monitors.get(call.peer);
    if (existing) {
      if (existing.pc === pc) return;
      // 旧连接还没 close 就来了新连接：先停掉旧监控，否则新 PC 永远拿不到监控。
      clearInterval(existing.timer);
      deps.monitors.delete(call.peer);
    }

    let lastBytesSent = 0;
    let lastPacketsSent = 0;
    let lastPacketsLost = 0;
    let lastTimestamp = Date.now();
    let consecutiveLowBandwidth = 0;
    let consecutiveHighBandwidth = 0;
    const monitorStartedAt = Date.now();
    const BANDWARMUP_MS = CONNECTION_TIMINGS.SCREEN_SHARE_BANDWARMUP_MS;

    const applyLevel = async (level: 'high' | 'medium' | 'low') => {
      // 每个观众独立编码：上限 = min(画质/中继上限, 聚合上行预算 / 当前观众数)。
      const cap = resolvePerViewerBitrateCap(
        level,
        deps.peerRelay.get(call.peer) ?? false,
        deps.getUniqueViewerCount(),
      );
      // 只有 setParameters 真正成功才记录，否则限流失败后会被误判为「已应用」。
      const applied = await deps.applyBitrateConstraints(pc, level, cap);
      if (applied) {
        deps.peerAppliedCaps.set(call.peer, cap);
      }
    };

    const monitor = async () => {
      try {
        const stats = await pc.getStats();
        let currentBytesSent = 0;
        let packetsLost = 0;
        let packetsSent = 0;
        const outboundCandidates: any[] = [];
        const remoteInboundCandidates: any[] = [];

        stats.forEach((report: any) => {
          const mediaKind = report.kind || report.mediaType;
          if (report.type === 'outbound-rtp' && mediaKind === 'video' && !report.isRemote) {
            outboundCandidates.push(report);
          }
          if (report.type === 'remote-inbound-rtp' && mediaKind === 'video') {
            remoteInboundCandidates.push(report);
          }
        });

        let selectedPair: any = null;
        stats.forEach((report: any) => {
          if (selectedPair) return;
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPair = stats.get(report.selectedCandidatePairId) || null;
          }
        });
        if (!selectedPair) {
          stats.forEach((report: any) => {
            if (selectedPair) return;
            if (
              report.type === 'candidate-pair' &&
              (report.selected === true || (report.nominated === true && report.state === 'succeeded'))
            ) {
              selectedPair = report;
            }
          });
        }
        if (selectedPair) {
          const localCandidate = selectedPair.localCandidateId
            ? stats.get(selectedPair.localCandidateId) as any
            : null;
          const remoteCandidate = selectedPair.remoteCandidateId
            ? stats.get(selectedPair.remoteCandidateId) as any
            : null;
          const localType = localCandidate?.candidateType as string | undefined;
          const remoteType = remoteCandidate?.candidateType as string | undefined;
          // 两侧都取不到候选类型时不要猜成 P2P：那会把中继链路的 8M 上限放开到 100M。
          if (localType || remoteType) {
            deps.peerRelay.set(
              call.peer,
              localType === 'relay' || remoteType === 'relay',
            );
          }
        }

        if (outboundCandidates.length > 0) {
          const selectedOutbound = outboundCandidates.reduce((best, item) => {
            const bestBytes = typeof best?.bytesSent === 'number' ? best.bytesSent : -1;
            const itemBytes = typeof item?.bytesSent === 'number' ? item.bytesSent : -1;
            return itemBytes > bestBytes ? item : best;
          }, outboundCandidates[0] as any);

          currentBytesSent = selectedOutbound?.bytesSent || 0;
          packetsSent = selectedOutbound?.packetsSent || 0;

          const linkedRemoteId = selectedOutbound?.remoteId;
          if (linkedRemoteId && stats.has(linkedRemoteId)) {
            const linkedRemote = stats.get(linkedRemoteId) as any;
            if (linkedRemote && linkedRemote.type === 'remote-inbound-rtp') {
              packetsLost = linkedRemote.packetsLost || 0;
            }
          }
        }

        if (packetsLost === 0 && remoteInboundCandidates.length > 0) {
          packetsLost = remoteInboundCandidates.reduce((maxLost, item) => {
            const lost = typeof item?.packetsLost === 'number' ? item.packetsLost : 0;
            return Math.max(maxLost, lost);
          }, 0);
        }

        const now = Date.now();
        const timeDiff = (now - lastTimestamp) / 1000;
        if (timeDiff <= 0) return;
        const bytesDiff = currentBytesSent - lastBytesSent;
        const currentBitrate = (bytesDiff * 8) / timeDiff;
        const sentDiff = Math.max(0, packetsSent - lastPacketsSent);
        const lostDiff = Math.max(0, packetsLost - lastPacketsLost);
        const packetLossRate = (sentDiff + lostDiff) > 0 ? (lostDiff / (sentDiff + lostDiff)) : 0;

        lastBytesSent = currentBytesSent;
        lastPacketsSent = packetsSent;
        lastPacketsLost = packetsLost;
        lastTimestamp = now;

        const currentQuality = deps.peerQualityLevels.get(call.peer) || 'high';

        // 路由可能在 ICE 重启后变化：从直连切到中继时补上成本上限，反之放开。
        // 这一步必须在预热返回之前执行——否则中继的前 8 秒会按 P2P 的 100M 上限
        // 发送，恰好是 TURN 流量最贵、也最容易把上行打满的起播阶段。
        const relay = deps.peerRelay.get(call.peer) ?? false;
        // 观众人数变化后预算份额随之变化，2 秒内通过这里重新下发上限。
        const expectedCap = resolvePerViewerBitrateCap(
          currentQuality,
          relay,
          deps.getUniqueViewerCount(),
        );
        if (deps.peerAppliedCaps.get(call.peer) !== expectedCap) {
          await applyLevel(currentQuality);
        }

        // 连接初期带宽估计和丢包统计波动很大，先预热避免误降档导致“刚连上先糊”
        if (now - monitorStartedAt < BANDWARMUP_MS) {
          return;
        }

        // 清晰优先策略：
        // 默认保持高清/原画，只有在“持续且明显卡顿”时才降档。
        const shouldDowngrade = shouldDowngradeQuality(currentQuality, packetLossRate, currentBitrate);

        if (shouldDowngrade) {
          consecutiveLowBandwidth++;
          consecutiveHighBandwidth = 0;

          // 每 2 秒检测一次：
          // high -> medium 需要连续 12 秒严重卡顿；
          // medium -> low 需要连续 16 秒严重卡顿。
          const lowThreshold = currentQuality === 'high' ? 6 : 8;
          if (consecutiveLowBandwidth >= lowThreshold) {
            if (currentQuality === 'high') {
              deps.setPeerQualityLevel(call.peer, 'medium');
              await applyLevel('medium');
              deps.notifyQualityChange('部分观看者网络波动，已自动降低画质');
            } else if (currentQuality === 'medium') {
              deps.setPeerQualityLevel(call.peer, 'low');
              await applyLevel('low');
              deps.notifyQualityChange('部分观看者网络不稳定，已切换到流畅模式');
            }
            consecutiveLowBandwidth = 0;
          }
        } else if (shouldUpgradeQuality(packetLossRate)) { // 只有丢包率极低时才考虑升级
          consecutiveHighBandwidth++;
          consecutiveLowBandwidth = 0;

          if (consecutiveHighBandwidth >= 5) {
            if (currentQuality === 'low') {
              deps.setPeerQualityLevel(call.peer, 'medium');
              await applyLevel('medium');
              deps.notifyQualityChange('观看网络好转，已自动恢复画质');
            } else if (currentQuality === 'medium') {
              deps.setPeerQualityLevel(call.peer, 'high');
              await applyLevel('high');
              deps.notifyQualityChange('观看网络良好，已切换回原画');
            }
            consecutiveHighBandwidth = 0;
          }
        } else {
          consecutiveLowBandwidth = 0;
          consecutiveHighBandwidth = 0;
        }
      } catch (err) {
      logDebug('warn', 'Bandwidth monitoring error:', err);
      }
    };

    void monitor();
    const timer = setInterval(monitor, CONNECTION_TIMINGS.SCREEN_SHARE_BANDWIDTH_MONITOR_INTERVAL_MS);
    deps.monitors.set(call.peer, { timer, pc });
}
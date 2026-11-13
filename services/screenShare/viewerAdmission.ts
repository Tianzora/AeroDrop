/**
 * 分享端是否还能接纳一个新的观看者。
 *
 * mesh 下每个观众都对应一份上行编码与一条 PeerConnection，名额必须在 answer 之前
 * 预留：answer() 要等一次 round-trip，只按「已建立的 call」计数会让并发的两个观众
 * 同时通过检查，实际人数越过 MAX_VIEWERS。
 */
export interface ViewerAdmissionInput {
  activeViewers: number;
  pendingViewers: number;
  maxViewers: number;
}

const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

export const canAdmitViewer = ({ activeViewers, pendingViewers, maxViewers }: ViewerAdmissionInput): boolean =>
  nonNegative(activeViewers) + nonNegative(pendingViewers) < nonNegative(maxViewers);

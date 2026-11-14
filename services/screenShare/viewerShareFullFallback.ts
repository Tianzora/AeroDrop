/**
 * 观众侧：call 还没送来画面就结束了，该怎么解释。
 *
 * 分享端满员时会先发 share-full 再关 call。但「发」是 best-effort：已登记的数据连接
 * 可能还没 open，反向新建的那条也可能失败（见 viewerAdmission.deliverShareFull 的
 * 返回值）。一旦告知没送到，观众这边只剩下一条「call 被关」——旧实现把它当断链，
 * 自动重连后 20s 报「连接超时」，用户以为是网络/防火墙问题。
 *
 * 判定必须保守：只有「从没收到画面」且「数据通道一次都没打开过」才算疑似满员。
 * 否则任何早期断链都会被误报成人数问题，把真正的网络故障藏起来。
 */

export interface ViewerCallEndInput {
  /** 用户自己点了「取消」/「停止观看」。 */
  manualStop: boolean;
  /** 已经通过数据通道收到共享方的 share-ended。 */
  shareEnded: boolean;
  /** 已经通过数据通道收到 share-full（人数已满）。 */
  shareFull: boolean;
  /** 本次连接是否收到过共享方画面。 */
  receivedStream: boolean;
  /** 观众→分享端的数据通道是否曾经 open（open 过说明不是被名额挡下的）。 */
  dataChannelOpened: boolean;
}

export type ViewerCallEndOutcome =
  | 'share-ended'
  | 'share-full'
  | 'manual-stop'
  | 'suspected-share-full'
  | 'reconnect';

export const planViewerCallEndOutcome = ({
  manualStop,
  shareEnded,
  shareFull,
  receivedStream,
  dataChannelOpened,
}: ViewerCallEndInput): ViewerCallEndOutcome => {
  // 共享方主动结束优先：它同时会关 call，别把「结束」当成断链去重连。
  if (shareEnded) return 'share-ended';
  if (shareFull) return 'share-full';
  if (manualStop) return 'manual-stop';
  if (!receivedStream && !dataChannelOpened) return 'suspected-share-full';
  return 'reconnect';
};

/** 疑似满员时不要自动重连：名额不会自己空出来，重连只会再撞一次。 */
export const shouldReconnectAfterCallEnd = (outcome: ViewerCallEndOutcome): boolean =>
  outcome === 'reconnect';

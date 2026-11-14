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
 *
 * 但保守还不够：同一出口（CGNAT）观众多时，offer 会被信令层限流，连接同样建不起来。
 * 那种情况重试有效（等窗口过去），满员重试则是白撞——所以限流必须先判，不能一律
 * 归进「疑似满员」。
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
  /** 结束前收到过信令层的限流拒绝：连接压根没建起来，和「名额满了」是两回事。 */
  rateLimited?: boolean;
  /**
   * 这次 call 的结束跟着一条「分享者不在线」类的信令错误（peer-unavailable / invalid-id /
   * unauthorized）。死链、分享端重建 Peer 的几秒窗口、首帧前的 ICE 失败都会走这条路。
   *
   * 必须与「疑似满员」分开：分享者根本不在时名额是不是满的完全无关，报「人数已满」
   * 会让用户以为要等别人退出，而实际上等多久都进不去（或者马上就恢复）。
   */
  sharerUnavailable?: boolean;
  /**
   * 这次 call 是被传输层关掉的（ICE/DTLS 失败、或 disconnected 宽限期耗尽），
   * 不是远端主动 close。
   *
   * 没有这个输入时，「公司网/对称 NAT/没 TURN 导致 pc 直接 failed」与「第 7 个观众
   * 被名额拒绝」在观众侧长得一模一样：没画面、数据通道没开、call 关了。旧实现把两种
   * 都归进「疑似人数已满」，用户被确定语气劝去「等别人退出」。传输层失败必须单独判，
   * 走媒体失败文案。
   */
  transportFailed?: boolean;
}

export type ViewerCallEndOutcome =
  | 'share-ended'
  | 'share-full'
  | 'manual-stop'
  | 'rate-limited'
  | 'sharer-unavailable'
  | 'media-failed'
  | 'suspected-share-full'
  | 'reconnect';

export const planViewerCallEndOutcome = ({
  manualStop,
  shareEnded,
  shareFull,
  receivedStream,
  dataChannelOpened,
  rateLimited = false,
  sharerUnavailable = false,
  transportFailed = false,
}: ViewerCallEndInput): ViewerCallEndOutcome => {
  // 共享方主动结束优先：它同时会关 call，别把「结束」当成断链去重连。
  if (shareEnded) return 'share-ended';
  if (shareFull) return 'share-full';
  if (manualStop) return 'manual-stop';
  // 限流优先于满员推断：等窗口过去就能连上，跟「名额满了」是相反的行动。
  if (rateLimited && !receivedStream) return 'rate-limited';
  // 分享者不在线也优先于满员推断：死链/重建窗口/首帧前 ICE 失败时，名额满不满无从谈起，
  // 报「人数已满」会把用户引到「等别人退出」这个永远不成立的行动上。
  if (sharerUnavailable && !receivedStream) return 'sharer-unavailable';
  // 传输层自己关了连接（ICE 失败、宽限到期）时名额是不是满的根本无从判断：
  // 名额拒绝走的是远端主动 close（'peer'），不会落到这里。
  if (!receivedStream && transportFailed) return 'media-failed';
  // 只有「远端干净关闭且没有画面」才允许推断满员：那正是 share-full best-effort
  // 没送到时的形状。
  if (!receivedStream && !dataChannelOpened) return 'suspected-share-full';
  return 'reconnect';
};

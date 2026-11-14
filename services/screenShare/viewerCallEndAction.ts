/**
 * 观众侧：call 结束的「结论」该落成什么「动作」。
 *
 * 结论由 viewerShareFullFallback 判（纯函数，只管解释），动作在这里定。
 * 两条路径（call 的 close 与 error）都必须消费同一张表：之前 close 分支不看结论、
 * 无条件重连，导致纯函数返回的 'sharer-unavailable' 只有测试在调，分享者不在线时
 * 仍然照常重连、最后报「连接超时」，把「对方下线」说成网络问题。
 */
import type { ViewerCallEndOutcome } from './viewerShareFullFallback';

export type ViewerCallEndAction =
  /** 共享方已结束共享：收尾并提示。 */
  | 'end-share'
  /** 名额已满（数据通道送到了 share-full）：直接停，重连只会再撞一次。 */
  | 'stop'
  /** 用户自己停的：静默收尾。 */
  | 'stop-manual'
  /** 交给 peer 级错误分类（分享者不在线、限流），本地不做动作。 */
  | 'await-peer-error'
  /** 媒体建连失败：报媒体失败文案，不重连、不报满员。 */
  | 'media-error'
  /** 疑似满员（远端干净关闭且没有画面）：保留提示，不自动重连。 */
  | 'suspected-full'
  /** 真断链：走重连退避。 */
  | 'reconnect';

const ACTION_BY_OUTCOME: Record<ViewerCallEndOutcome, ViewerCallEndAction> = {
  'share-ended': 'end-share',
  'share-full': 'stop',
  'manual-stop': 'stop-manual',
  'rate-limited': 'await-peer-error',
  'sharer-unavailable': 'await-peer-error',
  'media-failed': 'media-error',
  'suspected-share-full': 'suspected-full',
  reconnect: 'reconnect',
};

export const planViewerCallEndAction = (outcome: ViewerCallEndOutcome): ViewerCallEndAction =>
  ACTION_BY_OUTCOME[outcome];

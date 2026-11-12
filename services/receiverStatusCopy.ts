export type ReceiverWaitingStage =
  | 'fetching_ice'
  | 'connecting_signaling'
  | 'connecting_peer'
  | 'waiting_response'
  | 'reconnecting'
  | '';

export interface ReceiverWaitingStatusInput {
  stage: ReceiverWaitingStage;
  reconnectAttempt: number;
}

export interface ReceiverWaitingStatusCopy {
  title: string;
  /** 只有需要额外指导时才出现（目前仅重连阶段），其余阶段只显示标题。 */
  detail?: string;
  cancelLabel: string;
}

export const getReceiverWaitingStatusCopy = (
  input: ReceiverWaitingStatusInput
): ReceiverWaitingStatusCopy => {
  switch (input.stage) {
    case 'fetching_ice':
      return {
        title: '正在获取网络配置...',
        cancelLabel: '取消',
      };
    case 'connecting_signaling':
      return {
        title: '正在连接信令服务...',
        cancelLabel: '取消',
      };
    case 'connecting_peer':
      // 此时只发起了候选收集，走直连还是中继要等 ICE 选对；别提前宣称已经是点对点。
      return {
        title: '正在建立连接...',
        detail: '同时尝试直连与中继，连上后显示实际路径',
        cancelLabel: '取消',
      };
    case 'waiting_response':
      return {
        title: '正在等待发送方响应...',
        cancelLabel: '取消',
      };
    case 'reconnecting':
      return {
        title: '连接中断，正在尝试恢复...',
        detail: `第 ${Math.max(1, input.reconnectAttempt)} 次自动重连中，请保持此页面打开，无需重新输入口令`,
        cancelLabel: '停止重连',
      };
    default:
      return {
        title: '正在连接发送方...',
        cancelLabel: '取消',
      };
  }
};

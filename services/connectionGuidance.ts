export const NO_TURN_WARNING_MESSAGE =
  '当前服务未启用 TURN 中继，跨网络或手机流量下可能无法连接';
export const RATE_LIMITED_CONNECTION_MESSAGE =
  '连接请求过多，请稍后再试';
export const SIGNALING_UNREACHABLE_MESSAGE =
  '无法连接信令服务器，请检查网络后重试';
export const SIGNALING_MESSAGE_TOO_LARGE_MESSAGE =
  '控制消息超出大小上限，请刷新页面后重试';

/**
 * peerRuntime 的 error.type 到用户可懂文案的唯一映射点。未列出的类型保留技术标识，
 * 方便排查时仍能定位到具体原因。
 */
export const getPeerRuntimeErrorMessage = (type: string): string => {
  switch (type) {
    case 'rate-limited':
      return RATE_LIMITED_CONNECTION_MESSAGE;
    case 'message-too-large':
      return SIGNALING_MESSAGE_TOO_LARGE_MESSAGE;
    case 'disconnected':
      return SIGNALING_UNREACHABLE_MESSAGE;
    case 'network':
      return '网络连接中断，请检查网络后重试';
    case 'unauthorized':
      return '口令或凭证已失效，请让发送端重新分享';
    case 'session-conflict':
      return '分享会话已被其他连接占用，请重新开始共享';
    case 'unavailable-id':
      return '该口令已被占用，请换一个';
    case 'invalid-id':
      return '口令无效，请确认后重试';
    default:
      return `连接错误: ${type}`;
  }
};

export const getReceiverPreTransferFailureMessage = (hasTurn: boolean): string => {
  if (hasTurn) {
    return '连接超时，请检查口令是否正确';
  }

  return `${NO_TURN_WARNING_MESSAGE}；当前更像是中继不可用，而不是口令错误`;
};

export const getReceiverDisconnectedMessage = (
  hasTurn: boolean,
  isStillWaitingForPeer: boolean
): string => {
  if (!isStillWaitingForPeer) {
    return '连接已断开';
  }

  return hasTurn
    ? '连接已断开，请检查口令是否正确后重试'
    : `${NO_TURN_WARNING_MESSAGE}；如果发送端在手机流量或不同网络下，这通常会直接导致建连失败`;
};

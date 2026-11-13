export const NO_TURN_WARNING_MESSAGE =
  '当前服务未启用 TURN 中继，跨网络或手机流量下可能无法连接';
export const RATE_LIMITED_CONNECTION_MESSAGE =
  '连接请求过多，请稍后再试';
export const SIGNALING_UNREACHABLE_MESSAGE =
  '无法连接信令服务器，请检查网络后重试';
export const SIGNALING_SESSION_REJECTED_MESSAGE =
  '信令服务拒绝了当前会话，请重新开始共享';
export const SHARER_RECONNECT_EXHAUSTED_MESSAGE =
  '信令连接持续失败，请刷新页面后重新开始共享';
export const SIGNALING_MESSAGE_TOO_LARGE_MESSAGE =
  '控制消息超出大小上限，请刷新页面后重试';
export const ICE_CONNECTION_FAILED_MESSAGE =
  '媒体通道建立失败（可能是网络或防火墙限制），请重试';
export const UNKNOWN_CONNECTION_ERROR_MESSAGE =
  '连接失败，请稍后重试';

/**
 * peerRuntime 的 error.type 到用户可懂文案的唯一映射点。
 *
 * 这里刻意不把技术标识拼进文案：用户看不懂 `peer-unavailable`，而原始错误已经由
 * 调用方 logDebug 记录，排查时不需要从 UI 里抄。新增错误类型时补 case，不要退回
 * 「连接错误: ${type}」这种直出。
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
    case 'peer-unavailable':
      return '找不到该分享者，请确认分享链接是否仍然有效';
    case 'webrtc-error':
    case 'ice-failed':
      return ICE_CONNECTION_FAILED_MESSAGE;
    case 'server-error':
      return '信令服务器暂时不可用，请稍后重试';
    case 'socket-error':
      return '信令连接异常，请检查网络后重试';
    default:
      return UNKNOWN_CONNECTION_ERROR_MESSAGE;
  }
};

/** 媒体连接（call）错误：PeerJS/浏览器可能只给 message 不给 type，按 ICE 关键词兜底。 */
export const getMediaConnectionErrorMessage = (
  error?: { type?: string; message?: string } | null,
): string => {
  const type = error?.type;
  if (type && type !== 'webrtc-error') {
    return getPeerRuntimeErrorMessage(type);
  }
  const message = error?.message ?? '';
  if (type === 'webrtc-error' || /ice|dtls|sctp|transport/i.test(message)) {
    return ICE_CONNECTION_FAILED_MESSAGE;
  }
  return UNKNOWN_CONNECTION_ERROR_MESSAGE;
};

/** 观看人数达到硬上限：这是容量拒绝，不是网络故障，不要提示用户去重试网络。 */
export const getShareFullMessage = (maxViewers: number): string =>
  `分享人数已满（最多 ${maxViewers} 人同时观看），请稍后再试`;

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

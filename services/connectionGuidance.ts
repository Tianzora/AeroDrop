export const NO_TURN_WARNING_MESSAGE =
  '当前服务未启用 TURN 中继，跨网络或手机流量下可能无法连接';
export const RATE_LIMITED_CONNECTION_MESSAGE =
  '连接请求过多，请稍后再试';
/**
 * 每出口会话数（12 个/IP）被占满时的文案。
 *
 * 这跟 offer 限流不是一回事：等 60 秒不会好，是同一出口的其它标签页/设备还占着名额。
 * 给它倒计时等于骗用户干等，所以这里明确让人去关掉占用的那个设备。
 */
export const VIEWER_SESSION_LIMIT_MESSAGE =
  '同一网络下的其他设备占用了连接名额，请关闭其他标签页或设备后再试';
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
 * 分享链接已经不能再用（口令失效/会话被接管/房号已撤销），但已有连接上的传输还能跑完。
 * 这种状态必须可见，又不能把用户打到错误页——否则他会以为正在传的文件也挂了。
 */
export const SHARE_SIGNALING_LOST_MESSAGE =
  '分享已失效，进行中的传输不受影响，新设备无法加入';

/**
 * 有效期一栏在口令已作废时显示的文案。界面靠它判断「链接还能不能发」，
 * 所以写在一处：`senderSession` 写、`SenderUI` 读，两边各拼一个字符串就会失配。
 */
export const SHARE_EXPIRED_REMAINING_TEXT = '已失效';

/**
 * 观众侧重连预算用尽后的终态：媒体一直连不上时，必须给一个「已经不再自动重试」的
 * 明确状态和手动重试入口，不能永远停在「正在重试」。
 */
export const VIEWER_RECONNECT_EXHAUSTED_MESSAGE =
  '连接断开，已达到最大重试次数，请手动重试';

/**
 * 观众点开一个已经停止/过期的链接：信令一直回「这个分享者不存在」。
 *
 * 不能说「链接已失效」，也不能让用户去索取新链接：分享端重建 Peer 时复用同一个房号，
 * 恢复完成后旧链接仍然有效。所以终态只描述「暂时不可用」，并允许稍后重新打开。
 */
export const VIEWER_SHARE_UNAVAILABLE_MESSAGE =
  '分享暂时不可用（可能已结束，或分享者正在重连），请稍后重新打开此链接';

/** 分享者暂时查不到时的等待文案：有限重试期间的提示，不是终态。 */
export const VIEWER_SHARE_UNAVAILABLE_RETRY_MESSAGE = '分享者暂时不在线，正在重试...';

/** 自动重连等待期的文案：把秒数写进同一处，避免组件里各拼一份。 */
export const describeViewerReconnectWait = (delayMs: number): string => {
  const seconds = Number.isFinite(delayMs) ? Math.max(1, Math.round(delayMs / 1000)) : 1;
  return `连接断开，${seconds}秒后尝试重连...`;
};

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

/**
 * 哪些 peer 错误意味着「这个分享链接已经废了」。
 *
 * 有在途传输时它们不该把 UI 打到错误页（传输是在已建立的 P2P 连接上跑的，跟信令无关），
 * 但也不能继续显示「等待连接」——否则用户会把一个死码发出去。
 * network/server-error/socket-error 不在此列：那三类由 peerRuntime 自己退避重连。
 */
export const isShareSessionLostError = (type?: string | null): boolean =>
  type === 'unauthorized' ||
  type === 'session-conflict' ||
  type === 'invalid-id' ||
  type === 'peer-unavailable' ||
  type === 'disconnected';

/**
 * 接收端把发送方的拒收原因翻译成人话。
 *
 * `payload.reason` 是协议字段，直出会把内部标识丢给用户；已知原因走映射，
 * 未知原因保留原文（新加的拒收理由至少还能看懂，不会变成一句空话）。
 */
export const getTransferRejectedMessage = (reason?: string | null): string => {
  switch (reason) {
    case '分享已过期':
      return '发送方的分享已过期，请让对方重新分享';
    default:
      return reason?.trim() || '发送方拒绝了请求';
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

/**
 * 观众侧没收到 share-full、但连接在建流之前就断了：最可能是名额已满。
 *
 * 必须说「可能」并给出人数上限：说成网络问题会让人反复重试网络，说成确定满员又会冤枉
 * 真正的断链。
 */
export const getSuspectedShareFullMessage = (maxViewers: number): string =>
  `可能人数已满（最多 ${maxViewers} 人），请稍后再试`;

/**
 * 分享端自己的 peer 错误文案。
 *
 * unauthorized / unavailable-id 在分享端不是「口令输错了」：房号由服务端登记，出现这两类
 * 只能说明本地凭证或房号已经作废。复用观众端文案会让分享者去找一个并不存在的「发送端」。
 */
export const getSharerPeerRuntimeErrorMessage = (type: string): string => {
  if (type === 'unauthorized' || type === 'unavailable-id') {
    return '分享凭证已过期，请重新开始共享（旧链接会失效）';
  }
  return getPeerRuntimeErrorMessage(type);
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

/**
 * 分享端是否还能接纳一个新的观看者，以及「不能接纳时怎么告知观众」。
 *
 * mesh 下每个观众都对应一份上行编码与一条 PeerConnection，名额必须在 answer 之前
 * 预留：answer() 要等一次 round-trip，只按「已建立的 call」计数会让并发的两个观众
 * 同时通过检查，实际人数越过 MAX_VIEWERS。
 *
 * 拒绝时也必须把原因送出去：只 close call 的话观众会一直等到超时，然后被告知
 * 「连接超时，请检查网络或防火墙」——把「人数已满」误报成网络故障。
 */
export interface ViewerAdmissionInput {
  activeViewers: number;
  pendingViewers: number;
  maxViewers: number;
}

const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

export const canAdmitViewer = ({ activeViewers, pendingViewers, maxViewers }: ViewerAdmissionInput): boolean =>
  nonNegative(activeViewers) + nonNegative(pendingViewers) < nonNegative(maxViewers);

/** 分享端到该观众的数据连接当前处于什么状态（没有登记 = 分享端还拿不到这条通道）。 */
export type ViewerDataChannelState = 'open' | 'pending' | 'absent';

/** 拒绝时 ``share-full`` 该走哪条路。 */
export type ShareFullDelivery = 'open-connection' | 'pending-connection' | 'new-connection';

export type ViewerAdmissionPlan =
  | { kind: 'admit'; reserveSeat: boolean }
  | { kind: 'reject-share-full'; delivery: ShareFullDelivery };

export interface ViewerAdmissionDecisionInput extends ViewerAdmissionInput {
  /** 该 peer 已经有 call，或已经占着 pending 名额（重连/多开）。 */
  tracked: boolean;
  dataChannel: ViewerDataChannelState;
}

/**
 * 判定：先看是否已登记（重连或多开不额外占名额），再看名额，最后决定怎么告知。
 *
 * 数据连接未登记时不能放弃告知：观众端只会在 20s 后当成网络问题。此时用 peer 反向
 * 连一条数据连接（观众端会接受入站连接并读 ``share-full``）。
 */
export const planViewerAdmission = (input: ViewerAdmissionDecisionInput): ViewerAdmissionPlan => {
  if (input.tracked) return { kind: 'admit', reserveSeat: false };
  if (canAdmitViewer(input)) return { kind: 'admit', reserveSeat: true };
  const delivery: ShareFullDelivery =
    input.dataChannel === 'open'
      ? 'open-connection'
      : input.dataChannel === 'pending'
        ? 'pending-connection'
        : 'new-connection';
  return { kind: 'reject-share-full', delivery };
};

export type ShareFullMessage = { type: 'share-full' };

/** 结构化的最小连接接口：PeerJS 的 DataConnection 与测试替身都能满足。 */
export interface ShareFullConnection {
  open: boolean;
  send(message: ShareFullMessage): void;
  on(event: 'open' | 'error', listener: () => void): void;
  close?(): void;
}

export interface ShareFullDeliveryTarget {
  /** 已登记（或正在建立）的分享端→观众数据连接。 */
  connection: ShareFullConnection | null;
  /** 没有登记连接时用来向观众反向建连；拿不到 peer 对象时为 null。 */
  connect: ((peerId: string) => ShareFullConnection | null) | null;
  peerId: string;
}

const SHARE_FULL: ShareFullMessage = { type: 'share-full' };

const trySend = (connection: ShareFullConnection): boolean => {
  try {
    connection.send(SHARE_FULL);
    return true;
  } catch {
    return false;
  }
};

/**
 * 执行「告知观众人数已满」。best-effort：任何一条路失败都不能影响分享端继续服务
 * 其他观众，所以整体包在 try/catch 里，只返回是否真的发出去了。
 */
export const deliverShareFull = (
  delivery: ShareFullDelivery,
  target: ShareFullDeliveryTarget,
): boolean => {
  try {
    if (delivery === 'open-connection') {
      const connection = target.connection;
      if (!connection || !connection.open) return false;
      return trySend(connection);
    }

    if (delivery === 'pending-connection') {
      const connection = target.connection;
      if (!connection) return false;
      if (connection.open) return trySend(connection);
      // 还没 open：等它 open 再发，否则 send 会直接抛。
      connection.on('open', () => { trySend(connection); });
      return true;
    }

    const connection = target.connect?.(target.peerId) ?? null;
    if (!connection) return false;
    connection.on('open', () => {
      trySend(connection);
      // 反向连接只为传一句话，发完就关，别在分享端留下一条常驻连接。
      try { connection.close?.(); } catch { /* best effort */ }
    });
    connection.on('error', () => {
      try { connection.close?.(); } catch { /* best effort */ }
    });
    return true;
  } catch {
    return false;
  }
};

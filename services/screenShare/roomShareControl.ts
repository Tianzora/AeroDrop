/**
 * 房间内共享槽（ShareSlot）控制帧与决策。
 *
 * 传输走 M1 已经建立的 `aero-room` DataChannel，和聊天文本同一条通道但不同报文形状：
 * 控制帧一定带 `type`，聊天消息一定带 `text`。共享/聊天/语音因此互不重建连接。
 *
 * 本轮实现是「房间信令中心」模型：房主 peer（原来建房的分享端）作为 ShareSlot 的
 * 权威；任何在房成员通过 room 通道向它发请求，它把 `share-state` 广播回所有成员。
 * 媒体仍然 P2P 直连当前 sharer，不经过房主中继。
 */

export type RoomShareRequestAction = 'start' | 'stop' | 'takeover';

export type RoomShareControlMessage =
  | { type: 'share-request'; action: RoomShareRequestAction }
  | { type: 'share-state'; activeSharerId: string | null }
  /** 成员离房：房主据此清空 ShareSlot（离房者本人若正在共享）。 */
  | { type: 'share-leave' };

export function isRoomShareControl(value: unknown): value is RoomShareControlMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'share-request') {
    return (
      record.action === 'start' ||
      record.action === 'stop' ||
      record.action === 'takeover'
    );
  }
  if (record.type === 'share-state') {
    return record.activeSharerId === null || typeof record.activeSharerId === 'string';
  }
  if (record.type === 'share-leave') {
    return true;
  }
  return false;
}

export function createRoomShareRequest(action: RoomShareRequestAction): RoomShareControlMessage {
  return { type: 'share-request', action };
}

export function createRoomShareState(activeSharerId: string | null): RoomShareControlMessage {
  return { type: 'share-state', activeSharerId };
}

export function createRoomShareLeave(): RoomShareControlMessage {
  return { type: 'share-leave' };
}

export interface RoomShareRequestPlan {
  accepted: boolean;
  nextActiveSharerId: string | null;
  /** 房主本人正在共享、且要被别人接替：先停本地采集，但保留房间/聊天/语音。 */
  stopLocalShare: boolean;
  /** 房主当前在观看另一个远端 sharer，需要先摘掉旧画面再观看新 sharer。 */
  stopWatchingRemote: boolean;
  reason?: 'occupied' | 'stale-stop';
}

export interface RoomShareRequestInput {
  action: RoomShareRequestAction;
  fromPeerId: string;
  currentActiveSharerId: string | null;
  localPeerId: string | null;
  localIsSharing: boolean;
}

/**
 * 房主收到成员请求后生成执行计划。
 *
 * 规则（架构 v2.2）：
 * - 同槽只允许一个 sharer；start 遇到别人占用时不静默抢占，必须走 takeover。
 * - takeover 明确允许：旧 sharer 无论是在本端还是远端，都先让位，再切到发起者。
 * - stop 只接受当前 sharer 的停止请求；过期请求忽略，避免旧包把新共享停掉。
 */
export function planRoomShareRequest(input: RoomShareRequestInput): RoomShareRequestPlan {
  const { action, fromPeerId, currentActiveSharerId, localPeerId, localIsSharing } = input;

  if (action === 'stop') {
    if (currentActiveSharerId !== null && currentActiveSharerId !== fromPeerId) {
      return {
        accepted: false,
        nextActiveSharerId: currentActiveSharerId,
        stopLocalShare: false,
        stopWatchingRemote: false,
        reason: 'stale-stop',
      };
    }
    return {
      accepted: true,
      nextActiveSharerId: null,
      stopLocalShare: false,
      stopWatchingRemote: false,
    };
  }

  // start 不允许静默抢占：占用中只能由 UI 明确发 takeover。
  if (action === 'start' && currentActiveSharerId !== null && currentActiveSharerId !== fromPeerId) {
    return {
      accepted: false,
      nextActiveSharerId: currentActiveSharerId,
      stopLocalShare: false,
      stopWatchingRemote: false,
      reason: 'occupied',
    };
  }

  const replacingOther =
    currentActiveSharerId !== null && currentActiveSharerId !== fromPeerId;
  return {
    accepted: true,
    nextActiveSharerId: fromPeerId,
    stopLocalShare: Boolean(localIsSharing && localPeerId !== fromPeerId),
    stopWatchingRemote: replacingOther,
  };
}
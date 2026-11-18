import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataConnection } from '../peerRuntime';
import { ChatSession, type ChatMessage } from './chatCore';

/** 聊天浮层 UI 需要的全部展示状态与回调，直接透传给 ChatPanel。 */
export interface RoomChatUi {
  role: 'sender' | 'viewer';
  open: boolean;
  connected: boolean;
  messages: ChatMessage[];
  onToggle: () => void;
  onClose: () => void;
  onSend: (text: string) => void;
  onExport: () => void;
}

export interface UseRoomChatOptions {
  onNotify?: (message: string, type: 'success' | 'info' | 'error') => void;
}

/** 供 ScreenShare 调用的命令面：连接接入、按房间重置、设置本端 id / 角色。 */
export interface RoomChatApi {
  ui: RoomChatUi;
  attachRoomConnection: (conn: DataConnection) => void;
  reset: (role: 'sender' | 'viewer') => void;
  setLocalPeerId: (peerId: string) => void;
  setRole: (role: 'sender' | 'viewer') => void;
}

/** 一条已接管的房间聊天连接及其监听器清理句柄。 */
export interface RoomChatAttachment {
  conn: DataConnection;
  dispose: () => void;
}

/**
 * 把一条 DataConnection 接到聊天会话上。
 *
 * 关键安全点：入站帧的可信来源固定取 `conn.peer`，而不是报文里的 fromPeerId；
 * 这样限流/去重/展示都绑定真实连接身份，载荷无法冒名或绕过配额。
 */
export function linkRoomChatConnection(
  conn: DataConnection,
  session: ChatSession | null,
  onChange: () => void,
): RoomChatAttachment {
  const onData = (raw: unknown) => {
    session?.receive(raw, conn.peer);
  };
  const onOpen = () => onChange();
  const onClose = () => onChange();
  const onError = () => onChange();
  conn.on('data', onData);
  conn.on('open', onOpen);
  conn.on('close', onClose);
  conn.on('error', onError);
  return {
    conn,
    dispose: () => {
      conn.off('data', onData);
      conn.off('open', onOpen);
      conn.off('close', onClose);
      conn.off('error', onError);
      try {
        conn.close();
      } catch {
        /* 已经关闭的连接不抛错，清理继续 */
      }
    },
  };
}

export type RoomChatSendResult = 'sent' | 'not-connected' | 'invalid';

export function hasOpenRoomChatConnection(connections: readonly RoomChatAttachment[]): boolean {
  return connections.some((item) => item.conn.open);
}

export function disposeRoomChatConnections(connections: readonly RoomChatAttachment[]): void {
  connections.forEach((item) => item.dispose());
}

/**
 * 摘掉已经 close/error 的死连接：不仅从数组移除，还要 off 掉 data/open/close/error
 * 四个监听并 close，避免死通道继续把消息灌进当前会话。
 */
export function pruneRoomChatConnections(
  connections: readonly RoomChatAttachment[],
): RoomChatAttachment[] {
  const alive: RoomChatAttachment[] = [];
  connections.forEach((item) => {
    if (item.conn.open) {
      alive.push(item);
    } else {
      item.dispose();
    }
  });
  return alive;
}

/** 向所有 open 的房间连接广播一条消息；本地历史由 ChatSession.compose 写入。 */
export function sendRoomChatText(
  session: ChatSession | null,
  connections: readonly RoomChatAttachment[],
  text: string,
): RoomChatSendResult {
  const openConnections = connections.filter((item) => item.conn.open);
  if (openConnections.length === 0) return 'not-connected';
  const message = session?.compose(text) ?? null;
  if (!message) return 'invalid';
  openConnections.forEach((item) => {
    try {
      item.conn.send(message);
    } catch {
      /* 单条发送失败不影响其他连接与本地历史 */
    }
  });
  return 'sent';
}

/**
 * 把「房间聊天」的传输与状态从组件里抽出来的独立 hook。
 * 传输逻辑（环形缓冲/去重/限流/导出）都在 chatCore，组件只拿这份命令面，
 * 不把 DataChannel 细节堆进 components/。
 */
export function useRoomChat({ onNotify }: UseRoomChatOptions = {}): RoomChatApi {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [role, setRoleState] = useState<'sender' | 'viewer'>('sender');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const sessionRef = useRef<ChatSession | null>(null);
  const connectionsRef = useRef<RoomChatAttachment[]>([]);

  useEffect(() => {
    const session = new ChatSession();
    sessionRef.current = session;
    setMessages(session.getMessages());
    const unsubscribe = session.subscribe(() => setMessages(session.getMessages()));
    return () => {
      unsubscribe();
      disposeRoomChatConnections(connectionsRef.current);
      connectionsRef.current = [];
      sessionRef.current = null;
    };
  }, []);

  const attachRoomConnection = useCallback((conn: DataConnection) => {
    if (connectionsRef.current.some((item) => item.conn === conn)) return;
    const syncConnected = () => setConnected(hasOpenRoomChatConnection(connectionsRef.current));
    const attachment = linkRoomChatConnection(conn, sessionRef.current, () => {
      // close/error 后把死连接连监听一起摘掉；open 时保留，connected 只看真正 open 的那几条。
      connectionsRef.current = pruneRoomChatConnections(connectionsRef.current);
      syncConnected();
    });
    connectionsRef.current.push(attachment);
    syncConnected();
  }, []);

  const reset = useCallback((nextRole: 'sender' | 'viewer') => {
    // 旧连接必须真正 off + close，否则重新进房后旧通道还会把消息灌进新会话。
    disposeRoomChatConnections(connectionsRef.current);
    sessionRef.current?.clear();
    connectionsRef.current = [];
    setConnected(false);
    setRoleState(nextRole);
    setMessages([]);
    // 新房间默认收起互动卡，等用户在主卡里点「加入聊天房间」再展开。
    setOpen(false);
  }, []);

  const send = useCallback(
    (text: string) => {
      const result = sendRoomChatText(sessionRef.current, connectionsRef.current, text);
      if (result === 'not-connected') onNotify?.('聊天尚未连接', 'error');
      if (result === 'invalid') onNotify?.('消息为空或超过 2KB，未发送', 'error');
    },
    [onNotify]
  );

  const exportTranscript = useCallback(() => {
    const text = sessionRef.current?.exportTranscript() ?? '';
    if (!text) {
      onNotify?.('没有可导出的聊天记录', 'info');
      return;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aerodrop-chat-${Date.now()}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [onNotify]);

  const setLocalPeerId = useCallback((peerId: string) => {
    sessionRef.current?.setLocalPeerId(peerId);
  }, []);

  const ui = useMemo<RoomChatUi>(
    () => ({
      role,
      open,
      connected,
      messages,
      onToggle: () => setOpen((prev) => !prev),
      onClose: () => setOpen(false),
      onSend: send,
      onExport: exportTranscript,
    }),
    [role, open, connected, messages, send, exportTranscript]
  );

  return { ui, attachRoomConnection, reset, setLocalPeerId, setRole: setRoleState };
}
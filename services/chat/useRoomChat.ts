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
  const connectionsRef = useRef<DataConnection[]>([]);

  useEffect(() => {
    const session = new ChatSession();
    sessionRef.current = session;
    setMessages(session.getMessages());
    const unsubscribe = session.subscribe(() => setMessages(session.getMessages()));
    return () => {
      unsubscribe();
      sessionRef.current = null;
      connectionsRef.current = [];
    };
  }, []);

  const attachRoomConnection = useCallback((conn: DataConnection) => {
    if (connectionsRef.current.includes(conn)) return;
    connectionsRef.current.push(conn);
    const session = sessionRef.current;
    conn.on('data', (raw: unknown) => {
      session?.receive(raw);
    });
    const syncConnected = () => {
      setConnected(connectionsRef.current.some((item) => item.open));
    };
    if (conn.open) syncConnected();
    conn.on('open', syncConnected);
    conn.on('close', () => {
      connectionsRef.current = connectionsRef.current.filter((item) => item !== conn);
      syncConnected();
    });
    conn.on('error', () => {
      connectionsRef.current = connectionsRef.current.filter((item) => item !== conn);
      syncConnected();
    });
  }, []);

  const reset = useCallback((nextRole: 'sender' | 'viewer') => {
    sessionRef.current?.clear();
    connectionsRef.current = [];
    setConnected(false);
    setRoleState(nextRole);
    setMessages([]);
  }, []);

  const send = useCallback(
    (text: string) => {
      const session = sessionRef.current;
      if (!session) return;
      const openConnections = connectionsRef.current.filter((item) => item.open);
      if (openConnections.length === 0) {
        onNotify?.('聊天尚未连接', 'error');
        return;
      }
      const message = session.compose(text);
      if (!message) {
        onNotify?.('消息为空或超过 2KB，未发送', 'error');
        return;
      }
      openConnections.forEach((conn) => {
        try {
          conn.send(message);
        } catch {
          /* 单条发送失败不影响其他连接与本地历史 */
        }
      });
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

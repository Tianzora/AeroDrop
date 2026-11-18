import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, X, Send, Download, WifiOff } from 'lucide-react';

export interface ChatPanelMessage {
  id: string;
  fromPeerId: string;
  ts: number;
  text: string;
}

export interface ChatPanelProps {
  /** sender=共享端浅色白卡；viewer=观看端深色玻璃浮层。 */
  role: 'sender' | 'viewer';
  open: boolean;
  connected: boolean;
  messages: ChatPanelMessage[];
  onToggle: () => void;
  onClose: () => void;
  onSend: (text: string) => void;
  onExport: () => void;
  /** 面板挂载但连接还没起来时给一句说明。 */
  connectingHint?: string;
}

const formatClock = (ts: number): string => {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const h = date.getHours();
  const m = date.getMinutes();
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`;
};

/**
 * 两端共用的聊天浮层（右下角）。纯展示 + 本地输入状态，传输逻辑在 ScreenShare 里。
 * 固定定位，不随共享/观看状态挂载卸载——停画面后聊天入口仍需保留。
 */
export const ChatPanel: React.FC<ChatPanelProps> = ({
  role,
  open,
  connected,
  messages,
  onToggle,
  onClose,
  onSend,
  onExport,
  connectingHint,
}) => {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const isViewer = role === 'viewer';

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const submit = () => {
    const text = draft;
    if (text.trim().length === 0) return;
    onSend(text);
    setDraft('');
  };

  const shell = isViewer
    ? 'bg-[rgba(15,23,36,0.86)] text-night-100 ring-1 ring-white/10 shadow-2xl'
    : 'bg-white text-slate-800 ring-1 ring-slate-100 shadow-card';
  const subtle = isViewer ? 'text-night-400' : 'text-slate-500';
  const bubble = isViewer ? 'bg-white/10 text-night-100' : 'bg-slate-100 text-slate-800';
  const inputShell = isViewer
    ? 'bg-black/30 text-white placeholder:text-night-500 ring-1 ring-white/10'
    : 'bg-slate-50 text-slate-800 placeholder:text-slate-400 ring-1 ring-slate-200';

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="打开聊天"
        title="聊天"
        className={`fixed bottom-4 right-4 z-50 inline-flex h-12 items-center gap-2 rounded-full px-4 text-sm font-medium backdrop-blur transition-colors ${
          isViewer
            ? 'bg-[rgba(15,23,36,0.86)] text-night-100 ring-1 ring-white/10 hover:bg-[rgba(15,23,36,0.95)]'
            : 'bg-white text-slate-700 ring-1 ring-slate-200 shadow-card hover:bg-slate-50'
        }`}
      >
        <MessageCircle size={18} />
        聊天
        {connected ? null : <WifiOff size={14} className="opacity-70" />}
      </button>
    );
  }

  return (
    <div className={`fixed bottom-4 right-4 z-50 flex max-h-[70vh] w-[20rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-card backdrop-blur-md ${shell}`}>
      <div className={`flex items-center gap-2 border-b px-3 py-2 ${isViewer ? 'border-white/10' : 'border-slate-100'}`}>
        <MessageCircle size={16} />
        <span className="text-sm font-semibold">聊天</span>
        <span className={`ml-1 inline-flex items-center gap-1 text-xs ${subtle}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-amber-400'}`} />
          {connected ? '已连接' : '未连接'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onExport}
          disabled={messages.length === 0}
          aria-label="导出聊天记录"
          title="导出聊天记录 (.txt)"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isViewer ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}
        >
          <Download size={16} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起聊天"
          title="收起"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors ${isViewer ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}
        >
          <X size={16} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 ? (
          <p className={`py-6 text-center text-xs leading-relaxed ${subtle}`}>
            {connected ? '晚加入者没有历史消息，聊两句吧' : connectingHint ?? '聊天连接尚未建立'}
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-0.5">
              <div className={`flex items-center gap-2 text-[11px] ${subtle}`}>
                <span className="max-w-[10rem] truncate">{message.fromPeerId}</span>
                <span>{formatClock(message.ts)}</span>
              </div>
              <div className={`w-fit max-w-full whitespace-pre-wrap break-words rounded-control px-2.5 py-1.5 text-sm ${bubble}`}>
                {message.text}
              </div>
            </div>
          ))
        )}
      </div>

      <div className={`flex items-center gap-2 border-t px-2 py-2 ${isViewer ? 'border-white/10' : 'border-slate-100'}`}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          maxLength={2000}
          disabled={!connected}
          placeholder={connected ? '输入消息，回车发送' : '连接后即可聊天'}
          className={`min-w-0 flex-1 rounded-full px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60 ${inputShell}`}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!connected || draft.trim().length === 0}
          aria-label="发送"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};
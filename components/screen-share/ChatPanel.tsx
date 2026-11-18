import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Download, WifiOff } from 'lucide-react';

export interface ChatPanelMessage {
  id: string;
  fromPeerId: string;
  ts: number;
  text: string;
}

export interface ChatPanelProps {
  /** sender=共享端；viewer=观看端。两端都用页面内嵌白卡，不再做悬浮玻璃层。 */
  role: 'sender' | 'viewer';
  connected: boolean;
  messages: ChatPanelMessage[];
  onSend: (text: string) => void;
  onExport: () => void;
  /** 面板已挂载但连接还没起来时给一句说明。 */
  connectingHint?: string;
  className?: string;
}

export const formatClock = (ts: number): string => {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const h = date.getHours();
  const m = date.getMinutes();
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`;
};

/** 抽出输入处理，组件只负责绑定，便于在 Node 里直接测试。 */
export const submitChatDraft = (
  draft: string,
  onSend: (text: string) => void,
  setDraft: (text: string) => void
): void => {
  if (draft.trim().length === 0) return;
  onSend(draft);
  setDraft('');
};

export const handleDraftChange = (
  setDraft: (text: string) => void,
  event: React.ChangeEvent<HTMLInputElement>
): void => {
  setDraft(event.target.value);
};

export const handleDraftKeyDown = (
  draft: string,
  onSend: (text: string) => void,
  setDraft: (text: string) => void,
  event: React.KeyboardEvent<HTMLInputElement>
): void => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitChatDraft(draft, onSend, setDraft);
  }
};

/**
 * 房间聊天面板：页面内嵌的一列，不再固定悬浮在右下角。
 * 纯展示 + 本地输入状态，传输逻辑在 ScreenShare 里；停画面后聊天入口仍需保留。
 */
export const ChatPanel: React.FC<ChatPanelProps> = ({
  role,
  connected,
  messages,
  onSend,
  onExport,
  connectingHint,
  className = '',
}) => {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const isViewer = role === 'viewer';

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <aside
      className={`flex h-full min-h-[24rem] flex-col overflow-hidden rounded-card border border-slate-100 bg-white shadow-card transition-colors dark:border-night-750 dark:bg-night-850 ${className}`}
      aria-label="房间聊天"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-night-750">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600 dark:bg-brand-500/12 dark:text-brand-400">
          <MessageCircle size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900 dark:text-night-100">聊天</p>
          <p className="text-[11px] text-slate-400 dark:text-night-500">
            仅本次房间 · 不持久保存
          </p>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 dark:text-night-400">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-amber-400'}`} />
          {connected ? '已连接' : '未连接'}
          {!connected && <WifiOff size={13} className="opacity-60" />}
        </span>
        <button
          type="button"
          onClick={onExport}
          disabled={messages.length === 0}
          aria-label="导出聊天记录"
          title="导出聊天记录 (.txt)"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-night-400 dark:hover:bg-night-750"
        >
          <Download size={16} />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[12rem] flex-col items-center justify-center px-4 text-center">
            <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-night-800 dark:text-night-500">
              <MessageCircle size={18} />
            </div>
            <p className="text-xs leading-relaxed text-slate-400 dark:text-night-500">
              {connected ? '晚加入者没有历史消息，聊两句吧' : connectingHint ?? '聊天连接尚未建立'}
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const mine = message.fromPeerId === 'me';
            const authorLabel = mine ? '我' : isViewer ? '房主' : '观众';
            return (
              <div key={message.id} className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
                <div className="flex items-center gap-2 px-1 text-[11px] text-slate-400 dark:text-night-500">
                  <span className="max-w-[10rem] truncate">{authorLabel}</span>
                  <span>{formatClock(message.ts)}</span>
                </div>
                <div
                  className={`w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-control px-3 py-2 text-sm ${
                    mine
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-800 dark:bg-night-800 dark:text-night-100'
                  }`}
                >
                  {message.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 p-3 dark:border-night-750">
        <input
          value={draft}
          onChange={handleDraftChange.bind(null, setDraft)}
          onKeyDown={handleDraftKeyDown.bind(null, draft, onSend, setDraft)}
          maxLength={2000}
          disabled={!connected}
          placeholder={connected ? '输入消息，回车发送' : '连接后即可聊天'}
          className="min-w-0 flex-1 rounded-full bg-slate-50 px-3.5 py-2.5 text-sm text-slate-800 outline-none ring-1 ring-slate-200 placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-night-800 dark:text-night-100 dark:ring-night-700 dark:placeholder:text-night-500"
        />
        <button
          type="button"
          onClick={submitChatDraft.bind(null, draft, onSend, setDraft)}
          disabled={!connected || draft.trim().length === 0}
          aria-label="发送"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={16} />
        </button>
      </div>
    </aside>
  );
};

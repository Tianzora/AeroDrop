import React, { useEffect, useRef, useState } from 'react';
import { Download, Headphones, MessageCircle, Send, WifiOff, X } from 'lucide-react';

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
  /** 收起右侧互动卡，回到只有主卡的布局。 */
  onClose?: () => void;
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
 * 右侧「互动」卡：默认不在页面里，由主卡上的「加入聊天房间」按钮展开。
 * 参考设计稿把聊天与语音放在同一列，用顶部 tab 切换；语音生产版尚未接入 M2，
 * 这里只展示规划说明，不伪造可通话控件。
 */
export const ChatPanel: React.FC<ChatPanelProps> = ({
  role,
  connected,
  messages,
  onSend,
  onExport,
  onClose,
  connectingHint,
  className = '',
}) => {
  const [draft, setDraft] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'voice'>('chat');
  const listRef = useRef<HTMLDivElement | null>(null);
  const isViewer = role === 'viewer';

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeTab]);

  return (
    <aside
      id="room-chat-panel"
      className={`flex h-full min-h-[24rem] flex-col overflow-hidden rounded-card border border-slate-100 bg-white shadow-card transition-colors dark:border-night-750 dark:bg-night-850 ${className}`}
      aria-label="房间聊天"
    >
      <div className="flex items-start gap-2 border-b border-slate-100 px-4 py-3 dark:border-night-750">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/12 dark:text-brand-400">
              <MessageCircle size={15} />
            </span>
            <p className="text-sm font-bold text-slate-900 dark:text-night-100">互动</p>
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-night-400">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-amber-400'}`} />
              {connected ? '已连接' : '未连接'}
              {!connected && <WifiOff size={12} className="opacity-60" />}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400 dark:text-night-500">聊天与语音独立于画面</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onExport}
            disabled={messages.length === 0}
            aria-label="导出聊天记录"
            title="导出聊天记录 (.txt)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-night-400 dark:hover:bg-night-750"
          >
            <Download size={16} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="收起聊天"
              title="收起聊天"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:text-night-500 dark:hover:bg-night-750 dark:hover:text-night-200"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-100 px-3 py-2 dark:border-night-750" role="tablist" aria-label="互动类型">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'chat'}
          onClick={() => setActiveTab('chat')}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-control text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${
            activeTab === 'chat'
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/12 dark:text-brand-300'
              : 'text-slate-500 hover:bg-slate-50 dark:text-night-400 dark:hover:bg-night-750'
          }`}
        >
          聊天
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
            {messages.length}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'voice'}
          onClick={() => setActiveTab('voice')}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-control text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${
            activeTab === 'voice'
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/12 dark:text-brand-300'
              : 'text-slate-500 hover:bg-slate-50 dark:text-night-400 dark:hover:bg-night-750'
          }`}
        >
          语音
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-slate-500 dark:bg-night-800 dark:text-night-400">
            即将
          </span>
        </button>
      </div>

      {activeTab === 'chat' ? (
        <>
          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" role="tabpanel" aria-label="聊天记录">
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
                const avatarTone = mine
                  ? 'bg-brand-600 text-white'
                  : isViewer
                    ? 'bg-orange-500 text-white'
                    : 'bg-violet-500 text-white';
                return (
                  <div key={message.id} className={`flex items-start gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone}`}
                    >
                      {authorLabel.slice(0, 1)}
                    </span>
                    <div className={`min-w-0 max-w-[85%] ${mine ? 'text-right' : 'text-left'}`}>
                      <div className={`flex items-center gap-2 px-1 text-[11px] text-slate-400 dark:text-night-500 ${mine ? 'justify-end' : ''}`}>
                        <span className="max-w-[10rem] truncate">{authorLabel}</span>
                        <span>{formatClock(message.ts)}</span>
                      </div>
                      <div
                        className={`mt-0.5 w-fit whitespace-pre-wrap break-words rounded-control px-3 py-2 text-sm ${
                          mine
                            ? 'ml-auto bg-brand-600 text-white'
                            : 'bg-slate-100 text-slate-800 dark:bg-night-800 dark:text-night-100'
                        }`}
                      >
                        {message.text}
                      </div>
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
        </>
      ) : (
        <div role="tabpanel" aria-label="语音规划" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/12 dark:text-brand-300">
            <Headphones size={22} />
          </div>
          <p className="text-sm font-bold text-slate-900 dark:text-night-100">语音通话</p>
          <p className="max-w-[15rem] text-xs leading-relaxed text-slate-400 dark:text-night-500">
            语音通话将在下一阶段接入麦克风轨。加入不自动开麦，每人音量可调 0–200%，按 64 kbps/人 预留带宽。
          </p>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500 dark:bg-night-800 dark:text-night-400">
            语音通道尚未接通
          </span>
        </div>
      )}
    </aside>
  );
};

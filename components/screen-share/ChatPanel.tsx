import React, { useEffect, useRef, useState } from 'react';
import { Download, Headphones, MessageCircle, Mic, MicOff, PhoneOff, Send, Volume2, WifiOff, X } from 'lucide-react';
import type { RoomVoiceApi } from '../../services/voice/useRoomVoice';
import { describeVoiceStatus } from '../../services/voice/voiceCore';
import type { LocalProfile } from '../../services/profile/localProfile';
import type { DisplayProfile } from '../../services/screenShare/peerProfile';

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
  /** 房间语音：与聊天同卡，语音页接真实麦克风控件。 */
  voice?: RoomVoiceApi;
  /** 本端真实 peer id（来自 conn.peer），用于判断「我的」消息。 */
  localPeerId?: string | null;
  /** 本机身份（昵称 + 头像）；缺省时回退「我」。 */
  localProfile?: LocalProfile;
  /** 房间内其它成员身份，键为真实 peerId。 */
  peerProfiles?: Record<string, DisplayProfile>;
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

export interface ResolvedAuthor {
  mine: boolean;
  name: string;
  avatar: string;
}

/**
 * 解析一条消息的展示身份。
 * - 本端：fromPeerId === 本端真实 peerId → 用本机昵称/头像，缺省「我」。
 * - 远端：优先用房间内交换到的身份；没有则回退「房主/观众」。
 * 身份只用于显示，聊天去重/限流仍由 chatCore 以真实 conn.peer 处理。
 */
export const resolveAuthor = (
  fromPeerId: string,
  localPeerId: string | null,
  localProfile: LocalProfile | undefined,
  peerProfiles: Record<string, DisplayProfile> | undefined,
  isViewer: boolean,
): ResolvedAuthor => {
  const mine = Boolean(localPeerId) && fromPeerId === localPeerId;
  if (mine) {
    const name = localProfile?.name?.trim() || '我';
    return { mine: true, name, avatar: localProfile?.avatar || name.slice(0, 1) };
  }
  const peer = peerProfiles?.[fromPeerId];
  const peerName = peer?.name?.trim();
  if (peerName) {
    return { mine: false, name: peerName, avatar: peer?.avatar || peerName.slice(0, 1) };
  }
  // 旧房主不会广播身份帧：观看端只连房主，回退「房主」仍然准确；
  // 发送端可能同时有多条真实 conn.peer，必须退化成可区分的短 peerId，不能全叫「观众」。
  const fallback = isViewer ? '房主' : `观众-${fromPeerId.slice(-4) || '未知'}`;
  return { mine: false, name: fallback, avatar: fallback.slice(0, 1) };
};

export const MemberRow: React.FC<{ avatar: string; name: string; isSelf?: boolean }> = ({
  avatar,
  name,
  isSelf,
}) => (
  <div className="flex items-center gap-2">
    <span
      aria-hidden="true"
      className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm"
    >
      {avatar}
    </span>
    <span className="min-w-0 max-w-40 truncate text-xs font-semibold text-slate-700">{name}</span>
    {isSelf && (
      <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">你</span>
    )}
  </div>
);

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
  voice,
  localPeerId = null,
  localProfile,
  peerProfiles,
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
      className={`flex h-full min-h-96 flex-col overflow-hidden rounded-card border border-slate-100 bg-white shadow-card transition-colors ${className}`}
      aria-label="房间聊天"
    >
      <div className="flex items-start gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-slate-100 text-slate-500">
              <MessageCircle size={15} />
            </span>
            <p className="text-sm font-bold text-slate-900">互动</p>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-amber-400'}`} />
              {connected ? '已连接' : '未连接'}
              {!connected && <WifiOff size={12} className="opacity-60" />}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">聊天与语音独立于画面</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onExport}
            disabled={messages.length === 0}
            aria-label="导出聊天记录"
            title="导出聊天记录 (.txt)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-control text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={16} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="收起聊天"
              title="收起聊天"
              className="inline-flex h-8 w-8 items-center justify-center rounded-control text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-100 px-3 py-2" role="tablist" aria-label="互动类型">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'chat'}
          onClick={() => setActiveTab('chat')}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-control text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${
            activeTab === 'chat'
              ? 'bg-brand-50 text-brand-700'
              : 'text-slate-500 hover:bg-slate-50'
          }`}
        >
          聊天
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-xs leading-none text-white">
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
              ? 'bg-brand-50 text-brand-700'
              : 'text-slate-500 hover:bg-slate-50'
          }`}
        >
          语音
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-semibold leading-none text-slate-500">
            {voice?.joined ? (voice.muted ? '静音' : '通话中') : '未加入'}
          </span>
        </button>
      </div>

      {activeTab === 'chat' ? (
        <>
          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" role="tabpanel" aria-label="聊天记录">
            {messages.length === 0 ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 text-center">
                <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <MessageCircle size={18} />
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  {connected ? '晚加入者没有历史消息，聊两句吧' : connectingHint ?? '聊天连接尚未建立'}
                </p>
              </div>
            ) : (
              messages.map((message) => {
                const { mine, name: authorLabel, avatar } = resolveAuthor(
                  message.fromPeerId,
                  localPeerId,
                  localProfile,
                  peerProfiles,
                  isViewer,
                );
                const avatarTone = mine ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700';
                return (
                  <div key={message.id} className={`flex items-start gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone}`}
                    >
                      {avatar}
                    </span>
                    <div className={`min-w-0 max-w-chat-bubble ${mine ? 'text-right' : 'text-left'}`}>
                      <div className={`flex items-center gap-2 px-1 text-xs text-slate-400 ${mine ? 'justify-end' : ''}`}>
                        <span className="max-w-40 truncate">{authorLabel}</span>
                        <span>{formatClock(message.ts)}</span>
                      </div>
                      <div
                        className={`mt-0.5 w-fit whitespace-pre-wrap break-words rounded-control px-3 py-2 text-sm ${
                          mine
                            ? 'ml-auto bg-brand-600 text-white'
                            : 'bg-slate-100 text-slate-800'
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

          <div className="flex items-center gap-2 border-t border-slate-100 p-3">
            <input
              value={draft}
              onChange={handleDraftChange.bind(null, setDraft)}
              onKeyDown={handleDraftKeyDown.bind(null, draft, onSend, setDraft)}
              maxLength={2000}
              disabled={!connected}
              placeholder={connected ? '输入消息，回车发送' : '连接后即可聊天'}
              className="min-w-0 flex-1 rounded-full bg-slate-50 px-3.5 py-2.5 text-sm text-slate-800 outline-none ring-1 ring-slate-200 placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={submitChatDraft.bind(null, draft, onSend, setDraft)}
              disabled={!connected || draft.trim().length === 0}
              aria-label="发送"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
        </>
      ) : (
        <div role="tabpanel" aria-label="房间语音" className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600">
              <Headphones size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900">房间语音</p>
              <p className="text-xs leading-relaxed text-slate-500">
                {voice
                  ? describeVoiceStatus({
                      joined: voice.joined,
                      muted: voice.muted,
                      remoteMemberCount: voice.remoteMemberCount,
                      error: voice.error,
                    })
                  : '语音通道未接入'}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2" aria-label="房间成员">
            <MemberRow avatar={localProfile?.avatar ?? '🙂'} name={localProfile?.name ?? '我'} isSelf />
            {Object.entries(peerProfiles ?? {}).filter(([peerId]) => peerId !== localPeerId).map(([peerId, peer]) => (
              <MemberRow key={peerId} avatar={peer.avatar} name={peer.name} />
            ))}
          </div>

          {voice && voice.error && (
            <p role="alert" className="rounded-control bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
              {voice.error}
            </p>
          )}

          {!voice?.joined ? (
            <button
              type="button"
              onClick={() => void voice?.joinVoice()}
              disabled={!voice}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-control bg-brand-600 px-4 text-sm font-bold text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Mic size={16} />
              加入语音
            </button>
          ) : (
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void voice.toggleMute()}
                  className={`inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-control text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${
                    voice.muted
                      ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {voice.muted ? <MicOff size={16} /> : <Mic size={16} />}
                  {voice.muted ? '取消静音' : '静音'}
                </button>
                <button
                  type="button"
                  onClick={voice.leaveVoice}
                  aria-label="离开语音"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-control border border-red-200 px-3 text-sm font-bold text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
                >
                  <PhoneOff size={16} />
                  离开
                </button>
              </div>

              <label className="flex flex-col gap-2 text-xs font-medium text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <Volume2 size={14} className="text-slate-500" />
                  对方音量
                  <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-700">
                    {voice.volume}%
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={10}
                  value={voice.volume}
                  onChange={(event) => voice.setVolume(Number(event.target.value))}
                  aria-label="对方音量"
                  className="h-2 w-full cursor-pointer accent-brand-600"
                  style={{ accentColor: 'var(--color-brand-600)' }}
                />
                <span className="text-xs text-slate-400">调节对端播放音量 0–200%（不会改变对方麦克风）</span>
              </label>
            </>
          )}
        </div>
      )}
    </aside>
  );
};

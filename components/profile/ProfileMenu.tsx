/**
 * 标题栏右上角的「头像 + 昵称」入口，点开后是「设置资料」弹窗。
 *
 * 只负责本机身份的编辑与持久化（localStorage），不触碰房间/peer 逻辑。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X } from 'lucide-react';
import {
  PROFILE_AVATARS,
  PROFILE_NAME_MAX_LENGTH,
  sanitizeProfileName,
} from '../../services/profile/localProfile';
import { useLocalProfile } from '../../services/profile/useLocalProfile';

export interface ProfileMenuProps {
  className?: string;
}

export const ProfileMenu: React.FC<ProfileMenuProps> = ({ className }) => {
  const { profile, setProfile } = useLocalProfile();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(profile.name);
  const [draftAvatar, setDraftAvatar] = useState(profile.avatar);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  const openModal = useCallback(() => {
    setDraftName(profile.name);
    setDraftAvatar(profile.avatar);
    setOpen(true);
  }, [profile.name, profile.avatar]);

  const closeModal = useCallback(() => setOpen(false), []);

  const save = useCallback(() => {
    setProfile({
      name: sanitizeProfileName(draftName, profile.name),
      avatar: draftAvatar,
    });
    setOpen(false);
  }, [draftName, draftAvatar, profile.name, setProfile]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        title="设置资料"
        aria-label="设置资料"
        aria-haspopup="dialog"
        className={`flex flex-none items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-2.5 transition-ui hover:border-brand-400 hover:bg-brand-50 ${className ?? ''}`}
      >
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-lg"
          aria-hidden="true"
        >
          {profile.avatar}
        </span>
        <span className="max-w-[88px] truncate text-xs font-bold text-slate-700">
          {profile.name}
        </span>
        <Pencil className="h-3 w-3 text-slate-400" aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-5 backdrop-blur-sm"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeModal();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="w-full max-w-[380px] rounded-[20px] bg-white p-5 shadow-card animate-pop-in"
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 id={titleId} className="text-base font-bold text-slate-800">
                  设置资料
                </h3>
                <button
                  type="button"
                  onClick={closeModal}
                  aria-label="关闭"
                  className="rounded-full p-1 text-slate-400 transition-ui hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <label
                htmlFor="profile-name"
                className="mb-1 block text-xs font-semibold text-slate-600"
              >
                昵称
              </label>
              <input
                id="profile-name"
                ref={nameInputRef}
                value={draftName}
                maxLength={PROFILE_NAME_MAX_LENGTH}
                placeholder="输入昵称"
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') save();
                }}
                className="h-[42px] w-full rounded-control border border-slate-200 px-3 text-sm text-slate-800 outline-none transition-ui focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
              />

              <p className="mb-2 mt-4 text-xs font-semibold text-slate-600">头像</p>
              <div className="grid grid-cols-6 gap-2" role="radiogroup" aria-label="选择头像">
                {PROFILE_AVATARS.map((avatar) => {
                  const active = draftAvatar === avatar;
                  return (
                    <button
                      key={avatar}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={`头像 ${avatar}`}
                      onClick={() => setDraftAvatar(avatar)}
                      className={`flex h-10 items-center justify-center rounded-control border text-xl transition-ui ${
                        active
                          ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/25'
                          : 'border-slate-200 bg-white hover:border-brand-400 hover:bg-brand-50'
                      }`}
                    >
                      {avatar}
                    </button>
                  );
                })}
              </div>

              <p className="mt-2.5 text-[11px] text-slate-400">仅保存在本机；允许重名。</p>

              <div className="mt-4 flex gap-2.5">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 rounded-control border border-slate-200 bg-white py-2.5 text-sm font-semibold text-slate-600 transition-ui hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={save}
                  className="flex-1 rounded-control bg-brand-600 py-2.5 text-sm font-semibold text-white transition-ui hover:bg-brand-700"
                >
                  保存
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default ProfileMenu;
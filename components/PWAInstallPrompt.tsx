import React, { useState, useEffect, useRef } from 'react';
import { Share, PlusSquare, X, Download } from 'lucide-react';

const PWA_PROMPT_DISMISS_UNTIL_KEY = 'aerodrop-pwa-prompt-dismiss-until';
const PWA_PROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export const PWAInstallPrompt: React.FC = () => {
  const [showPrompt, setShowPrompt] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const showPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPromptDismissed = () => {
    try {
      const raw = window.localStorage.getItem(PWA_PROMPT_DISMISS_UNTIL_KEY);
      if (!raw) return false;
      const dismissUntil = Number(raw);
      return Number.isFinite(dismissUntil) && dismissUntil > Date.now();
    } catch {
      return false;
    }
  };

  const setPromptDismissed = () => {
    try {
      const dismissUntil = Date.now() + PWA_PROMPT_COOLDOWN_MS;
      window.localStorage.setItem(PWA_PROMPT_DISMISS_UNTIL_KEY, String(dismissUntil));
    } catch {
      // Ignore storage errors.
    }
  };

  const dismissPrompt = () => {
    setShowPrompt(false);
    setPromptDismissed();
  };

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return;
    }
    if (isPromptDismissed()) {
      return;
    }

    // Android / Desktop
    const handleBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      e.preventDefault();
      setDeferredPrompt(e);
      // Wait a bit before showing to not be intrusive immediately
      if (showPromptTimeoutRef.current) {
        clearTimeout(showPromptTimeoutRef.current);
      }
      showPromptTimeoutRef.current = setTimeout(() => setShowPrompt(true), 1000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // iOS Detection
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIosDevice = /iphone|ipad|ipod/.test(userAgent);
    const isStandalone = window.navigator.standalone === true;

    if (isIosDevice && !isStandalone) {
      setIsIOS(true);
      // Show iOS prompt after a delay, then auto close after 6s.
      if (showPromptTimeoutRef.current) {
        clearTimeout(showPromptTimeoutRef.current);
      }
      showPromptTimeoutRef.current = setTimeout(() => {
        setShowPrompt(true);
        if (autoCloseTimeoutRef.current) {
          clearTimeout(autoCloseTimeoutRef.current);
        }
        autoCloseTimeoutRef.current = setTimeout(() => {
          setShowPrompt(false);
          setPromptDismissed();
        }, 6000);
      }, 1000);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      if (showPromptTimeoutRef.current) {
        clearTimeout(showPromptTimeoutRef.current);
      }
      if (autoCloseTimeoutRef.current) {
        clearTimeout(autoCloseTimeoutRef.current);
      }
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      setShowPrompt(false);
    } else {
      setPromptDismissed();
    }
    setDeferredPrompt(null);
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 sm:left-auto sm:right-4 sm:w-96">
      <div className="relative overflow-hidden rounded-[4px] border border-border bg-raised p-4 shadow-[var(--shadow-2)] motion-rise">
        <button onClick={dismissPrompt} aria-label="关闭" className="absolute right-2 top-2 rounded-full p-1 text-subtle hover:bg-sunken hover:text-text">
          <X size={16} />
        </button>
        <div className="flex gap-4">
          <div className="h-fit shrink-0 rounded-[4px] bg-accent/10 p-3">
            <Download size={24} className="text-accent" />
          </div>
          <div className="flex-1">
            <h3 className="mb-1 text-[15px] font-bold text-ink">安装 AeroDrop</h3>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">像原生应用一样使用，支持离线访问和全屏体验。</p>
            {isIOS ? (
              <div className="rounded-[4px] border border-border bg-sunken p-3 text-[12px] text-muted">
                <div className="mb-2 flex items-center gap-2">1. 点击浏览器底部的 <Share size={14} className="inline text-accent" /> 分享按钮</div>
                <div className="flex items-center gap-2">2. 选择 <PlusSquare size={14} className="inline text-muted" /> “添加到主屏幕”</div>
              </div>
            ) : (
              <button onClick={handleInstallClick} className="w-full rounded-[8px] bg-accent py-2 text-[13px] font-bold text-accent-contrast shadow-sm transition-colors hover:bg-[#C94815] active:scale-[0.98]">
                立即安装
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

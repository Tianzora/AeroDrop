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
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 z-50 animate-slide-up">
      <div className="bg-white dark:bg-slate-800 rounded-card shadow-card border border-slate-200 dark:border-slate-700 p-4 relative overflow-hidden">

        <button
          onClick={dismissPrompt}
          className="absolute top-1 right-1 inline-flex min-w-11 min-h-11 items-center justify-center rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          aria-label="关闭安装提示"
        >
          <X size={16} />
        </button>

        <div className="flex gap-4">
          <div className="bg-brand-100 dark:bg-brand-900/30 rounded-control p-3 h-fit shrink-0">
            <Download size={20} className="text-brand-600 dark:text-brand-400" />
          </div>

          <div className="flex-1">
            <h3 className="font-bold text-slate-900 dark:text-white mb-1">
              安装 AeroDrop
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3 leading-relaxed">
              像原生应用一样使用，支持离线访问和全屏体验。
            </p>

            {isIOS ? (
              <div className="bg-slate-50 dark:bg-slate-900/50 rounded-control p-3 text-xs text-slate-600 dark:text-slate-300 border border-slate-100 dark:border-slate-700/50">
                <div className="flex items-center gap-2 mb-2">
                  1. 点击浏览器底部的 <Share size={16} className="inline text-brand-500" /> 分享按钮
                </div>
                <div className="flex items-center gap-2">
                  2. 选择 <PlusSquare size={16} className="inline text-slate-500" /> "添加到主屏幕"
                </div>
              </div>
            ) : (
              <button
                onClick={handleInstallClick}
                className="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold py-2 rounded-control transition-colors shadow-sm active:scale-[0.98]"
              >
                立即安装
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

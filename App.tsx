import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShieldAlert, X } from 'lucide-react';
import { ScreenShare } from './components/ScreenShare';
import { TopBar } from './components/layout/TopBar';
import { AppShell } from './components/layout/AppShell';
const LazyToaster = lazy(() => import('./components/ui/sonner').then((m) => ({ default: m.Toaster })));
import { AppNotification } from './types';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { getInitialDeviceName } from './services/deviceName';
import {
  getInitialRouteState,
  type InitialRouteState,
  type Mode,
} from './services/initialRouteState';
import { shouldEnqueueNotification } from './services/notificationPolicy';
import { appendNetworkProfileQuery, getBrowserNetworkProfile } from './services/networkProfile';
import { writeScreenShareViewSession } from './services/screenShareViewerSession';
import { logDebug } from './services/diagnostics';

type IdleCapableWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions
  ) => number;
};

const scheduleIdleTask = (callback: () => void, timeout = 2000): (() => void) => {
  if (typeof window === 'undefined') {
    callback();
    return () => {};
  }

  const idleWindow = window as IdleCapableWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, Math.min(timeout, 1500));
  return () => window.clearTimeout(handle);
};

interface NetworkCheckResponse {
  isRisk: boolean;
  reason: 'isp' | 'score' | 'location' | 'network' | null;
  details: string;
  isp: string;
  country: string;
}

const RISK_BANNER_DISMISS_UNTIL_KEY = 'aerodrop-risk-banner-dismiss-until';
const NOTIFICATION_DEDUPE_WINDOW_MS = 1500;

const App: React.FC = () => {
  const [initialRoute] = useState<InitialRouteState>(() => getInitialRouteState());
  const [mode, setMode] = useState<Mode>(initialRoute.mode);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showRiskBanner, setShowRiskBanner] = useState(false);
  const [isRiskBannerExpanded, setIsRiskBannerExpanded] = useState(false);
  const [swUpdateReady, setSwUpdateReady] = useState(false);
  const [isApplyingSwUpdate, setIsApplyingSwUpdate] = useState(false);
  const [deviceName] = useState<string>(() => getInitialDeviceName());
  const swUpdateReloadTimerRef = useRef<number | null>(null);
  const initialCode = initialRoute.code;
  const initialViewId = initialRoute.viewId;

  const isRiskBannerDismissed = () => {
    try {
      const raw = window.localStorage.getItem(RISK_BANNER_DISMISS_UNTIL_KEY);
      if (!raw) return false;
      const dismissUntil = Number(raw);
      return Number.isFinite(dismissUntil) && dismissUntil > Date.now();
    } catch {
      return false;
    }
  };

  const dismissRiskBanner = () => {
    setShowRiskBanner(false);
    setIsRiskBannerExpanded(false);
    try {
      const dismissUntil = Date.now() + 24 * 60 * 60 * 1000;
      window.localStorage.setItem(RISK_BANNER_DISMISS_UNTIL_KEY, String(dismissUntil));
    } catch {
      // Ignore persistence errors and still hide for current session.
    }
  };

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    let registrationRef: ServiceWorkerRegistration | null = null;
    let installingWorkerRef: ServiceWorker | null = null;

    const markUpdateReady = () => {
      if (cancelled) return;
      setSwUpdateReady(true);
    };

    const onInstallingStateChange = () => {
      if (!installingWorkerRef) return;
      if (installingWorkerRef.state === 'installed' && navigator.serviceWorker.controller) {
        markUpdateReady();
      }
    };

    const onUpdateFound = () => {
      if (!registrationRef) return;
      installingWorkerRef = registrationRef.installing;
      if (!installingWorkerRef) return;
      installingWorkerRef.addEventListener('statechange', onInstallingStateChange);
    };

    navigator.serviceWorker.getRegistration()
      .then((registration) => {
        if (cancelled || !registration) return;
        registrationRef = registration;
        if (registration.waiting) {
          markUpdateReady();
        }
        registration.addEventListener('updatefound', onUpdateFound);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (registrationRef) {
        registrationRef.removeEventListener('updatefound', onUpdateFound);
      }
      if (installingWorkerRef) {
        installingWorkerRef.removeEventListener('statechange', onInstallingStateChange);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (swUpdateReloadTimerRef.current !== null) {
        window.clearTimeout(swUpdateReloadTimerRef.current);
        swUpdateReloadTimerRef.current = null;
      }
    };
  }, []);

  const applySwUpdate = () => {
    if (isApplyingSwUpdate) return;
    setIsApplyingSwUpdate(true);

    const forceReload = () => {
      if (swUpdateReloadTimerRef.current !== null) {
        window.clearTimeout(swUpdateReloadTimerRef.current);
        swUpdateReloadTimerRef.current = null;
      }
      window.location.reload();
    };

    if (!('serviceWorker' in navigator)) {
      forceReload();
      return;
    }

    navigator.serviceWorker.getRegistration()
      .then((registration) => {
        const waiting = registration?.waiting;
        if (!waiting) {
          forceReload();
          return;
        }

        const onControllerChange = () => {
          navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
          forceReload();
        };
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

        swUpdateReloadTimerRef.current = window.setTimeout(() => {
          navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
          forceReload();
        }, 2000);

        waiting.postMessage({ type: 'SKIP_WAITING' });
      })
      .catch(() => {
        forceReload();
      });
  };

  useEffect(() => {
    const checkNetwork = async () => {
      try {
        const url = new URL('/api/network-check', window.location.origin);
        appendNetworkProfileQuery(url.searchParams, getBrowserNetworkProfile());
        const res = await fetch(url.toString());

        // Check if the response is JSON (Cloudflare Functions return JSON)
        // In local Vite dev without wrangler, this returns index.html (text/html)
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return;
        }

        const data = await res.json() as NetworkCheckResponse;
        if (data.isRisk && !isRiskBannerDismissed()) {
          setShowRiskBanner(true);
        }
      } catch (error) {
        logDebug('warn', 'Failed to check network status:', error);
      }
    };

    const cancelIdleTask = scheduleIdleTask(() => {
      void checkNetwork();
    }, 2500);

    return cancelIdleTask;
  }, []);

  useEffect(() => {
    let isUnmounted = false;
    let timer: number | null = null;

    const sendHeartbeat = async () => {
      try {
        const res = await fetch('/api/ping', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
          },
          body: 'ping',
          cache: 'no-store',
          keepalive: true,
        });

        if (!isUnmounted && res.ok) {
          const text = await res.text();
          if (text !== 'pong') {
            logDebug('warn', 'Unexpected heartbeat response:', text);
          }
        }
      } catch {
        // Keep heartbeat silent to avoid noisy user-facing errors.
      }
    };

    const cancelIdleTask = scheduleIdleTask(() => {
      if (isUnmounted) return;
      void sendHeartbeat();
      timer = window.setInterval(sendHeartbeat, 30_000);
    }, 4000);

    return () => {
      isUnmounted = true;
      cancelIdleTask();
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (initialRoute.hadDeepLink) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [initialRoute.hadDeepLink]);

  useEffect(() => {
    if (initialRoute.mode !== 'screen' || !initialRoute.viewId) {
      return;
    }

    writeScreenShareViewSession(
      (key, value) => window.sessionStorage.setItem(key, value),
      initialRoute.viewId,
    );
  }, [initialRoute.mode, initialRoute.viewId]);

  useEffect(() => {
    // Touch/coarse-pointer devices don't benefit from mouse glow tracking.
    if (
      window.matchMedia('(any-hover: none)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    ) {
      return;
    }

    const docEl = document.documentElement;
    let rafId: number | null = null;
    let pendingX = 0;
    let pendingY = 0;

    const flushMousePosition = () => {
      docEl.style.setProperty('--mouse-x', `${pendingX}px`);
      docEl.style.setProperty('--mouse-y', `${pendingY}px`);
      rafId = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (rafId === null) {
        rafId = window.requestAnimationFrame(flushMousePosition);
      }
    };
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const addNotification = (message: string, type: 'success' | 'info' | 'error') => {
    const now = Date.now();
    const id = now.toString() + Math.random().toString(36).substring(2, 9);
    setNotifications((prev) => {
      if (!shouldEnqueueNotification(prev, { message, type, now, dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS })) {
        return prev;
      }
      return [...prev, { id, message, type, timestamp: now }];
    });

    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  const seenToastIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    notifications.forEach((n) => {
      if (seenToastIds.current.has(n.id)) return;
      seenToastIds.current.add(n.id);
      import('sonner').then(({ toast }) => toast[n.type](n.message));
    });
  }, [notifications]);


  return (
    <AppShell
      topBar={
        <TopBar
          mode={mode}
          onModeChange={setMode}
          onBrandClick={() => setMode('send')}
          banner={
            showRiskBanner ? (
              <>
                <div className="hidden items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 sm:flex">
                  <ShieldAlert className="h-4 w-4 text-warning" />
                  <span className="text-[12px] font-medium text-warning">代理网络可能影响 P2P 传输与屏幕共享，建议关闭代理</span>
                  <button onClick={dismissRiskBanner} aria-label="关闭警告" className="ml-1 rounded-full p-0.5 text-warning hover:bg-warning/15">
                    <X size={14} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRiskBannerExpanded(!isRiskBannerExpanded)}
                  aria-label="查看网络警告"
                  className="relative rounded-full p-2 text-warning hover:bg-warning/10 sm:hidden"
                >
                  <ShieldAlert className="h-5 w-5" />
                  {!isRiskBannerExpanded && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />}
                </button>
              </>
            ) : null
          }
        />
      }
      footer={
        <footer className="mt-10 text-center text-[12px] text-subtle">
          Powered by WebRTC · 数据直接在设备间点对点传输，不经过云端存储。
        </footer>
      }
      overlays={
        <>
          <Suspense fallback={null}><LazyToaster /></Suspense>
          {swUpdateReady && (
            <div className="fixed inset-x-4 top-4 z-50 sm:left-auto sm:right-4 sm:w-96">
              <div className="flex items-center justify-between gap-3 rounded-[14px] border border-info/30 bg-raised px-4 py-3 shadow-[var(--shadow-2)]">
                <p className="text-[13px] font-medium text-text">发现新版本，刷新以避免新旧版本混用导致连接异常。</p>
                <button
                  onClick={applySwUpdate}
                  disabled={isApplyingSwUpdate}
                  className="shrink-0 rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-contrast hover:bg-[#C94815] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isApplyingSwUpdate ? '更新中…' : '立即刷新'}
                </button>
              </div>
            </div>
          )}
          <PWAInstallPrompt />
        </>
      }
    >
      {showRiskBanner && isRiskBannerExpanded && (
        <div className="mb-4 flex items-start gap-3 rounded-[12px] border border-warning/30 bg-warning/10 px-4 py-3 sm:hidden">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="mb-1 text-[13px] font-semibold text-warning">网络环境受限</p>
            <p className="text-[12px] leading-relaxed text-warning/90">
              检测到当前网络可能限制 P2P 打洞（如代理、移动网络或跨境链路），系统会优先尝试更稳的连接方式。
            </p>
          </div>
          <button onClick={dismissRiskBanner} aria-label="关闭警告" className="-mr-1 -mt-1 rounded-full p-1 text-warning hover:bg-warning/15">
            <X size={16} />
          </button>
        </div>
      )}
      <div className="flex w-full flex-1 flex-col">
        <ErrorBoundary>
          {mode === 'send' && <Sender onNotification={addNotification} deviceName={deviceName} />}
          {mode === 'receive' && <Receiver initialCode={initialCode} onNotification={addNotification} deviceName={deviceName} />}
          {mode === 'screen' && <ScreenShare initialViewId={initialViewId} onNotification={addNotification} />}
        </ErrorBoundary>
      </div>
    </AppShell>
  );
};

export default App;

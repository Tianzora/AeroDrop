import React, { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Send, Inbox, Monitor, Package, ShieldAlert, X } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { ScreenShare } from './components/ScreenShare';
import { AppNotification } from './types';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { getInitialDeviceName } from './services/deviceName';
import {
  getInitialRouteState,
  type InitialRouteState,
  type Mode,
} from './services/initialRouteState';
import { shouldEnqueueNotification } from './services/notificationPolicy';
import { TOASTER_PROPS } from './components/toasterProps';
import { appendNetworkProfileQuery, getBrowserNetworkProfile } from './services/networkProfile';
import { writeScreenShareViewSession } from './services/screenShareViewerSession';
import { MODE_ORDER, resolveSwipeTarget, SwipeTracker } from './services/swipeNavigation';
import { useReducedMotion } from 'motion/react';
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

// 命中这些元素时不接管手势：按钮/输入/链接自己要用触摸，滚动区与视频控件也一样。
const SWIPE_IGNORE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[contenteditable="true"]',
  '[role="slider"]',
  '[data-swipe-ignore]',
].join(',');

// 卡片翻面：旧面板转到侧立，新面板从镜像侧转回来。翻向由目标标签在 MODE_ORDER 中的位置决定。
// 节奏参考「先快后慢」：离开 120ms 加速，落定 170ms 减速（总 290ms < 300ms 的体感上限）。
// 缓动与应用里 --ease-ui 的曲线一致，只是离开段换成加速曲线（离开的物体应当越走越快）。
const FLIP_LEAVE_MS = 120;
const FLIP_ARRIVE_MS = 170;
const FLIP_EDGE_SCALE = 0.985;
const FLIP_EASE_LEAVE = 'cubic-bezier(0.3, 0, 1, 1)';
const FLIP_EASE_ARRIVE = 'cubic-bezier(0.23, 1, 0.32, 1)';

// 侧立前略带收缩，让翻转有纵深；回到正面时恢复原尺寸。
const flipScaleAt = (angle: number) => 1 - (1 - FLIP_EDGE_SCALE) * (Math.min(Math.abs(angle), 90) / 90);
const flipFrame = (angle: number) => `rotateY(${angle}deg) scale(${flipScaleAt(angle)})`;

/** 读当前翻转角度。matrix3d 按列主序序列化：m31 = -sinθ，m11 = cosθ。 */
const readPanelAngle = (panel: HTMLElement): number => {
  const computed = getComputedStyle(panel).transform;
  if (!computed || computed === 'none') return 0;
  const values = computed.slice(computed.indexOf('(') + 1, -1).split(',').map(Number);
  return (Math.atan2(-values[2], values[0]) * 180) / Math.PI;
};

const animatePanel = (panel: HTMLElement, from: number, to: number, duration: number, easing: string) => {
  const animation = panel.animate([{ transform: flipFrame(from) }, { transform: flipFrame(to) }], {
    duration,
    easing,
    fill: 'both',
  });
  return animation;
};

const App: React.FC = () => {
  const [initialRoute] = useState<InitialRouteState>(() => getInitialRouteState());
  const [mode, setMode] = useState<Mode>(initialRoute.mode);
  // Toast 由 sonner 渲染；这里只保留去重窗口内的记录，用同一个 notificationPolicy 判重。
  const recentNotificationsRef = useRef<AppNotification[]>([]);
  const [showRiskBanner, setShowRiskBanner] = useState(false);
  const [isRiskBannerExpanded, setIsRiskBannerExpanded] = useState(false);
  const [swUpdateReady, setSwUpdateReady] = useState(false);
  const [isApplyingSwUpdate, setIsApplyingSwUpdate] = useState(false);
  const [deviceName] = useState<string>(() => getInitialDeviceName());
  const swUpdateReloadTimerRef = useRef<number | null>(null);
  const initialCode = initialRoute.code;
  const initialViewId = initialRoute.viewId;
  // 每个页面自己报告「是否正忙」：传输、接收、共享进行中不允许侧滑切走。
  const [busyByMode, setBusyByMode] = useState<Record<Mode, boolean>>({
    send: false,
    receive: false,
    screen: false,
  });
  const swipeTrackerRef = useRef<SwipeTracker>(new SwipeTracker());
  const swipePointerIdRef = useRef<number | null>(null);

  const setSendBusy = useCallback((busy: boolean) => {
    setBusyByMode((prev) => (prev.send === busy ? prev : { ...prev, send: busy }));
  }, []);
  const setReceiveBusy = useCallback((busy: boolean) => {
    setBusyByMode((prev) => (prev.receive === busy ? prev : { ...prev, receive: busy }));
  }, []);
  const setScreenBusy = useCallback((busy: boolean) => {
    setBusyByMode((prev) => (prev.screen === busy ? prev : { ...prev, screen: busy }));
  }, []);

  // 卡片翻面：面板转到侧立时换内容，再从镜像侧落回。中途再次切页会打断当前翻转，
  // 从当前角度接着转（不从头重播），这样连点标签也不会出现「回到第一帧」的卡顿感。
  const panelRef = useRef<HTMLDivElement>(null);
  const shownModeRef = useRef<Mode>(mode);
  const flipTokenRef = useRef(0);
  // 指示器与标签高亮立即跟手，面板内容等转到侧立才换：点击的反馈不必等翻面结束。
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const activeMode = pendingMode ?? mode;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    shownModeRef.current = mode;
  }, [mode]);

  const runFlip = async (panel: HTMLElement, fromAngle: number, target: Mode, token: number) => {
    const stale = () => flipTokenRef.current !== token;
    const shown = shownModeRef.current;

    // 目标就是当前页：从当前角度回到正面，不再换内容。
    if (target === shown) {
      if (Math.abs(fromAngle) < 0.5) {
        setPendingMode(null);
        return;
      }
      const settleDuration = Math.max(90, (FLIP_ARRIVE_MS * Math.abs(fromAngle)) / 90);
      const settle = animatePanel(panel, fromAngle, 0, settleDuration, FLIP_EASE_ARRIVE);
      await settle.finished.catch(() => {});
      if (stale()) return;
      settle.cancel();
      panel.style.transform = '';
      panel.style.willChange = '';
      setPendingMode(null);
      return;
    }

    const edge = MODE_ORDER.indexOf(target) > MODE_ORDER.indexOf(shown) ? -90 : 90;
    const leaveDuration = Math.max(70, (FLIP_LEAVE_MS * Math.abs(edge - fromAngle)) / 90);
    const leave = animatePanel(panel, fromAngle, edge, leaveDuration, FLIP_EASE_LEAVE);
    await leave.finished.catch(() => {});
    if (stale()) return;
    // 侧立时面板不可见，换内容与角度跳变都不会被看到。
    leave.cancel();
    panel.style.transform = flipFrame(edge);
    // flushSync 让新页面在这一帧就提交，落定动画开始时已经是新内容，不会先露一帧旧页面。
    flushSync(() => {
      shownModeRef.current = target;
      setMode(target);
    });
    if (stale()) return;
    panel.style.transform = flipFrame(-edge);
    const arrive = animatePanel(panel, -edge, 0, FLIP_ARRIVE_MS, FLIP_EASE_ARRIVE);
    await arrive.finished.catch(() => {});
    if (stale()) return;
    arrive.cancel();
    panel.style.transform = '';
    panel.style.willChange = '';
    setPendingMode(null);
  };

  const changeMode = useCallback(
    (next: Mode) => {
      const panel = panelRef.current;
      // 点的是当前页、且没有正在进行的翻转：什么都不做，免得留下 will-change 与 inline transform。
      if (next === shownModeRef.current) {
        const idle = !panel || (panel.getAnimations().length === 0 && Math.abs(readPanelAngle(panel)) < 0.5);
        if (idle) return;
      }
      const token = flipTokenRef.current + 1;
      flipTokenRef.current = token;
      // 面板还没挂载、或者系统要求减少动态效果时直接换，不做翻转。
      if (!panel || reduceMotion) {
        panel?.getAnimations().forEach((animation) => animation.cancel());
        if (panel) {
          panel.style.transform = '';
          panel.style.willChange = '';
        }
        setPendingMode(null);
        setMode(next);
        return;
      }
      setPendingMode(next);
      const fromAngle = readPanelAngle(panel);
      panel.getAnimations().forEach((animation) => animation.cancel());
      panel.style.transform = flipFrame(fromAngle);
      panel.style.willChange = 'transform';
      void runFlip(panel, fromAngle, next, token);
    },
    [reduceMotion],
  );

  // 首屏沿用翻转入场（与应用里 240ms 的基础时长一致）
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || reduceMotion) return;
    const enter = animatePanel(panel, -90, 0, 240, FLIP_EASE_ARRIVE);
    return () => enter.cancel();
  }, [reduceMotion]);

  // 移动端横向滑动切换页面。判定交给 SwipeTracker（纯逻辑、有单测），这里只负责
  // 事件接线：按下时先不抢指针，横向锁定后才 setPointerCapture，避免影响到点击和滚动。
  const swipeEnabled = !busyByMode[mode];

  const handleSwipePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!swipeEnabled) return;
    if ((event.target as Element).closest?.(SWIPE_IGNORE_SELECTOR)) return;
    swipeTrackerRef.current.begin({
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
      timeStamp: event.timeStamp,
      viewportWidth: window.innerWidth,
    });
  };

  const handleSwipePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const tracker = swipeTrackerRef.current;
    if (!tracker.isTracking) return;
    tracker.move(event.clientX, event.clientY);
    if (tracker.isHorizontal && swipePointerIdRef.current === null) {
      swipePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const finishSwipe = (event: React.PointerEvent<HTMLElement>) => {
    const tracker = swipeTrackerRef.current;
    if (!tracker.isTracking) return;
    const direction = tracker.end(event.clientX, event.timeStamp);
    if (swipePointerIdRef.current === event.pointerId) {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      swipePointerIdRef.current = null;
    }
    if (!direction) return;
    const next = resolveSwipeTarget(shownModeRef.current, direction);
    if (next) changeMode(next);
  };

  const handleSwipePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    swipeTrackerRef.current.cancel();
    if (swipePointerIdRef.current === event.pointerId) swipePointerIdRef.current = null;
  };

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

  const addNotification = (message: string, type: 'success' | 'info' | 'error') => {
    const now = Date.now();
    const recent = recentNotificationsRef.current;
    if (!shouldEnqueueNotification(recent, { message, type, now, dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS })) {
      return;
    }
    recentNotificationsRef.current = [
      ...recent.filter(n => now - n.timestamp < NOTIFICATION_DEDUPE_WINDOW_MS),
      { id: String(now), message, type, timestamp: now },
    ];

    const notify = type === 'success' ? toast.success : type === 'error' ? toast.error : toast.info;
    notify(message, { duration: 4000 });
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 dark:bg-night-950 flex flex-col transition-colors motion-base relative overflow-hidden">
      {swUpdateReady && (
        <div className="fixed top-[calc(env(safe-area-inset-top)+1rem)] left-4 right-4 md:left-auto md:right-4 z-50 pointer-events-auto">
          <div className="flex items-center justify-between gap-3 rounded-control border border-brand-100 bg-brand-50/95 px-4 py-3 text-brand-900 shadow-lg backdrop-blur dark:border-brand-500/30 dark:bg-night-900/95 dark:text-brand-200">
            <p className="text-sm font-medium">发现新版本</p>
            <button
              onClick={applySwUpdate}
              className="shrink-0 rounded-control bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isApplyingSwUpdate}
            >
              {isApplyingSwUpdate ? '更新中...' : '立即刷新'}
            </button>
          </div>
        </div>
      )}

      {/* sonner：官方 toast 组件，自带图标、堆叠、滑动手势与深浅色主题；固定底部避免遮挡顶部导航 */}
      <Toaster {...TOASTER_PROPS} />

            {/* 顶部留出 env(safe-area-inset-top)：PWA/刘海屏下让 header 自己的底色铺到状态栏后面（沉浸），
          而不是让状态栏区域露出页面底色。 */}
      <header className="bg-white dark:bg-night-900 border-b border-slate-200 dark:border-night-750 sticky top-0 z-20 pt-[env(safe-area-inset-top)] transition-colors motion-base">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-14 md:h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => changeMode('send')}>
            <div className="bg-brand-600 p-1.5 md:p-2 rounded-[26.5%] text-white shadow-sm">
              <Package size={20} className="md:w-6 md:h-6" />
            </div>
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-night-100 tracking-tighter">AeroDrop</h1>
              <span className="text-xs font-bold tracking-tight text-brand-600 dark:text-brand-400 pb-0.5">
                @Tian
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {showRiskBanner && (
              <>
                {/* Desktop Badge */}
                <div className="hidden sm:flex items-center gap-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-full px-3 py-1.5 animate-slide-up">
                  <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    检测到代理网络，点对点传输和屏幕共享可能失效，建议关闭代理
                  </span>
                  <button
                    onClick={dismissRiskBanner}
                    className="relative ml-1 p-2 rounded-full after:absolute after:-inset-2 after:content-[''] hover:bg-amber-100 dark:hover:bg-amber-800/50 text-amber-500 dark:text-amber-400 transition-colors"
                    aria-label="关闭警告"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Mobile Icon Button */}
                <button
                  className={`sm:hidden inline-flex min-w-11 min-h-11 items-center justify-center rounded-full transition-colors relative ${
                    isRiskBannerExpanded
                      ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : 'text-amber-500 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30'
                  }`}
                  onClick={() => setIsRiskBannerExpanded(!isRiskBannerExpanded)}
                  aria-label="查看网络警告"
                >
                  <ShieldAlert className="w-5 h-5" />
                  {!isRiskBannerExpanded && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white dark:ring-night-900"></span>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Mobile only banner - Expandable */}
      {showRiskBanner && isRiskBannerExpanded && (
        <div className="sm:hidden bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200 dark:border-amber-500/30 px-4 py-3 flex items-start gap-3 animate-slide-down relative z-10 shadow-sm">
          <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
             <p className="text-xs font-medium text-amber-800 dark:text-amber-200 mb-1">
                网络环境受限
             </p>
              <p className="text-xs text-amber-700/80 dark:text-amber-300/80 leading-relaxed">
                 检测到当前网络可能限制 P2P 打洞，将优先尝试更稳的连接方式
              </p>
           </div>
          <button
            onClick={() => {
              dismissRiskBanner();
            }}
            className="inline-flex min-w-11 min-h-11 items-center justify-center -mr-2 -my-2 rounded-full hover:bg-amber-100 dark:hover:bg-amber-800/50 text-amber-500 dark:text-amber-400"
            aria-label="关闭警告"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <main
        className="flex-1 flex flex-col items-center justify-start pt-4 md:pt-8 pb-8 px-3 md:px-4 w-full max-w-5xl mx-auto overflow-hidden"
        // 允许纵向滚动与缩放，横向手势留给下面的 pointer 监听（浏览器就不会把横向拖动
        // 当成自己的手势而发 pointercancel）；视频控件、输入框等见 SWIPE_IGNORE_SELECTOR。
        style={{ touchAction: 'pan-y pinch-zoom' }}
        onPointerDown={handleSwipePointerDown}
        onPointerMove={handleSwipePointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={handleSwipePointerCancel}
      >

        <div className="w-full max-w-xl mb-8 relative z-10">
            <div className="bg-white dark:bg-night-900 p-1.5 rounded-full grid grid-cols-3 relative shadow-card border border-slate-50 dark:border-night-750">
              <div
                  className="absolute top-1.5 left-1.5 bottom-1.5 w-[calc((100%-0.75rem)/3)] bg-brand-600 dark:bg-brand-500 rounded-full shadow-[inset_2px_2px_6px_rgba(0,0,0,0.2)]"
                  style={{
                    transform: `translateX(${activeMode === 'send' ? '0%' : activeMode === 'receive' ? '100%' : '200%'})`,
                    transition: 'transform var(--dur-base) var(--ease-move)'
                  }}
              ></div>

              <button
                onClick={() => changeMode('send')}
                aria-pressed={activeMode === 'send'}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-[color] motion-fast whitespace-nowrap ${
                  activeMode === 'send'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-night-400 dark:hover:text-night-100'
                }`}
              >
                <Send size={18} className={`transition-transform motion-base ${activeMode === 'send' ? 'scale-110' : ''}`} />
                发送
              </button>
              <button
                onClick={() => changeMode('receive')}
                aria-pressed={activeMode === 'receive'}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-[color] motion-fast whitespace-nowrap ${
                  activeMode === 'receive'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-night-400 dark:hover:text-night-100'
                }`}
              >
                <Inbox size={18} className={`transition-transform motion-base ${activeMode === 'receive' ? 'scale-110' : ''}`} />
                接收
              </button>
              <button
                onClick={() => changeMode('screen')}
                aria-pressed={activeMode === 'screen'}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-[color] motion-fast whitespace-nowrap ${
                  activeMode === 'screen'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-night-400 dark:hover:text-night-100'
                }`}
              >
                <Monitor size={18} className={`transition-transform motion-base ${activeMode === 'screen' ? 'scale-110' : ''}`} />
                共享
              </button>
            </div>
        </div>

        <div className="w-full flex-1 flex flex-col">
          <div className="flex-1" style={{ perspective: 1400 }}>
            <ErrorBoundary>
              <div ref={panelRef} className="h-full" style={{ transformOrigin: '50% 50%' }}>
                {mode === 'send' && (
                  <Sender
                    onNotification={addNotification}
                    deviceName={deviceName}
                    onBusyChange={setSendBusy}
                  />
                )}
                {mode === 'receive' && (
                  <Receiver
                    initialCode={initialCode}
                    onNotification={addNotification}
                    deviceName={deviceName}
                    onBusyChange={setReceiveBusy}
                  />
                )}
                {mode === 'screen' && (
                  <ScreenShare
                    initialViewId={initialViewId}
                    onNotification={addNotification}
                    onBusyChange={setScreenBusy}
                  />
                )}
              </div>
            </ErrorBoundary>
          </div>
        </div>
        
        <div className="mt-8 text-center max-w-md mx-auto space-y-2 pb-4 md:pb-0">
          <p className="text-xs text-slate-500 dark:text-night-400">
            Powered by WebRTC.
          </p>
        </div>
      </main>
      <PWAInstallPrompt />
    </div>
  );
};

export default App;

/**
 * 设备名的推断信号。之所以不直接读 navigator，是为了能在测试里构造各种
 * 「UA 说了谎」的现场（iPadOS 13+ 和 iPhone 的「请求桌面网站」都会伪装成 Mac）。
 */
export interface DeviceNameSignals {
  userAgent: string;
  /** navigator.platform，iPadOS 桌面 UA 下仍是 'MacIntel' */
  platform?: string;
  maxTouchPoints?: number;
  /** 屏幕短边（CSS px）：iPhone 竖屏 320–430，iPad 768–834 */
  screenShortSide?: number;
  /** navigator.userAgentData?.platform（Chromium） */
  clientHintPlatform?: string;
}

const IPHONE_UA = /iphone|ipod/i;
const IPAD_UA = /ipad/i;
const ANDROID_UA = /android/i;
const MAC_UA = /macintosh|mac os x/i;
const WINDOWS_UA = /windows/i;
const CHROMEOS_UA = /cros/i;
const LINUX_UA = /linux/i;

/** 手机短边上限：iPhone 最大 430（Pro Max），iPad 最小 768，中间留足余量 */
const PHONE_SHORT_SIDE_MAX = 500;

export const inferDeviceName = (signals: DeviceNameSignals): string => {
  const ua = signals.userAgent ?? '';
  const platform = signals.platform ?? '';
  const hint = (signals.clientHintPlatform ?? '').toLowerCase();
  const shortSide = signals.screenShortSide ?? 0;
  // Chromium 的触摸模拟只报 1，真机 iOS 报 5；能触控的 Mac 并不存在，所以 >0 即可
  const hasTouch = (signals.maxTouchPoints ?? 0) > 0;
  const looksLikeMac = MAC_UA.test(ua) || platform === 'MacIntel' || hint === 'macos';

  if (IPHONE_UA.test(ua)) return 'iPhone';
  if (IPAD_UA.test(ua)) return 'iPad';

  // iPadOS 13+ 起，Safari 默认发桌面 UA；iPhone 打开「请求桌面网站」后同样伪装成
  // Macintosh。桌面 Mac 的 maxTouchPoints 恒为 0（触控板不算触点），所以
  // 「Mac UA + 多点触控」只可能是 iOS/iPadOS。再用屏幕短边区分手机与平板：
  // 桌面模式改的是布局视口宽度，screen 尺寸仍是设备尺寸。
  if (looksLikeMac && hasTouch) {
    return shortSide > 0 && shortSide <= PHONE_SHORT_SIDE_MAX ? 'iPhone' : 'iPad';
  }

  if (ANDROID_UA.test(ua) || platform === 'Android' || hint === 'android') return 'Android';
  if (looksLikeMac) return 'Mac';
  if (WINDOWS_UA.test(ua) || platform.startsWith('Win') || hint === 'windows') return 'Windows';
  if (CHROMEOS_UA.test(ua) || hint === 'chrome os') return 'ChromeOS';
  if (LINUX_UA.test(ua) || platform.startsWith('Linux') || hint === 'linux') return 'Linux';
  return 'Unknown';
};

const readSignals = (): DeviceNameSignals => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const screen = typeof window === 'undefined' ? undefined : window.screen;
  const shortSide = screen ? Math.min(screen.width || 0, screen.height || 0) : 0;

  return {
    userAgent: nav.userAgent ?? '',
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    screenShortSide: shortSide,
    clientHintPlatform: nav.userAgentData?.platform,
  };
};

export const getInitialDeviceName = (): string => {
  if (typeof navigator === 'undefined') return 'Unknown';
  return inferDeviceName(readSignals());
};

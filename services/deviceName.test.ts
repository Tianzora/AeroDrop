import assert from 'node:assert/strict';
import test from 'node:test';

import { inferDeviceName } from './deviceName';

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
/** iPadOS 13+ 与 iPhone「请求桌面网站」共用这套 UA —— 只靠 UA 无法区分 */
const IOS_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const CHROMEBOOK_UA =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LINUX_FIREFOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

test('detects an iPhone from its own UA', () => {
  assert.equal(
    inferDeviceName({ userAgent: IPHONE_SAFARI_UA, platform: 'iPhone', maxTouchPoints: 5, screenShortSide: 393 }),
    'iPhone',
  );
});

test('detects an iPad from its own UA', () => {
  assert.equal(
    inferDeviceName({ userAgent: IPAD_SAFARI_UA, platform: 'iPad', maxTouchPoints: 5, screenShortSide: 820 }),
    'iPad',
  );
});

test('detects an iPad that reports the desktop Macintosh UA', () => {
  assert.equal(
    inferDeviceName({ userAgent: IOS_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5, screenShortSide: 820 }),
    'iPad',
  );
});

test('detects an iPhone that asked for the desktop site instead of calling it a Mac', () => {
  assert.equal(
    inferDeviceName({ userAgent: IOS_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5, screenShortSide: 393 }),
    'iPhone',
  );
});

test('detects an iPhone whose emulator reports a single touch point', () => {
  assert.equal(
    inferDeviceName({ userAgent: IOS_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 1, screenShortSide: 390 }),
    'iPhone',
  );
});

test('keeps a touchscreen Windows laptop on Windows', () => {
  assert.equal(
    inferDeviceName({ userAgent: WINDOWS_CHROME_UA, platform: 'Win32', maxTouchPoints: 10, screenShortSide: 900 }),
    'Windows',
  );
});

test('keeps a real Mac a Mac because it has no touch points', () => {
  assert.equal(
    inferDeviceName({ userAgent: MAC_SAFARI_UA, platform: 'MacIntel', maxTouchPoints: 0, screenShortSide: 1512 }),
    'Mac',
  );
});

test('falls back to iPad when a touch-capable Mac-like device hides its screen size', () => {
  assert.equal(
    inferDeviceName({ userAgent: IOS_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5, screenShortSide: 0 }),
    'iPad',
  );
});

test('detects Windows, Android and ChromeOS', () => {
  assert.equal(
    inferDeviceName({ userAgent: WINDOWS_CHROME_UA, platform: 'Win32', maxTouchPoints: 0 }),
    'Windows',
  );
  assert.equal(
    inferDeviceName({ userAgent: ANDROID_CHROME_UA, platform: 'Linux armv8l', maxTouchPoints: 5 }),
    'Android',
  );
  assert.equal(inferDeviceName({ userAgent: CHROMEBOOK_UA, platform: 'Linux x86_64', maxTouchPoints: 0 }), 'ChromeOS');
});

test('uses client hints when the UA is reduced', () => {
  assert.equal(inferDeviceName({ userAgent: '', clientHintPlatform: 'macOS' }), 'Mac');
  assert.equal(inferDeviceName({ userAgent: '', clientHintPlatform: 'Android' }), 'Android');
  assert.equal(inferDeviceName({ userAgent: '', clientHintPlatform: 'Windows' }), 'Windows');
});

test('detects Linux and gives up on unknown agents', () => {
  assert.equal(inferDeviceName({ userAgent: LINUX_FIREFOX_UA, platform: 'Linux x86_64' }), 'Linux');
  assert.equal(inferDeviceName({ userAgent: 'curl/8.0.0' }), 'Unknown');
});

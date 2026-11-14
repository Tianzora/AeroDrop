import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 屏幕共享用例同样需要真实 Worker 信令（:8787），与文件传输共用这个产品级套件。
  testMatch: ['product-transfer.spec.ts', 'screenshare.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.AERODROP_BASE_URL ?? 'http://127.0.0.1:8787',
    // 失败证据：trace 与截图都只在失败时留，CI 把 test-results/ 当 artifact 上传。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-product-transfer',
      use: {
        browserName: 'chromium',
        // 屏幕共享用 fake display capture：没有系统选择器也没有真实屏幕，但画面与
        // 帧数是真实的（spec 通过 getVideoPlaybackQuality 断言帧增长）。
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
  ],
});

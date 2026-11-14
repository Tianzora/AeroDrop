import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['rtc-datachannel.spec.ts', 'product-transfer.spec.ts', 'screenshare.spec.ts'],
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3401',
    // retries 是 0，on-first-retry 永远等不到重试，等于不产 trace；本地与 CI 都要
    // 在失败时留下证据（CI 把 test-results/ 当 artifact 上传）。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});

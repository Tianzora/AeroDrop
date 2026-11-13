import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * 屏幕共享端到端用例：真实 Worker 信令 + 真实 WebRTC，只有「屏幕源」用 Chromium 的
 * fake display capture 替代系统选择器。
 *
 * 运行方式（需要 worker 在 8787，`npm run test:e2e:product-transfer` 会连带跑本文件）：
 *   npm run preview                                        # 或 npm run build && npx wrangler dev
 *   npx playwright test --config=playwright.product.config.ts -g "shares frames"
 *
 * 三个 Chromium 参数缺一不可：
 *   --use-fake-ui-for-media-stream              免去「是否共享」确认气泡
 *   --auto-select-desktop-capture-source=Entire screen  免去选窗口那一步
 *   --use-fake-device-for-media-stream          让 fake capture 提供可用轨道
 * 它们配在 playwright.product.config.ts 的 launchOptions.args 里；默认的
 * playwright.config.ts（vite preview :3401，没有 Worker 信令）用 testIgnore 排除本文件。
 *
 * headless Chromium 若不支持 getDisplayMedia（例如精简的 CI 镜像），用例会显式
 * skip 并打印原因，不会静默通过。
 */

const FRAME_TIMEOUT_MS = 30_000;

type VideoSample = {
  count: number;
  width: number;
  height: number;
  readyState: number;
  currentTime: number;
  frames: number;
};

/** 读取页面上所有 video 的体积/帧数，用于判断「真的收到画面」而不是只有黑框。 */
const sampleVideos = async (page: Page): Promise<VideoSample> =>
  page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = {
      count: 0,
      width: 0,
      height: 0,
      readyState: 0,
      currentTime: 0,
      frames: 0,
    };
    for (const video of videos) {
      const quality = video.getVideoPlaybackQuality?.();
      const sample = {
        count: videos.length,
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
        currentTime: video.currentTime,
        frames: quality?.totalVideoFrames ?? 0,
      };
      if (sample.width * sample.height > best.width * best.height || sample.frames > best.frames) {
        best = sample;
      }
    }
    return best;
  });

const getShareLink = async (page: Page): Promise<string> => {
  const anchor = page.locator('a[href*="view="]').first();
  await expect(anchor).toBeVisible({ timeout: 20_000 });
  const href = await anchor.getAttribute('href');
  if (!href) throw new Error('share link has no href');
  return href;
};

/** 部分环境下自动播放被拦，会显示「点击开始观看」遮罩；点到它再继续等帧。 */
const dismissAutoplayOverlay = async (page: Page) => {
  const overlay = page.getByText('点击开始观看', { exact: true });
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.click();
  }
};

const waitForViewerFrames = async (page: Page): Promise<VideoSample> => {
  let latest: VideoSample = await sampleVideos(page);
  await expect
    .poll(
      async () => {
        // 遮罩是远端流 attach 且 play() 被拒后才渲染的，晚于 goto，所以每轮都试一次。
        await dismissAutoplayOverlay(page);
        latest = await sampleVideos(page);
        return latest.frames;
      },
      { timeout: FRAME_TIMEOUT_MS, message: 'viewer video never produced frames' }
    )
    .toBeGreaterThan(0);
  return latest;
};

const startSharing = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: '共享' }).click();
  await page.getByRole('button', { name: '开始共享屏幕' }).click();
  await expect(page.getByText('正在共享')).toBeVisible({ timeout: 20_000 });
};

const openViewer = async (browser: Browser, shareLink: string): Promise<Page> => {
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(shareLink);
  return viewer;
};

test.describe('screen share', () => {
  test('shares frames to a viewer link, counts the viewer, and clears the count on leave', async ({
    browser,
    page,
  }) => {
    await page.goto('/');
    const supported = await page.evaluate(
      () => typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    );
    test.skip(!supported, 'headless Chromium has no getDisplayMedia; run with fake capture flags');

    await startSharing(page);

    // 分享链接就是观众入口：?view=<peerId>，与本阶段新增的会话绑定共存。
    const shareLink = await getShareLink(page);
    const viewId = new URL(shareLink).searchParams.get('view');
    expect(viewId).toBeTruthy();

    const viewer = await openViewer(browser, shareLink);
    try {
      await dismissAutoplayOverlay(viewer);
      const first = await waitForViewerFrames(viewer);
      expect(first.width).toBeGreaterThan(0);
      expect(first.height).toBeGreaterThan(0);

      // 帧数必须持续增长：只断言 > 0 会把「冻结在首帧」误判成成功。
      // 用轮询而不是「睡 600ms 再采一次」，避免解码短暂停顿或 CI 负载造成假红。
      await expect
        .poll(async () => (await sampleVideos(viewer)).frames, {
          timeout: 10_000,
          message: 'viewer frames stopped growing',
        })
        .toBeGreaterThan(first.frames);

      await expect(page.getByText('1 人观看')).toBeVisible({ timeout: 20_000 });
    } finally {
      await viewer.context().close();
    }

    // 观众离开后分享端的计数归零（0 时整个徽标不渲染）。分享端要先等浏览器判
    // ICE disconnected（常见约 5s，慢时更久），再过 12s grace 才关闭该 call，所以给 35s。
    await expect(page.getByText(/\d+ 人观看/)).toHaveCount(0, { timeout: 35_000 });
    await expect(page.getByText('正在共享')).toBeVisible();
  });
});

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

  // 失败路径：信令连接被服务端拒绝（4010 = 同一会话的密钥不匹配 / 被顶号）时，分享端必须
  // 落到明确的错误终态，而不是留着绿色「正在共享」和一条打不开的链接。4010 在
  // services/peerRuntime.ts 的 TERMINAL_SIGNALING_CLOSE_CODES 里映射成 session-conflict 终端错误。
  // page.routeWebSocket 拦不住这条信令连接（实测无效），所以在页面脚本执行前替换 WebSocket。
  test('sharer shows an error terminal state instead of a fake LIVE when signaling rejects the session', async ({
    page,
  }) => {
    // 必须早于 goto：init script 只在后续导航的文档创建时注入。
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      // 只拒绝第一条信令连接：终态之后点「重新开始共享」必须能真的连上，
      // 否则这条用例只证明「会失败」，证明不了「失败后可恢复」。
      let rejectedOnce = false;

      class RejectedSignalingSocket extends EventTarget {
        url: string;
        readyState = 0;
        binaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor(url: string) {
          super();
          this.url = url;
          // 先「打开」再被拒：这才是丢会话凭证/被顶号时服务端的真实形态。
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event('open'));
            this.dispatchEvent(new Event('open'));
          }, 0);
          setTimeout(() => {
            this.readyState = 3;
            const closeEvent = new CloseEvent('close', {
              code: 4010,
              reason: 'Signaling session conflict',
              wasClean: false,
            });
            this.onclose?.(closeEvent);
            this.dispatchEvent(closeEvent);
          }, 150);
        }

        send() {}

        close() {
          this.readyState = 3;
        }
      }

      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          const url = String(args[0]);
          if (!/\/ws-signaling/.test(url) || rejectedOnce) {
            return Reflect.construct(target, args);
          }
          rejectedOnce = true;
          return new RejectedSignalingSocket(url);
        },
      });
    });

    await page.goto('/');
    const supported = await page.evaluate(
      () => typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    );
    test.skip(!supported, 'headless Chromium has no getDisplayMedia; run with fake capture flags');

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    // 同一条提示既出现在 toast 里也出现在终态卡片里，所以断言要限定在主区域。
    const terminalCard = page.getByRole('main');
    await expect(terminalCard.getByText('共享已中断')).toBeVisible({ timeout: 25_000 });
    await expect(
      terminalCard.getByText('分享会话已被其他连接占用，请重新开始共享')
    ).toBeVisible();
    // 绿色 LIVE 与可复制的链接都必须消失：留着就是「假共享」。
    await expect(page.getByText('正在共享')).toHaveCount(0);
    await expect(
      terminalCard.getByText('此前分享的链接已失效，观众无法再加入。')
    ).toBeVisible();
    await expect(terminalCard.getByRole('button', { name: '重新开始共享' })).toBeVisible();
    await expect(page.locator('a[href*="view="]')).toHaveCount(0);

    // 终态必须可恢复：同一条链接不能永久报废，点「重新开始共享」要重新注册房号、
    // 重新握手并回到绿色 LIVE，否则用户只剩刷新页面一条路。
    await terminalCard.getByRole('button', { name: '重新开始共享' }).click();
    await expect(page.getByText('正在共享')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('a[href*="view="]')).toHaveCount(1);
  });

  // 失败路径：房号登记被限流（429）是终态——重试只会继续吃限流窗口，所以必须立刻
  // 停采集、清预览、不进绿色 LIVE，并把限流文案直接给用户，而不是「请重试」。
  test('sharer fails fast and terminally when the share room registration is rate limited', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const state = window as typeof window & { __shareCodeAttempts?: number; __nativeFetch?: typeof fetch };
      state.__shareCodeAttempts = 0;

      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'POST' && new URL(rawUrl, location.href).pathname === '/api/share-code') {
          state.__shareCodeAttempts = (state.__shareCodeAttempts ?? 0) + 1;
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'too many share code requests' }), {
              status: 429,
              headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
            })
          );
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof window.fetch;
    });

    await page.goto('/');
    const supported = await page.evaluate(
      () => typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    );
    test.skip(!supported, 'headless Chromium has no getDisplayMedia; run with fake capture flags');

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    const terminalCard = page.getByRole('main');
    await expect(terminalCard.getByText('共享已中断')).toBeVisible({ timeout: 25_000 });
    await expect(terminalCard.getByText('创建共享房间过于频繁，请稍后再试')).toBeVisible();
    await expect(page.getByText('正在共享')).toHaveCount(0);
    await expect(page.locator('a[href*="view="]')).toHaveCount(0);
    await expect(terminalCard.getByText('此前分享的链接已失效，观众无法再加入。')).toBeVisible();

    // 终态不能靠连打接口熬过去：命中限流后只登记过一次。
    expect(await page.evaluate(() => (window as typeof window & { __shareCodeAttempts?: number }).__shareCodeAttempts)).toBe(1);
  });

  // 失败路径：登记接口偶发 5xx 属于可自愈失败——继续重试到成功，不能把分享杀掉。
  test('sharer recovers from a transient share room registration failure instead of killing the share', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const state = window as typeof window & { __shareCodeAttempts?: number };
      state.__shareCodeAttempts = 0;

      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'POST' && /\/api\/share-code$/.test(new URL(rawUrl, location.href).pathname)) {
          state.__shareCodeAttempts = (state.__shareCodeAttempts ?? 0) + 1;
          if (state.__shareCodeAttempts === 1) {
            return Promise.resolve(new Response('', { status: 503 }));
          }
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof window.fetch;
    });

    await page.goto('/');
    const supported = await page.evaluate(
      () => typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    );
    test.skip(!supported, 'headless Chromium has no getDisplayMedia; run with fake capture flags');

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    await expect(page.getByText('正在共享')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('a[href*="view="]')).toHaveCount(1);
    expect(await page.evaluate(() => (window as typeof window & { __shareCodeAttempts?: number }).__shareCodeAttempts)).toBe(2);
  });

  // 并发初始化 + 登记超时兜底，两件事一起守：
  // 1) 单飞闸门：看门狗（20s 建连超时）与恢复退避不能在「上一次登记还没回来」时再起一次
  //    初始化——否则同一台机器登记两个房号，先回来的那个变成无人撤销的孤儿，占满 24h 并吃
  //    掉同 IP 的登记预算，让 429 终态更早误触发。
  // 2) 不可恢复：以前登记可以永不返回，initializePeer 的 finally 不执行，闸门永久占用，
  //    界面停在「正在连接服务器」只能刷新。现在登记自带超时，连续两次不响应就落可操作终态。
  test('a stalled room registration ends in an actionable terminal state, never a stuck LIVE', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const state = window as typeof window & { __shareCodeAttempts?: number };
      state.__shareCodeAttempts = 0;

      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'POST' && new URL(rawUrl, location.href).pathname === '/api/share-code') {
          state.__shareCodeAttempts = (state.__shareCodeAttempts ?? 0) + 1;
          // 挂住不返回，但必须尊重调用方的 AbortSignal：真实 fetch 被 abort 时会立刻 reject。
          // 不 abort 就等于把「永不返回」写进 mock，反而把产品缺陷当成期望。
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const fail = () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (signal?.aborted) {
              fail();
              return;
            }
            signal?.addEventListener('abort', fail, { once: true });
          });
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof window.fetch;
    });

    await page.goto('/');
    const supported = await page.evaluate(
      () => typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    );
    test.skip(!supported, 'headless Chromium has no getDisplayMedia; run with fake capture flags');

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    // 第一次 8s 超时 → 退避重试 1s → 第二次 8s 超时 → 终态，约 17s 落地。
    await expect(page.getByText('共享已中断')).toBeVisible({ timeout: 25_000 });
    await expect(
      page.getByRole('main').getByText('共享服务长时间无响应，请检查网络后重新开始共享')
    ).toBeVisible();
    // 两次登记都被 abort：闸门确实释放并重试过，但不会无限重排。
    expect(
      await page.evaluate(
        () => (window as typeof window & { __shareCodeAttempts?: number }).__shareCodeAttempts
      )
    ).toBe(2);
    // 登记没成功就不许装成共享中：绿色 LIVE 与可复制链接都不该出现。
    await expect(page.getByText('正在共享')).toHaveCount(0);
    await expect(page.locator('a[href*="view="]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新开始共享' })).toBeVisible();
  });
})
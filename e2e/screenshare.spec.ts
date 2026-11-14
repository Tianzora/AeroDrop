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


/**
 * 真正试一次采集，而不是查 WebIDL 方法是否存在：`getDisplayMedia` 在任何 Chromium 里都是
 * 存在的函数，但「没有可采集的桌面」只会在调用时抛错。只有真抓到一帧才算支持。
 *
 * 本机开发者没有显示服务时允许 skip（否则本地/无头环境寸步难行）；但 CI 里
 * fake-capture flag（playwright.product.config.ts）一旦回归，9 条用例会整组 skip
 * 而 job 依旧全绿——所以 CI 下把探测结果当断言，必须为 true。
 */
const ensureDisplayCapture = async (page: Page): Promise<void> => {
  const supported = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      return false;
    }
  });
  if (process.env.CI) {
    expect(
      supported,
      'CI 里必须能捕获采集源：检查 playwright.product.config.ts 的 fake-capture flags 与 --with-deps 安装'
    ).toBe(true);
    return;
  }
  test.skip(
    !supported,
    'this Chromium cannot capture a display surface (missing fake-capture flags or no display server)'
  );
};

test.describe('screen share', () => {
  test('shares frames to a viewer link, counts the viewer, and clears the count on leave', async ({
    browser,
    page,
  }) => {
    await page.goto('/');
    await ensureDisplayCapture(page);

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
    await ensureDisplayCapture(page);

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
    await ensureDisplayCapture(page);

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
    await ensureDisplayCapture(page);

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
    await ensureDisplayCapture(page);

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
  // 失败路径：房号到期。分享端以前只在「续期连续失败 3 次」时提示，房号真过期了界面
  // 还是绿色「正在共享」+ 一条能复制但打不开的链接。这里让登记返回一个已经快过期的
  // 房号、续期一律 429，再触发一次续期（online 事件），必须立刻切到「链接已失效」。
  test('an expired share room flips the link and badge to a dead state instead of a green LIVE', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const state = window as typeof window & { __shareCodeCalls?: number };
      state.__shareCodeCalls = 0;

      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'POST' && new URL(rawUrl, location.href).pathname === '/api/share-code') {
          state.__shareCodeCalls = (state.__shareCodeCalls ?? 0) + 1;
          if (state.__shareCodeCalls === 1) {
            // 房号必须真的登记在服务端，否则信令会因为「未知口令」直接拒绝会话；
            // 这里只把服务端给的 expiresAt 改短，模拟「TTL 已经被前一轮共享吃光」。
            const response = await nativeFetch(input as RequestInfo, init);
            if (!response.ok) return response;
            const payload = await response.clone().json();
            // 生产环境「登记成功 + 建好信令」可能超过 1.2s，TTL 太短会让房号在
            // 「正在共享」出现之前就过期，断言就变成了在抖动上抛硬币。给 6s：
            // 足够跨过建链，又短到能用一次 online 事件触发过期分支。
            return Response.json({ ...payload, expiresAt: Date.now() + 6_000 });
          }
          // 续期一律失败：房号已经过期，服务端不会再续。
          return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof window.fetch;
    });

    await page.goto('/');
    await ensureDisplayCapture(page);

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();
    await expect(page.getByText('正在共享')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('a[href*="view="]')).toHaveCount(1);

    // 等房号真的过期（mock 里只剩 6s），再触发一次续期——回到前台/网络恢复时分享端
    // 会立即续期，用它代替 60s 的过期看门狗，同时验证「续期失败 + 已过期」这条分支。
    await page.waitForTimeout(6_500);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    // 过期之后不能继续宣称「正在共享」，也不能让人复制一条已经无效的链接。
    await expect(page.getByText('正在共享')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('链接已失效', { exact: true })).toBeVisible();
    await expect(
      page.getByText('分享链接已失效，需要重新开始共享才能让新观众加入')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '复制分享链接' })).toHaveAttribute(
      'title',
      '分享链接已失效'
    );
  });

  // 失败路径：停止后立刻再开始，而且上一轮初始化还在飞。旧实现的单飞闸门停完不换新
  // 对象，新会话的初始化拿到 false 被丢弃，只能等上一轮（或恢复定时器）结束。
  // 断言用「两条登记请求的先后」而不是固定时间窗：第二次登记必须在上一次还没返回时
  // 就已经发出去，这样用例既确定，也不会因为机器慢而偶发失败。
  test('stopping and immediately restarting sharing registers while the previous init is still in flight', async ({
    page,
  }) => {
    await page.goto('/');
    await ensureDisplayCapture(page);

    const arrivals: number[] = [];
    let firstResolved = false;
    let secondBeforeFirst = false;
    await page.route('**/api/share-code', async (route) => {
      const index = arrivals.length;
      arrivals.push(Date.now());
      // 第一次登记故意慢 7s（小于客户端 8s 超时）：停止时它必然还在飞。
      if (index === 0) {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        firstResolved = true;
      } else if (index === 1) {
        // 关键观察点：第二次登记发出时，第一次是不是还没返回。
        secondBeforeFirst = !firstResolved;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();
    await expect(page.getByRole('button', { name: '停止共享' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => arrivals.length, { timeout: 20_000 }).toBe(1);

    await page.getByRole('button', { name: '停止共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    await expect.poll(() => arrivals.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(secondBeforeFirst).toBe(true);
    await expect(page.locator('a[href*="view="]')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText('正在共享')).toBeVisible({ timeout: 30_000 });
  });
  // 失败路径：观众侧媒体通道一直连不上（ICE 失败）。以前信令一 open 就把重连计数
  // 清零，ICE 反复失败时观众永远停在「正在重试」，既看不到终态也没有重试按钮。
  test('viewer media failures end in a manual-retry terminal state, not an endless retry loop', async ({
    browser,
    page,
  }) => {
    await page.goto('/');
    await ensureDisplayCapture(page);

    await startSharing(page);
    const shareLink = await getShareLink(page);

    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    // 观众页：记录下来每一条 RTCPeerConnection。打开开关之后，所有「新建连接」都在
    // 300ms 内被判定为 failed —— 等价于媒体通道永远接不通（ICE 不收敛）。
    await viewer.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      const state = window as typeof window & {
        __pcs?: RTCPeerConnection[];
        __failAllMedia?: boolean;
        __failCurrentMedia?: () => void;
      };
      const list: RTCPeerConnection[] = [];
      state.__pcs = list;
      state.__failAllMedia = false;

      const markFailed = (pc: RTCPeerConnection) => {
        try {
          Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => 'failed' });
          pc.dispatchEvent(new Event('connectionstatechange'));
        } catch {
          /* 浏览器不允许重定义该属性时，这条注入就只是无效，不应让用例崩掉 */
        }
      };

      const Wrapped = function (this: unknown, ...args: unknown[]) {
        const pc = new Native(...(args as ConstructorParameters<typeof RTCPeerConnection>));
        list.push(pc);
        // 开关打开后，新连接从创建那一刻起就是 failed：不能先让它真的连上几毫秒，
        // 否则 connectionState 会短暂变成 connected，重连预算就被清零（无限重连）。
        if (state.__failAllMedia) {
          markFailed(pc);
        }
        return pc;
      } as unknown as typeof RTCPeerConnection;
      Wrapped.prototype = Native.prototype;
      window.RTCPeerConnection = Wrapped;

      state.__failCurrentMedia = () => {
        const current = list[list.length - 1];
        if (current) markFailed(current);
      };
    });

    try {
      await viewer.goto(shareLink);
      await dismissAutoplayOverlay(viewer);
      await waitForViewerFrames(viewer);

      // 先让当前这条媒体连接失败，并让之后每条新连接也失败。
      await viewer.evaluate(() => {
        const state = window as typeof window & {
          __failAllMedia?: boolean;
          __failCurrentMedia?: () => void;
        };
        state.__failAllMedia = true;
        state.__failCurrentMedia?.();
      });

      // 先看到「会重连」的提示（不是黑屏静默）。
      await expect(viewer.getByText(/秒后尝试重连/)).toBeVisible({ timeout: 20_000 });



      // 重连预算用尽后必须给出终态和手动重试入口。
      await expect(viewer.getByText('连接断开，已达到最大重试次数，请手动重试')).toBeVisible({
        timeout: 55_000,
      });
      await expect(viewer.getByRole('button', { name: '重试连接' })).toBeVisible();
    } finally {
      await viewer.context().close();
    }
  });
  // 分享端崩溃/断网时不会发 revoke，房号行按 24h TTL 活着，但信令层的目标 peer 已经
  // 没有活 socket。旧实现里「有限重试」的预算被 connectToSharer 无条件清零，于是每 3s
  // 重连一次、永不进终态——比之前的「重试 5 次后终态」更差。这条用例钉住它会停。
  test('a link whose sharer has no live session ends in a terminal state instead of retrying forever', async ({
    browser,
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    // 从没注册过信令的 peerId：房号接口不做校验，信令层投递时才会回 peer-unavailable。
    const peerId = await page.evaluate(() => crypto.randomUUID());
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    try {
      await viewer.goto(`/?view=${peerId}`);
      // 一次 3s 重试之后必须落到终态，而不是永远转圈。
      // 同一句文案会同时出现在终态卡与提示条里，所以取第一个匹配即可。
      await expect(
        viewer
          .getByText('分享暂时不可用（可能已结束，或分享者正在重连），请稍后重新打开此链接')
          .first()
      ).toBeVisible({ timeout: 45_000 });
      // 终态之后不许再有新的「正在重试」提示把状态盖回去。
      await viewer.waitForTimeout(8_000);
      await expect(viewer.getByText('分享者暂时不在线，正在重试...')).toHaveCount(0);
      // 终态是稳定的：既不能被「正在重试」盖回去，也不该退化成通用的网络超时文案。
      await expect(
        viewer
          .getByText('分享暂时不可用（可能已结束，或分享者正在重连），请稍后重新打开此链接')
          .first()
      ).toBeVisible();
      await expect(viewer.getByText('连接超时，请检查网络')).toHaveCount(0);
    } finally {
      await viewerContext.close();
    }
  });
  // 满员是容量拒绝，不是网络故障。share-full 的告知是 best-effort：送不到时观众只看到
  // call 被关，旧实现会把它当断链、先显示「正在重连」再在 20s 后报「连接超时」，
  // 用户于是去查网络/防火墙。这条用例钉住第 7 个观众看到的是「人已满」。
  test('the seventh viewer is told the room is full instead of seeing a network timeout', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto('/');
    await ensureDisplayCapture(page);

    await startSharing(page);
    const shareLink = await getShareLink(page);

    // 每个观众要发两条 offer（数据通道 + 媒体），而 SignalingHub 的 offer 限流是
    // 每出口 IP 每窗口 24 条（constants/signaling.ts 的 SIGNALING_OFFER_RATE_LIMIT）。
    // E2E 里所有页面共享 127.0.0.1 这一个 clientKey，所以「坐满 6 个 + 第 7 个被拒」
    // 必须能在一个窗口里跑完：配额若退回每分钟 10 条（低于产品容量），第 6 个观众
    // 会先被出口限流挡住，这里就会在「连接请求过多」断言上红。
    // 同一 preview 进程里，前面的用例已经把 127.0.0.1 这个 clientKey 的 offer 配额用掉一部分，
    // 而且出口限流是「固定窗口 + 命中后整出口静默一个窗口」——单独跑这条用例是绿的，
    // 在文件里全量跑却会第 6 个观众先撞限流。这里主动等一个完整窗口再开始，
    // 让「6 个名额 + 第 7 个被容量拒绝」发生在同一个干净窗口里。
    await page.waitForTimeout(63_000);

    const viewers: Page[] = [];
    const openViewerWithFrames = async (): Promise<Page> => {
      const viewer = await openViewer(browser, shareLink);
      viewers.push(viewer);
      await dismissAutoplayOverlay(viewer);
      const sample = await waitForViewerFrames(viewer);
      expect(sample.frames).toBeGreaterThan(0);
      // 出口限流是「等一分钟再试」的问题，不能混进满员或网络故障的判定。
      await expect(viewer.getByText(/连接请求过多/)).toHaveCount(0);
      return viewer;
    };

    try {
      // 6 个名额都要真正收到画面，分享端的 activeViewers 才会计入，第 7 个才会被拒。
      for (let index = 0; index < 6; index += 1) {
        await openViewerWithFrames();
      }
      await expect(page.getByText('6 人观看')).toBeVisible({ timeout: 30_000 });

      const extra = await openViewer(browser, shareLink);
      viewers.push(extra);

      // 两种兜底文案都算达标：确定拒绝（分享人数已满…）与 best-effort 没送到时的
      // 推断（可能人数已满…）。拒绝会同时落一条 info 提示和红色错误条，故取首个匹配。
      const fullNotice = extra.getByText(/人数已满/).first();
      await expect(fullNotice).toBeVisible({ timeout: 30_000 });

      // 旧实现要过一个 20s 的连接超时窗口才会给出错误，且给的是网络结论。
      // 这里多等一个窗口，确认文案没有被「连接超时」覆盖掉。
      await extra.waitForTimeout(22_000);
      await expect(fullNotice).toBeVisible();
      await expect(extra.getByText(/连接超时/)).toHaveCount(0);
    } finally {
      await Promise.all(viewers.map((viewer) => viewer.context().close()));
    }
  });

})
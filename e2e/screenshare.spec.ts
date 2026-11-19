import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

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

// 30s 在「全量套件 + 生产环境 + 代理网络」下会偶发超时（单跑必过），45s 只是吸收抖动，
// 真正的失败仍由后续帧数持续增长断言判定。
const FRAME_TIMEOUT_MS = 45_000;

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

/**
 * 记录页面上同一段文案出现过的**最大**次数（25ms 采样）。
 *
 * `toHaveCount(1)` 只保证「最终只剩一份」：重复的 toast 在 4 秒后自己消失，所以窗口内
 * 短暂出现两份也照样绿——那正是「红条 + 同义 toast」双播回退时的假绿形态。断言最大值
 * 才真正对应「同一时刻只有一个播报」。
 */
const trackMaxOccurrences = async (context: BrowserContext, source: string): Promise<void> => {
  await context.addInitScript((pattern: string) => {
    const state = window as typeof window & { __maxSeen?: number };
    state.__maxSeen = 0;
    const count = () => {
      const text = document.body?.innerText ?? '';
      const matches = text.match(new RegExp(pattern, 'g'));
      const n = matches ? matches.length : 0;
      if (n > (state.__maxSeen ?? 0)) state.__maxSeen = n;
    };
    document.addEventListener('DOMContentLoaded', () => {
      count();
      setInterval(count, 25);
    });
  }, source);
};

const readMaxSeen = async (page: Page): Promise<number> =>
  page.evaluate(() => (window as typeof window & { __maxSeen?: number }).__maxSeen ?? 0);

const openViewer = async (browser: Browser, shareLink: string, track?: string): Promise<Page> => {
  const viewerContext = await browser.newContext();
  if (track) await trackMaxOccurrences(viewerContext, track);
  const viewer = await viewerContext.newPage();
  await viewer.goto(shareLink);
  return viewer;
};
/**
 * 产品套件顺序执行时，同一出口 IP 的 offer 配额（24 次/60s）会被前面的多观众用例吃掉，
 * 新开的观看端可能一上来就收到「连接请求过多」。这不是聊天回归：等限流窗口过去后
 * 换一个观看页重试即可。仅用于等待首帧的聊天用例，不改动既有用例的断言强度。
 */
const openChatViewerWithFrames = async (createViewer: () => Promise<Page>): Promise<Page> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const viewer = await createViewer();
    await dismissAutoplayOverlay(viewer);
    const limited = await viewer
      .getByText(/连接请求过多/)
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (limited) {
      const body = await viewer.locator('body').innerText().catch(() => '');
      const seconds = Number(body.match(/(\d+) 秒后可重试/)?.[1] ?? 0);
      await viewer.context().close();
      lastError = new Error('viewer was rate limited before the first frame');
      if (seconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1_000));
      }
      continue;
    }
    try {
      await waitForViewerFrames(viewer);
      return viewer;
    } catch (error) {
      lastError = error;
      await viewer.context().close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error('viewer never connected');
};
/**
 * 模拟「旧对端」：把 kind:'room' 的信令从 WebSocket 出站流量里丢掉。
 *
 * M1 的聊天通道是新增协议；旧版本只认识 data/media，遇到 room 不会建立通道。
 * 这里在信令边界重现这点，验证新的一端在对方没有聊天能力时仍能正常传屏、
 * 不抛未捕获异常（聊天面板显示未连接即可）。
 */
const blockRoomChatSignaling = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView
    ) {
      try {
        if (typeof data === 'string') {
          const message = JSON.parse(data) as { kind?: string };
          if (message?.kind === 'room') return;
        }
      } catch {
        /* 非 JSON 信令原样放过 */
      }
      return nativeSend.call(this, data);
    } as typeof WebSocket.prototype.send;
  });
};

const openChatPanel = async (page: Page): Promise<void> => {
  // 右侧「互动」卡默认收起，必须先点主卡里的「加入聊天房间」。
  const panel = page.locator('aside[aria-label="房间聊天"]');
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '加入聊天房间' }).click();
  }
  await expect(panel).toBeVisible({ timeout: 10_000 });
};

const waitForChatConnected = async (page: Page): Promise<void> => {
  await expect(page.getByText('已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
};

const sendChatMessage = async (page: Page, text: string): Promise<void> => {
  const input = page.getByPlaceholder('输入消息，回车发送');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(text);
  await page.getByLabel('发送').click();
};

const collectPageErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};


/**
 * 真正试一次采集，而不是查 WebIDL 方法是否存在：`getDisplayMedia` 在任何 Chromium 里都是
 * 存在的函数，但「没有可采集的桌面」只会在调用时抛错。只有真抓到一帧才算支持。
 *
 * 本机开发者没有显示服务时允许 skip（否则本地/无头环境寸步难行）；但 CI 里
 * fake-capture flag（playwright.product.config.ts）一旦回归，17 条走 ensureDisplayCapture 的用例会整组 skip
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
  //
  // 这条桩只「open」、从不发 registered：房号登记成功但 peerId 从未下发，链接也就从未
  // 出现在屏幕上。终态必须以「未能开始共享」收尾；说「此前分享的链接已失效」是自相矛盾
  // ——用户从没拿到过链接（这条用例就是该回归的守门人）。
  test('sharer never claims a dead link when signaling rejects before the link was published', async ({
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
    await expect(terminalCard.getByText('未能开始共享')).toBeVisible({ timeout: 25_000 });
    await expect(
      terminalCard.getByText('分享会话已被其他连接占用，请重新开始共享')
    ).toBeVisible();
    // 绿色 LIVE 与可复制的链接都必须消失：留着就是「假共享」。
    await expect(page.getByText('正在共享')).toHaveCount(0);
    await expect(
      terminalCard.getByText('此前分享的链接已失效，观众无法再加入。')
    ).toHaveCount(0);
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
    // 登记就失败了，从没生成过链接：标题必须是「未能开始共享」，不能声称旧链接失效。
    await expect(terminalCard.getByText('未能开始共享')).toBeVisible({ timeout: 25_000 });
    await expect(terminalCard.getByText('创建共享房间过于频繁，请稍后再试')).toBeVisible();
    // 同一句终态文案全页只能出现一次：终态卡本身是常驻的 assertive live region，
    // 再补一条同文本 toast 会让读屏念两遍、视觉上同屏出现两次（第十七轮产品复评 M-1）。
    await expect(page.getByText('创建共享房间过于频繁，请稍后再试')).toHaveCount(1);
    await expect(page.getByText('正在共享')).toHaveCount(0);
    await expect(page.locator('a[href*="view="]')).toHaveCount(0);
    await expect(terminalCard.getByText('此前分享的链接已失效，观众无法再加入。')).toHaveCount(0);

    // 终态不能靠连打接口熬过去：命中限流后只登记过一次。
    expect(await page.evaluate(() => (window as typeof window & { __shareCodeAttempts?: number }).__shareCodeAttempts)).toBe(1);

    // 冷却入口守卫：按钮禁用到倒计时结束，并且用 aria-describedby 指向可见的秒数。
    const restart = terminalCard.getByRole('button', { name: '重新开始共享' });
    await expect(restart).toBeDisabled();
    await expect(restart).toHaveAttribute('aria-describedby', 'share-terminal-cooldown-hint');
    await expect(terminalCard.locator('#share-terminal-cooldown-hint')).toHaveText(/\d+ 秒后可重试/);

    // 冷却不能被绕过：摘掉 disabled 属性再点一次，组件里的冷却守卫必须让登记不发生。
    // 注意 React 对 props.disabled 为真的控件会丢弃 click（属性摘掉也一样），所以这条断言
    // 在只有 UI 层 disabled 的现状下并不单独构成红线；红线来自两条变异组合：UI 的 disabled
    // 改成恒 false + 守卫改成恒 false 时 attempts 会变 2（见汇报）。
    await restart.evaluate((el) => {
      el.removeAttribute('disabled');
      (el as HTMLButtonElement).click();
    });
    await page.waitForTimeout(3_000);
    expect(
      await page.evaluate(() => (window as typeof window & { __shareCodeAttempts?: number }).__shareCodeAttempts)
    ).toBe(1);
  });

  // 冷却结束必须能自己恢复：Retry-After 只有 1s，倒计时走完后按钮重新可点，
  // 点击后重新登记并回到绿色 LIVE——不需要刷新页面。
  test('sharer can start again after a short 429 cooldown elapses', async ({ page }) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const state = window as typeof window & { __shareCodeAttempts?: number };
      state.__shareCodeAttempts = 0;

      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'POST' && new URL(rawUrl, location.href).pathname === '/api/share-code') {
          state.__shareCodeAttempts = (state.__shareCodeAttempts ?? 0) + 1;
          // 只拒第一次：第二次要真的走到 Worker，验证冷却结束后能正常登记。
          if (state.__shareCodeAttempts === 1) {
            return Promise.resolve(
              new Response(JSON.stringify({ error: 'too many share code requests' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
              })
            );
          }
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof window.fetch;
    });

    await page.goto('/');
    await ensureDisplayCapture(page);

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    const terminalCard = page.getByRole('main');
    await expect(terminalCard.getByText('未能开始共享')).toBeVisible({ timeout: 25_000 });

    // Retry-After 只有 1 秒：倒计时结束后按钮必须自己从禁用恢复，而不是一直灰着。
    const restart = terminalCard.getByRole('button', { name: '重新开始共享' });
    await expect(restart).toBeEnabled({ timeout: 15_000 });
    await restart.click();

    await expect(page.getByText('正在共享')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('a[href*="view="]')).toHaveCount(1, { timeout: 30_000 });
    expect(
      await page.evaluate(() => (window as typeof window & { __shareCodeAttempts?: number }).__shareCodeAttempts)
    ).toBe(2);
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

    // 第一次 8s 超时 → 退避重试 1s → 第二次 8s 超时 → 终态，约 17s 落地；全程没拿到房号，
    // 所以是「未能开始共享」，不是「共享已中断」。
    await expect(page.getByText('未能开始共享')).toBeVisible({ timeout: 25_000 });
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
    await page.getByRole('button', { name: '开始共享' }).click();

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
      // 同一个事件只准出现一份：红条已经承载了完整原因，绝不能再补一条同义 toast——
      // 读屏会 assertive 念一遍红条、polite 再念一遍 toast。
      await expect(viewer.getByText('连接断开，已达到最大重试次数，请手动重试')).toHaveCount(1, {
        timeout: 55_000,
      });
      await expect(viewer.getByText('屏幕共享连接断开')).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: '重试连接' })).toBeVisible();
    } finally {
      await viewer.context().close();
    }
  });
  // 失败路径：观众在收到第一帧之前，媒体通道就被 ICE/DTLS 判死（公司网、对称 NAT、没配
  // TURN）。旧实现里它与「第 7 个观众被名额拒绝」的输入完全相同（无流、数据通道没开、
  // call 关了），于是被写成确定语气的「可能人数已满（最多 6 人），请稍后再试」——用户会
  // 去等一个永远不存在的名额。这里把每条 pc 的 ontrack 吞掉（保证一帧都没收到），等
  // media call 建立后再把 connectionState 推到 failed：peerRuntime 的 close 必须带
  // 'transport'，观众侧只能落媒体失败文案。
  test('a media connection that fails before the first frame is not reported as a full room', async ({
    browser,
    page,
  }) => {
    await page.goto('/');
    await ensureDisplayCapture(page);

    await startSharing(page);
    const shareLink = await getShareLink(page);

    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await viewer.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      const state = window as typeof window & {
        __pcs?: RTCPeerConnection[];
        __failTransport?: () => void;
      };
      const list: RTCPeerConnection[] = [];
      state.__pcs = list;

      const Wrapped = function (this: unknown, ...args: unknown[]) {
        const pc = new Native(...(args as ConstructorParameters<typeof RTCPeerConnection>));
        list.push(pc);
        // 吞掉 ontrack：即使 ICE 真连通，观众也永远收不到第一帧，保证走的是
        // 「首帧前的建连失败」，而不是「播到一半断流」。
        Object.defineProperty(pc, 'ontrack', {
          configurable: true,
          get: () => null,
          set: () => {},
        });
        return pc;
      } as unknown as typeof RTCPeerConnection;
      Wrapped.prototype = Native.prototype;
      window.RTCPeerConnection = Wrapped;

      state.__failTransport = () => {
        for (const pc of list) {
          try {
            Object.defineProperty(pc, 'connectionState', {
              configurable: true,
              get: () => 'failed',
            });
            pc.dispatchEvent(new Event('connectionstatechange'));
          } catch {
            /* 浏览器不允许重定义该属性时忽略：用例会因为等不到文案而失败，暴露注入无效 */
          }
        }
      };
    });

    try {
      await viewer.goto(shareLink);
      // 媒体连接由 peer.call 创建：等它出现再判死，别在监听器挂上之前丢事件。
      await expect
        .poll(
          () =>
            viewer.evaluate(
              () => (window as typeof window & { __pcs?: RTCPeerConnection[] }).__pcs?.length ?? 0
            ),
          { timeout: 20_000 }
        )
        .toBeGreaterThanOrEqual(1);
      await viewer.evaluate(() => {
        (window as typeof window & { __failTransport?: () => void }).__failTransport?.();
      });

      // 只能是媒体失败文案：既有常量，不新造文案。
      await expect(
        viewer.getByText('媒体通道建立失败（可能是网络或防火墙限制），请重试')
      ).toBeVisible({ timeout: 20_000 });
      // 不得落在满员文案上（这就是修复前用户看到的确定语气）。
      await expect(viewer.getByText(/人数已满/)).toHaveCount(0);
      // 传输层失败不是断链：不进入重连倒计时。
      await expect(viewer.getByText(/秒后尝试重连/)).toHaveCount(0);
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
    // 误报「人数已满」只存在于错误到终态之间的几百毫秒里（toast 4 秒后消失，错误条随后被
    // 覆盖），事后 `toHaveCount(0)` 抓不到。用 MutationObserver 把「曾经出现过」记下来。
    await viewerContext.addInitScript(() => {
      const record = () => {
        if (document.body?.innerText.includes('人数已满')) {
          (window as typeof window & { __fullRoomSeen?: boolean }).__fullRoomSeen = true;
        }
      };
      document.addEventListener('DOMContentLoaded', () => {
        record();
        new MutationObserver(record).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
    });
    const viewer = await viewerContext.newPage();
    try {
      await viewer.goto(`/?view=${peerId}`);
      // 一次 3s 重试之后必须落到终态，而不是永远转圈。
      // 终态文案由常驻红条承担；再补一条同文本 toast 会重复播报（第十七轮产品复评 M-1），
      // 所以这里断言「全页恰好一次」，而不是 first() 的宽松写法。
      await expect(
        viewer.getByText('分享暂时不可用（可能已结束，或分享者正在重连），请稍后重新打开此链接')
      ).toHaveCount(1, { timeout: 45_000 });
      // 终态之后不许再有新的「正在重试」提示把状态盖回去。
      await viewer.waitForTimeout(8_000);
      await expect(viewer.getByText('分享者暂时不在线，正在重试...')).toHaveCount(0);
      // 终态是稳定的：既不能被「正在重试」盖回去，也不该退化成通用的网络超时文案。
      await expect(
        viewer.getByText('分享暂时不可用（可能已结束，或分享者正在重连），请稍后重新打开此链接')
      ).toHaveCount(1);
      // 这些串都在 `services/connectionGuidance.ts` 里真实存在：用它们做「没有退化成通用
      // 网络故障」的非空断言（此前写死的「连接超时，请检查网络」全仓不存在，永远为真）。
      await expect(viewer.getByText(/连接超时|请检查网络|网络连接中断/)).toHaveCount(0);
      // 死链最容易被误报成「房间满了」：信令错误先到、call close 紧随其后，close 分支如果
      // 不继承「分享者不在线」的结论就会落进疑似满员。toast 4 秒就消失，所以必须在这里
      // 明确断言「一次都没出现过」，否则这条最有价值的回归断言会漏网。
      await expect(viewer.getByText(/人数已满/)).toHaveCount(0);
      expect(
        await viewer.evaluate(
          () => (window as typeof window & { __fullRoomSeen?: boolean }).__fullRoomSeen === true
        ),
        '这条链接没有活跃分享者，任何时刻都不该出现「人数已满」'
      ).toBe(false);
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
    // 63s 窗口等待 + 6 个观众（含重试）+ 第 7 个观众的 22s 观察窗口，留足余量。
    test.setTimeout(600_000);
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
    // 这条用例验的是「6 个名额占满 + 第 7 个被容量拒绝」，不是「某一台观众的媒体通道
    // 一定建得起来」：真实网络（尤其挂着代理的机器）上单个观众的 ICE 偶发失败，
    // 会让整条容量用例红在与容量无关的断言上。所以按「还差几个就再开一个」推进，
    // 失败就关掉那个页面（别让它继续占名额、继续吃 offer 配额）。
    // 出口限流命中时不能重试（重试只会把窗口拖得更差），必须等一个完整窗口再来：
    // 生产环境一轮跑下来经常要跨两个窗口，所以这里给它两个窗口的预算。
    const openViewerWithFrames = async (): Promise<Page> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const viewer = await openViewer(browser, shareLink);
        await dismissAutoplayOverlay(viewer);
        try {
          const sample = await waitForViewerFrames(viewer);
          expect(sample.frames).toBeGreaterThan(0);
          // 出口限流是「等一分钟再试」的问题，不能混进满员或网络故障的判定。
          await expect(viewer.getByText(/连接请求过多/)).toHaveCount(0);
          viewers.push(viewer);
          return viewer;
        } catch (error) {
          lastError = error;
          const rateLimited = (await viewer.getByText(/连接请求过多/).count()) > 0;
          await viewer.context().close();
          if (rateLimited) {
            throw error;
          }
          await page.waitForTimeout(2_000);
        }
      }
      throw lastError;
    };

    const activeViewerCount = async (): Promise<number> =>
      page.evaluate(() => {
        const match = document.body.innerText.match(/(\d+) 人观看/);
        return match ? Number(match[1]) : 0;
      });

    try {
      // 6 个名额都要真正收到画面，分享端的 activeViewers 才会计入，第 7 个才会被拒。
      // 每轮最多再补开一个观众；命中限流就等下一个配额窗口（固定窗口，60s 后清零）。
      // 挂着代理的本机上单个观众的 ICE 会偶发失败（失败页面会被关掉再补一个），
      // 因此这里给足补位预算：容量断言本身与网络无关，别让网络抖动把它拖红。
      const deadline = Date.now() + 330_000;
      let waitingForWindow = false;
      while ((await activeViewerCount()) < 6 && Date.now() < deadline) {
        try {
          await openViewerWithFrames();
        } catch (error) {
          if (!waitingForWindow) {
            waitingForWindow = true;
            // 限流命中后整出口会静默一个窗口，等满 63s 再继续。
            await page.waitForTimeout(63_000);
            continue;
          }
          throw error;
        }
      }
      await expect(page.getByText('6 人观看')).toBeVisible({ timeout: 30_000 });

      const extra = await openViewer(browser, shareLink, '人数已满');
      viewers.push(extra);

      // 同一件事只准说一次：满员只有红色错误条承载，代码里已经没有对应的 toast，
      // 所以这里必须恰好一条（以前取 .first()，把「多播一条」也当成通过）。
      const fullNotice = extra.getByText(/人数已满/);
      await expect(fullNotice).toHaveCount(1, { timeout: 30_000 });

      // 旧实现要过一个 20s 的连接超时窗口才会给出错误，且给的是网络结论。
      // 这里多等一个窗口，确认文案没有被「连接超时」覆盖掉，也没有多出第二份。
      await extra.waitForTimeout(22_000);
      await expect(fullNotice).toHaveCount(1);
      await expect(extra.getByText(/连接超时/)).toHaveCount(0);
      // 与「共享结束」同理：满员文案曾经同时落进红条与 toast，4 秒后 toast 消失，
      // 事后 count 仍是 1。这里断言 25ms 采样下的最大出现次数。
      expect(await readMaxSeen(extra)).toBe(1);
    } finally {
      await Promise.all(viewers.map((viewer) => viewer.context().close()));
    }
  });

  // 分享端主动停止时，观众侧必须收到一次、且只有一次的「共享方已结束共享」终态。
  // 这条终态以前删掉了重复 toast 却没有任何断言兜底：把 toast 加回来也全绿。
  test('a viewer hears the share ended exactly once when the sharer stops', async ({ browser, page }) => {
    await page.goto('/');
    await ensureDisplayCapture(page);

    await startSharing(page);
    const shareLink = await getShareLink(page);

    // `toHaveCount(1)` 只保证「最终只剩一份」：重复的 toast 4 秒后自己消失，
    // 4 秒窗口内出现两份也照样绿（这正是回退到「红条 + toast」时的假绿）。
    // 所以按 25ms 采样页面文本，记录同一文案出现过的**最大**次数。
    const viewerContext = await browser.newContext();
    await viewerContext.addInitScript((source: string) => {
      const state = window as typeof window & { __maxSeen?: number };
      state.__maxSeen = 0;
      const count = () => {
        const text = document.body?.innerText ?? '';
        const matches = text.match(new RegExp(source, 'g'));
        const n = matches ? matches.length : 0;
        if (n > (state.__maxSeen ?? 0)) state.__maxSeen = n;
      };
      document.addEventListener('DOMContentLoaded', () => {
        count();
        setInterval(count, 25);
      });
    }, '共享方已(停止共享|结束共享)');
    const viewer = await viewerContext.newPage();
    try {
      await viewer.goto(shareLink);
      await dismissAutoplayOverlay(viewer);
      const first = await waitForViewerFrames(viewer);
      expect(first.width).toBeGreaterThan(0);

      await page.getByRole('button', { name: '停止共享' }).click();

      // 停止共享会先广播 share-ended（观众据此得到「共享方已停止共享」），随后 call
      // 关闭还会再走一次终态（「共享方已结束共享」）。两条路径复用同一个错误位，
      // 所以不变量是「同一时刻只有一个共享已结束的播报」，而不是某一条具体文案。
      const endedNotice = viewer.getByText(/共享方已(停止共享|结束共享)/);
      await expect(endedNotice).toHaveCount(1, { timeout: 30_000 });
      // 4 秒（sonner 的 duration）再加 1 秒，覆盖瞬时重复出现的整个窗口。
      await viewer.waitForTimeout(5_000);
      expect(await viewer.evaluate(() => (window as typeof window & { __maxSeen?: number }).__maxSeen)).toBe(1);
    } finally {
      await viewerContext.close();
    }
  });

  // 分享端的能力/权限失败必须只由常驻红条承载：删掉重复 toast 之后，这两条路径
  // 分别用「不支持」与「非取消失败」把红条文案钉住（回归时多一条 toast 就会落 count 2）。
  test('an unsupported browser explains itself once instead of stacking a toast', async ({ page }) => {
    await page.addInitScript(() => {
      // 模拟没有 getDisplayMedia 的浏览器（比删整个 mediaDevices 更贴近真实）。
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: undefined,
      });
    });
    await page.goto('/');

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    const message = page.getByText('您的浏览器不支持屏幕共享，请使用桌面端浏览器:Chrome、Edge 或 Firefox');
    await expect(message).toHaveCount(1, { timeout: 15_000 });
    // toast 是异步渲染的且 sonner 的标题节点不一定能被 getByText(exact) 命中，
    // 直接用页面文本核对：这条路径只该有一条常驻红条，不该再弹 toast。
    await page.waitForTimeout(1_500);
    await expect(message).toHaveCount(1);
    expect(await page.locator('body').innerText()).not.toContain('屏幕共享不可用');
  });

  test('a capture failure that is not a cancel explains itself once instead of stacking a toast', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // NotReadableError = 被安全软件/录屏软件占用，不是用户取消，必须给出可执行的说明。
      navigator.mediaDevices.getDisplayMedia = () =>
        Promise.reject(new DOMException('Device in use', 'NotReadableError'));
    });
    await page.goto('/');

    await page.getByRole('button', { name: '共享' }).click();
    await page.getByRole('button', { name: '开始共享屏幕' }).click();

    const message = page.getByText(
      '系统拒绝了屏幕录制（可能被安全软件、录屏或会议软件占用），请关闭后重试'
    );
    await expect(message).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await expect(message).toHaveCount(1);
    expect(await page.locator('body').innerText()).not.toContain('屏幕共享启动失败');
  });

  // M1 聊天：停止共享 = 只暂停画面，房间/聊天会话仍在；重新共享后画面自动恢复，
  // 历史不能被清空（这正是「停共享 ≠ 结束房间」的端到端证据）。
  test('chat survives stopping and restarting a share, and the viewer auto-resumes', async ({
    browser,
    page,
  }) => {
    test.slow();
    await page.goto('/');
    await ensureDisplayCapture(page);
    await startSharing(page);
    const shareLink = await getShareLink(page);
    const viewer = await openChatViewerWithFrames(() => openViewer(browser, shareLink));
    try {
      await openChatPanel(page);
      await openChatPanel(viewer);
      await waitForChatConnected(page);
      await waitForChatConnected(viewer);

      await sendChatMessage(viewer, 'hello-from-viewer');
      await expect(page.getByText('hello-from-viewer', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(viewer.getByText('hello-from-viewer', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: '停止共享' }).click();
      await expect(page.getByText('还没有人共享屏幕', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('button', { name: '开始共享' })).toBeVisible({
        timeout: 20_000,
      });
      // share_stopped 之后聊天面板不能被一起收掉。
      await expect(page.locator('aside[aria-label="房间聊天"]')).toBeVisible();
      await sendChatMessage(page, 'still-chatting-while-stopped');
      await expect(viewer.getByText('still-chatting-while-stopped', { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      await page.getByRole('button', { name: '开始共享' }).click();
      await expect(page.getByText('正在共享')).toBeVisible({ timeout: 20_000 });
      // 共享方重新开始共享后，观看端画面自动恢复；此时不需要点「重新观看」。
      await dismissAutoplayOverlay(viewer);
      const resumed = await waitForViewerFrames(viewer);
      // 画面必须继续增长，不能只靠旧帧残留混过去。
      await expect
        .poll(async () => (await sampleVideos(viewer)).frames, {
          timeout: 10_000,
          message: 'viewer frames did not grow after the share resumed',
        })
        .toBeGreaterThan(resumed.frames);
      await expect(viewer.getByText('still-chatting-while-stopped', { exact: true })).toBeVisible();
      await sendChatMessage(viewer, 'after-rewatch');
      await expect(page.getByText('after-rewatch', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await viewer.context().close();
    }
  });

  // 房间内任意成员都能接替共享：B 点「顶替共享」先弹确认；确认前 A 仍在共享，
  // 确认后 A 被切为观看并收到提示，聊天全程不断。
  test('a watching member can take over the share after confirming, and chat stays online', async ({
    browser,
    page,
  }) => {
    test.slow();
    await page.goto('/');
    await ensureDisplayCapture(page);
    await startSharing(page);
    const shareLink = await getShareLink(page);
    const viewer = await openChatViewerWithFrames(() => openViewer(browser, shareLink));
    try {
      await openChatPanel(page);
      await openChatPanel(viewer);
      await waitForChatConnected(page);
      await waitForChatConnected(viewer);
      await sendChatMessage(viewer, 'before-takeover');
      await expect(page.getByText('before-takeover', { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      await viewer.getByRole('button', { name: '顶替共享' }).click();
      await expect(viewer.getByText('接替对方的共享？', { exact: true })).toBeVisible();
      // 未确认前不能发生静默抢占。
      await expect(page.getByText('正在共享')).toBeVisible();

      await viewer.getByRole('button', { name: '确认接替' }).click();
      await expect(viewer.getByText('正在共享')).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText('共享已被其他成员接替，已转为观看', { exact: true })
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('观看屏幕', { exact: true })).toBeVisible({ timeout: 20_000 });
      await dismissAutoplayOverlay(page);
      await waitForViewerFrames(page);

      // 共享槽换人只影响画面，聊天两个方向都还在。
      await sendChatMessage(page, 'host-after-takeover');
      await expect(viewer.getByText('host-after-takeover', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await sendChatMessage(viewer, 'viewer-after-takeover');
      await expect(page.getByText('viewer-after-takeover', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await viewer.context().close();
    }
  });

  // 分享方异常退出（无 pagehide）时，观看端不能永远停在「正在等待屏幕画面」。
  test('a viewer waiting for a crashed sharer lands on a terminal notice', async ({ browser, page }) => {
    test.slow();
    await page.addInitScript(() => {
      // 模拟崩溃/被强杀：页面卸载时应用注册的 pagehide/beforeunload 不会执行，
      // 因此对端收不到 window_closed，只能靠观看端自己的兜底。
      const nativeAdd = window.addEventListener.bind(window);
      window.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => {
        if (type === 'pagehide' || type === 'beforeunload') return;
        return nativeAdd(type, listener, options);
      }) as typeof window.addEventListener;
    });
    await page.goto('/');
    await ensureDisplayCapture(page);
    await startSharing(page);
    const shareLink = await getShareLink(page);
    const viewer = await openChatViewerWithFrames(() => openViewer(browser, shareLink));
    try {
      await openChatPanel(page);
      await openChatPanel(viewer);
      await waitForChatConnected(page);
      await waitForChatConnected(viewer);
      await sendChatMessage(page, 'before-crash');
      await expect(viewer.getByText('before-crash', { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // 硬关分享端：不再有 window_closed，也不会重新开始共享。观看端先落到「共享已停止」占位，
      // 20 秒兜底到终态（这条路径不经过分享端的显式停共享帧）。
      await page.close({ runBeforeUnload: false });
      await expect(viewer.getByText('共享已停止', { exact: true })).toBeVisible({ timeout: 20_000 });

      await expect(viewer.getByText('共享方长时间未恢复，屏幕共享已结束', { exact: true })).toBeVisible({
        timeout: 35_000,
      });
      // 终态只结束等待画面，聊天面板与历史仍在。
      await expect(viewer.locator('aside[aria-label="房间聊天"]')).toBeVisible();
      await expect(viewer.getByText('before-crash', { exact: true })).toBeVisible();
      // 观看端错误态不能再出现发送端的「开始共享屏幕」，否则同一张卡既像观众又像房主。
      await expect(viewer.getByRole('button', { name: '开始共享屏幕' })).toHaveCount(0);
      await expect(viewer.getByText('观看屏幕', { exact: true })).toBeVisible();
    } finally {
      await viewer.context().close();
    }
  });

  // 旧×新双向矩阵（旧对端不认识 kind:'room'，聊天降级为未连接，但原传屏不受影响）。
  test('a new viewer degrades gracefully when the sharer drops room-chat signaling', async ({
    browser,
    page,
  }) => {
    test.slow();
    await blockRoomChatSignaling(page);
    await page.goto('/');
    await ensureDisplayCapture(page);
    await startSharing(page);
    const shareLink = await getShareLink(page);
    const sharerErrors = collectPageErrors(page);
    const viewer = await openChatViewerWithFrames(() => openViewer(browser, shareLink));
    const viewerErrors = collectPageErrors(viewer);
    try {
      await openChatPanel(viewer);
      await expect(viewer.getByText('未连接', { exact: true })).toBeVisible({ timeout: 30_000 });
      // 原共享/停止共享照旧可用。
      await page.getByRole('button', { name: '停止共享' }).click();
      await expect(page.getByRole('button', { name: '开始共享' })).toBeVisible({
        timeout: 20_000,
      });
      expect(sharerErrors).toEqual([]);
      expect(viewerErrors).toEqual([]);
    } finally {
      await viewer.context().close();
    }
  });

  test('a new sharer keeps sharing when the viewer drops room-chat signaling', async ({ browser, page }) => {
    test.slow();
    await page.goto('/');
    await ensureDisplayCapture(page);
    await startSharing(page);
    const shareLink = await getShareLink(page);
    const sharerErrors = collectPageErrors(page);
    const viewer = await openChatViewerWithFrames(async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await blockRoomChatSignaling(page);
      await page.goto(shareLink);
      return page;
    });
    const viewerErrors = collectPageErrors(viewer);
    try {
      const first = await waitForViewerFrames(viewer);
      await openChatPanel(viewer);
      await expect(viewer.getByText('未连接', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await sampleVideos(viewer)).frames, {
          timeout: 10_000,
          message: 'viewer frames stopped growing when only chat signaling is unavailable',
        })
        .toBeGreaterThan(first.frames);
      expect(sharerErrors).toEqual([]);
      expect(viewerErrors).toEqual([]);
    } finally {
      await viewer.context().close();
    }
  });

})
# AeroDrop

浏览器即开即用的 WebRTC 文件传输与屏幕共享应用。P2P 优先，不可达时回退 TURN 中继；信令走自管 Cloudflare Worker + Durable Object + WebSocket。

## 命令

```powershell
npm ci                                # 安装
npm run dev                           # 前端 vite
npm run dev:worker                    # Worker 本地开发（wrangler）
npm run typecheck                     # tsc --noEmit
npm run test:services                 # services/ 下 Node 测试
npm run test:e2e                      # Playwright（自动起 vite preview :3401）
npm run test:e2e:rtc                  # RTC 专项
npm run build
npm run deploy                        # wrangler deploy
```

- 产品级 E2E 走 `npm run test:e2e:product-transfer`，默认打 `AERODROP_BASE_URL`，未设置时用 `http://127.0.0.1:8787`。
- 改完代码的顺序：`typecheck` → `test:services` → 相关 E2E。

## 硬约束

- 信令、连接策略、TURN 凭证、超时参数只在 `services/` 与 `constants/` 里改，不在组件中硬编码。
- `services/connectionPolicy.ts`、`services/receive/committedReconnectPolicy.ts` 是连接降级与续传的唯一判定点，改行为改这里，不要在各调用方分叉。
- Vite 8 用 Oxc/Rolldown：`build.minify` 保持 `oxc`，不要恢复 `esbuild` minifier。
- `package.json` 的 `overrides.esbuild` 是为覆盖 Wrangler 依赖链上被钉住的旧 esbuild；升级 Wrangler 后先跑 `npm audit` 再决定能否移除。
- TURN 用 Cloudflare 短期凭证，Worker 端签发；前端不持有长期凭证，未配置时回退 STUN-only。
- 传输协议版本改动要同时改 sender/receiver 两侧与 `types/`，不能只改一端。

## 不要做

- 不提交 `node_modules/`、`dist/`、`test-results/`、`.wrangler/`、`.env*`、`.dev.vars*`。
- 不在 `components/` 里堆传输逻辑，也不为单个组件新增全局 CSS。
- 不新增只做透传的包装组件。

## 维护

- 人工段落（`命令`、`硬约束`、`不要做`、`资料库`、`深入文档`）由你维护：改动命令、依赖、目录结构或上述任一约束时，在同一次改动内更新本文件。
- 自动块由脚本生成，**不要手改**；要刷新就跑：

```bash
python D:/ovo/Documents/workspace/scripts/agents-md/render.py --root D:/ovo/Documents/workspace --write
```

- 改动影响项目定位或状态时，同步更新资料库笔记 `wiki/projects/<name>.md`。

## 资料库

- 项目笔记：`D:\ovo\Documents\workspace\ObsidianVault\wiki\projects\aerodrop.md`
- 工作区根：`D:\ovo\Documents\workspace\`

<!-- agents:auto:begin · scripts/agents-md/render.py 生成，勿手改 -->
- 仓库：`https://github.com/Tianzora/AeroDrop.git`
- 分支：`main`
- 运行时：Node 22.12.0（`.nvmrc`）、包管理器 npm@10.8.2
- 脚本入口：`build` `deploy` `deploy:worker` `dev` `dev:worker` `preview` `preview:e2e` `test:e2e` `test:e2e:product-transfer` `test:e2e:product-transfer:raw` `test:e2e:raw` `test:e2e:rtc` `test:e2e:rtc:raw` `test:receive` `test:send` `test:services` `typecheck`
- 锁文件：`package-lock.json`
- 顶层目录：`components/` `constants/` `docs/` `e2e/` `public/` `scripts/` `services/` `skills/` `src/` `stores/` `types/`
<!-- agents:auto:end -->

## 深入文档

- `README.md` — 功能与连接模式
- `docs/` — 本地资料（不入 Git）

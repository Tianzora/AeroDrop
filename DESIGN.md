# DESIGN.md — AeroDrop 设计系统（v1.2）

> 底座 **shadcn/ui（Radix 无样式原语 + CVA）**；布局 **顶栏 + 窄居中工作区（Vercel / Linear 式）**；配色 **Editorial Modern（精细中性）**。
> 本文件是令牌与规则的唯一来源；组件内 magic number 只允许出现在 `components/ui` 原语内部。
> 参考：`docs/demo/ui-refresh/reference-notes.md`。

## 1. 设计令牌（Editorial Modern）

语义色，`:root` 亮 / `@media (prefers-color-scheme: dark)` 暗；经 Tailwind v4 `@theme inline` 暴露为工具类（`bg-surface / text-ink / border-border` …）：

| 角色 | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--surface` | #FAFAF9 | #0B0B0C | 暖纸白 / 近黑底 |
| `--raised` | #FFFFFF | #131315 | 卡片/面板 |
| `--sunken` | #F3F2EF | #08080A | 内嵌槽/轨道 |
| `--border` | #E8E6E1 | #242427 | 发丝分隔 1px |
| `--border-strong` | #D5D2CA | #3A3A3E | 聚焦/虚线框 |
| `--text` | #17171A | #EDEDEE | 正文（≥4.5:1） |
| `--muted` | #6B6B70 | #A0A0A5 | 次要信息 |
| `--subtle` | #9B9B9F | #6E6E73 | 占位/元信息（≥3:1） |
| `--ink` | #111114 | #F2F2F0 | 近黑主操作/标题；暗色反白（= primary） |
| `--accent` | #2E5D4B | #EFE7D6 | 唯一墨绿强调（暗色暖白）：口令/焦点/品牌/涟漪 |
| `--success` / `--danger` / `--warning` / `--info` | 深绿/红/琥珀/蓝 | 提亮版 | 语义状态 |

主操作 **墨色**（`bg-ink`，暗色反白）；暖赭只点睛。层次靠 1px 描边 + 层级底色 + 柔阴影（`--shadow-1/2`）。**禁玻璃拟态、大面积渐变、霓虹。**
间距 4px 基准：`4 8 12 16 20 24 32 40 48 64`。圆角 **6 / 9 / 12 / 20 / 999**（sm/按钮输入/卡片/浮层/胶囊）。
字型：系统 UI 栈 + `tabular-nums`（PWA 离线、首屏 ≤ +15KB gzip，不引网络字体）。阶梯 display 30→34 / 600 / tracking -0.03em · h2 20/650 · body 14/400 · small 13 · caption 11/600 大写 tracking .18em。口令读数用大字号 + tracking .14em + tabular-nums。

## 2. 技术底座与依赖（本轮新增，均经用户确认）
- **shadcn/ui 体系**：`@radix-ui/react-{slot,dialog,tooltip,progress,separator}`（无障碍/焦点陷阱/Portal/浮层现成）、`class-variance-authority`、`clsx`、`sonner`（Toast）。
- `tailwind-merge` 已装但**不进热路径**（`lib/utils.ts` 的 `cn` 仅用 clsx），避免首屏膨胀。
- **Sonner 异步分包**：`React.lazy + import()`，不进首屏 JS。
- 首屏预算：`index.js` gzip **139.68KB → 144.70KB（+5.02KB，限 +15KB）**；CSS 8.48→8.06（-0.42）；sonner 独立 chunk 9.34KB 异步加载。

## 3. 布局语法
- **顶栏**：`76px`（≥640 为 `88px`）三列栅格，品牌左 / 页签居中 / 右留白；`<640` 模式条移到顶栏下满宽。
- **工作区**：容器 `max-w-[1120px]` 居中；主内容**单列窄栏**——发送 `max-w-[760px]`、接收 `max-w-[620px]`、屏幕共享 `max-w-[880px]`。
- 页边距 24(>1024)/20(640–1024)/16(<640)；body 顶部一层几乎看不见的暖光径向。
- 全档（390/768/1440 × 明暗）**零横向滚动、零重叠**（脚本实测 54/54 通过）；可点 ≥44×44；正文 ≥4.5:1；CLS<0.02。
- 状态：IDLE 滴入区 / 配置表单 / 配对（口令凭条 + 设备列表）/ 传输（进度 + 设备列表）/ 完成 / 错误，全部单列聚焦。

## 4. 组件树（单文件 ≤ 400 行）
```
lib/utils.ts            cn（clsx）
components/ui/          Button(CVA+Slot) Input Card(+Header/Title/Content/Footer) Badge
                        Progress(Radix) Dialog(Radix) Sheet(Radix) Tooltip(Radix) Separator(Radix)
                        SegmentedControl(role=group，真实 button) CodeDisplay CodeInput Field Stat
                        StatusDot Skeleton EmptyState ErrorState Panel sonner(Toaster)
components/layout/      TopBar AppShell
components/sender/panels/   SenderIdle SenderConfigure SenderPairing SenderDeviceList SenderTransfer SenderError
components/receiver/panels/ ReceiverCode ReceiverConnecting ReceiverOffer ReceiverTransfer ReceiverDone ReceiverError
components/screen-share/panels/ ShareIdle ShareConnecting ShareActive Viewer ShareError
```
状态机 `Sender/Receiver/ScreenShare.tsx` 职责不变；`*UI.tsx` 为按 TransferState 选面板的薄编排，props 契约不变。E2E 选择器（`#file-upload`、`input[type="text"]`、口令单文本节点、`设备传输列表 (N)`、`已连接 N 个设备`、`当前文件进度` 等）全部保留。

## 5. 动效规范
时长 120/180/240/320ms；easing `cubic-bezier(.23,1,.32,1)` / `.77,0,.175,1` / 浮层 `.32,.72,0,1`。**每个状态切换只有一个 keyed `motion-rise` 入场**（opacity 0→1 + translateY 8–10px，240ms），面板自身不再动画；按压 `scale(.97)/120ms`；进度 `transform 120ms linear`。禁 `ease-in`、禁 `transition-all`。Radix Dialog/Sheet 自带进出场；Sonner 自带 Toast 动效。`prefers-reduced-motion`：时长≈1ms、去位移只留 opacity。

## 6. 状态词典（TransferState）
IDLE → CONFIGURING → GENERATING_CODE/WAITING_FOR_PEER（口令凭条 + 设备列表）→ PEER_CONNECTED → TRANSFERRING（进度 + 每设备进度）→ paused/resuming（续传无需重输口令）→ COMPLETED → ERROR。状态「图标+颜色+文案」三重编码。

## 7. 删除清单
删：手搓 Dialog/Sheet/Tooltip/Progress/Toast/Host 与 `IconButton`（改用 Radix/sonner）；双栏「投递 / 运单侧栏」`SenderSessionAside`（改单列 + `SenderPairingPanel`/`SenderDeviceList`）；`GradientText.tsx/css` 与全部旧 float/flip/pop/shimmer keyframes；橙色大面积填充（改墨色主操作 + 暖赭点睛）。

## 8. 无障碍
Radix 负责焦点陷阱、Esc、Portal、`aria-modal`；正文 ≥4.5:1；状态三重编码；图标按钮 aria-label；Tab 覆盖主流程；传输阶段变化 `aria-live`（Sonner/状态文本）。

#!/usr/bin/env node
/**
 * 覆盖率「分母」守卫（两个 scope：services/src 与 components）。
 *
 * 背景：Node 的 `--test-coverage-include` 只是**报告过滤器**，不会把没被任何测试
 * import 的源文件补进分母。于是 `src/worker.ts`、`components/Sender.tsx` 这类只有
 * 集成路径才会加载的文件，长期可以零覆盖而门禁全绿（工程评审明确点过这条）。
 *
 * 做法：用 git 列出该 scope 的所有生产源文件，跑一次该 scope 的测试套件并解析覆盖率
 * 报告，然后要求每个源文件都在报告里出现（可以是 0%，但不能消失）；报告行里 line
 * 覆盖率为 0% 的、且不在白名单里的文件同样算失败（「进了分母但一行没跑」不是回归证据）。
 *
 * 用法：
 *   node ./scripts/check-coverage-scope.mjs [--scope=services|components]
 *                                          [--min-lines=85] [--min-branches=78] [--min-functions=75]
 *   node ./scripts/check-coverage-scope.mjs --self-test   （校验解析/判定规则本身）
 *
 * 说明：只解析人类可读报告里的路径，不额外引入依赖。报告行按「完整相对路径 → 路径
 * 后缀」映射回 git 清单，而不是只比 basename：两个不同目录的同名文件（例如两个
 * bitratePolicy.ts）在报告里会互相遮蔽，只比 basename 时行数照样够、检查全绿。后缀
 * 命中多个文件时直接判定失败。
 *
 * 另有第二道校验「报告行数 >= 期望文件数 - 白名单」：解析正则一旦被上游输出格式改动
 * 打破，这里直接失败，而不是安静地漏掉一批文件。
 *
 * 白名单本身也有预算（每个 scope 的 `allowlistBudget`）：条目数上限 + 被排除行数占本
 * scope 总行数的比例上限。没有这条，白名单可以一路自我扩张 —— 每加一条，「报告行数 >=
 * 期望 - 白名单」这条校验还会自动跟着放宽，最后「组件 60%」只覆盖四分之一的代码。
 * `--self-test` 校验规则本身（合成 fixture）；行数占比的判定发生在 `--scope=...` 运行时。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 报告是逐行解析的：拼换行统一用它，免得源码里出现转义字符。
const NEWLINE = String.fromCharCode(10);

const readArg = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

// 行首标记不写死：本地 Node 24 是 `ℹ`，CI 上的 Node 22 观察到 `#`，日志前缀偶尔还会
// 把它替换掉。先剥 ANSI，再接受「可选标记 + 文件名 + 竖线」。
const REPORT_ROW = /^\s*[ℹ#]?\s?([^|]*)\|/;
const FILE_NAME = /\.tsx?$/;
const DASHES_ONLY = /^-+$/;

const listTrackedSources = (dirs) => {
  const listed = execFileSync('git', ['ls-files', ...dirs], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
    .filter((file) => !file.endsWith('.d.ts'));
  return [...new Set(listed)].sort();
};

/**
 * 工作树里的全部路径：已跟踪 + 未跟踪但没被 ignore 的文件（测试文件也在内）。
 * 白名单理由里引用的测试文件属于这一类 —— 它们永远不会出现在 listTrackedSources
 * 的结果里（那里刻意滤掉了 *.test.*），拿那份清单校验存在性必然把真文件误报成
 * 「不存在」，于是这条检查永远为真，等于没有检查。
 */
const listKnownPaths = () => {
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split(NEWLINE)
    .map((line) => line.trim())
    .filter(Boolean);
  return new Set(listed);
};

/**
 * 允许暂时不进入覆盖率分母的例外。新文件默认必须被测试加载；只有登记在这里、
 * 且写了理由的文件才不会让守卫失败。加新条目等于承认这块没有回归证据，别随手加。
 */
const SCOPES = {
  services: {
    title: 'services/ + src/',
    // 分母 = 这两个目录下的全部生产源文件；components/ 由另一个 scope 负责。
    roots: ['services', 'src'],
    listFiles: () => listTrackedSources(['services', 'src']),
    // 分母 = services/ + src/ 全部源码。服务测试会顺带加载 constants/ 与 types/，
    // 不排除的话 all files 汇总行是混合口径，范围外文件掉点也能把判定拉过去。
    coverageExclude: ['components/**', 'constants/**', 'types/**', 'e2e/**', 'scripts/**'],
    suiteTargets: ['services'],
    defaults: { minLines: '85', minBranches: '78', minFunctions: '75' },
    // 白名单预算：2 条 / 5% 行。现在是 2 条共 152 行（0.87%），余量只留给「Node 里
    // 真的加载不了」的新文件；超了说明有人在把整块逻辑挪出分母。
    allowlistBudget: { maxEntries: 2, maxExcludedLineShare: 0.05 },
    allowedUncovered: new Map([
      [
        'services/crc32.worker.ts',
        'module worker 入口：模块顶层读取 `self` 并挂 `self.onmessage`，Node 全局没有 `self`，import 即抛 ReferenceError；CRC32 算法本体在 services/hashUtils.ts，已有单测',
      ],
      [
        'services/receive/persistedDirectoryHandle.ts',
        '真实路径需要浏览器：Node 没有 IndexedDB（IDBFactory），存进库里的又是 FileSystemDirectoryHandle，测试里造不出可结构化克隆的句柄；假 IDB 只能验证调用序列，验证不了句柄往返',
      ],
    ]),
  },
  components: {
    title: 'components/',
    roots: ['components'],
    listFiles: () => listTrackedSources(['components']),
    // 组件套件会顺带加载 services/、constants/、types/ 的文件（它们属于 services scope
    // 的分母）。不排除的话 node:test 的「all files」汇总行是混合口径：组件实际掉到
    // 51.8% 也能过 60% 的门槛。这条 exclude 让门槛只落在 components/ 上。
    coverageExclude: ['services/**', 'constants/**', 'types/**', 'src/**'],
    // 组件套件之外再显式加载 scripts/component-import-smoke.test.ts：ErrorBoundary 和
    // PWAInstallPrompt 在 Node 里本来就能加载（实测 import 成功），却没有任何组件测试
    // import 它们。没有这条冒烟，它们永远进不了分母，守卫就又变成一句空话。
    suiteTargets: ['components', 'scripts/component-import-smoke.test.ts'],
    defaults: { minLines: '60', minBranches: '58', minFunctions: '40' },
    // 白名单预算：3 条 / 80% 行。现在是 3 条共 ~7.9k/10.4k 行（约 76%），也就是说组件
    // 门禁实际只在约四分之一的组件代码上算覆盖率，两个最大的状态机（ScreenShare、
    // Receiver）没有 Node 级回归网，只有 e2e。上限定在 80% 而不是「比现状松一点」：
    // 再多挪一个中等文件进来就会红——每加一条白名单，minimumReported 还会自动跟着降，
    // 60% 的分母会越来越小。要真正降下来，只能把可测的状态机逻辑抽到 services/ 再写
    // 单测，或补组件渲染测试（需要新增依赖，本项目不加）。
    allowlistBudget: { maxEntries: 3, maxExcludedLineShare: 0.8 },
    allowedUncovered: new Map([
      [
        'components/Receiver.tsx',
        'import 链上的 streamsaver 在模块顶层读 document（node_modules/streamsaver/StreamSaver.js 顶部），Node 里 import 即抛 ReferenceError: document is not defined；下载/续传路径由 Playwright e2e 覆盖',
      ],
      [
        'components/ScreenShare.tsx',
        '没有任何组件测试 import 它 —— 注意不是「加载不了」：signaling 基址惰性化之后它已经能在 Node 里 import（实测通过），缺的是加载它的测试。渲染依赖真实屏幕采集 getDisplayMedia、RTCPeerConnection 与信令握手，没有这些 API 的替身就跑不出状态机（只会是 0% 行覆盖率）；共享/恢复/满员流程由 test:e2e:product-transfer 的 10 条 screenshare 用例覆盖',
      ],
      [
        'components/Sender.tsx',
        '没有任何组件测试 import 它 —— 注意不是「加载不了」：它本身能在 Node 里 import（实测通过），缺的是加载它的测试。渲染需要真实 RTCPeerConnection、文件选择与 DataChannel，没有替身就跑不出状态机；传输路由/重试/分片已经抽到 services/send/ 并有单测，组件层由 test:e2e 的 sender-sharing 用例覆盖',
      ],
    ]),
  },
};

// ---------------------------------------------------------------------------
// 纯函数：解析报告、判定是否失败。--self-test 直接复用它们，避免「测的是另一套逻辑」。
// ---------------------------------------------------------------------------

/** 解析人类可读覆盖率报告，只保留「报告里的路径 + line%」；表头/分隔线/目录行不计入。 */
const parsePercent = (cell) => {
  const value = Number.parseFloat((cell ?? '').trim());
  return Number.isFinite(value) ? value : null;
};

/**
 * 覆盖率报告是分组打印的：目录行没有扩展名（`services`、`receive` 这种多级目录靠缩进
 * 表示层级），文件行印的是裸文件名、缩进比所属目录多一层。所以裸名必须用目录栈还原成
 * 相对路径，否则 `constants/signaling.ts` 会被当成 `services/signaling.ts`。
 */
const parseReport = (output) => {
  const rows = [];
  const dirs = [];
  for (const line of stripAnsi(output).split('\n')) {
    const match = line.match(REPORT_ROW);
    if (!match) continue;
    const cells = line.split('|');
    // 只吃掉「标记 + 一个空格」，其余前导空格就是层级。
    const body = line.replace(/^\s*[\u2139#]?\s?/, '');
    const indent = body.length - body.trimStart().length;
    const name = match[1].trim();
    if (!name || DASHES_ONLY.test(name)) continue;
    if (!FILE_NAME.test(name)) {
      // 表头 `file`、目录行都走到这里：只有形如标识符的名字才是目录。
      if (/^[\w.-]+$/.test(name) && name !== 'file') {
        dirs.length = indent + 1;
        dirs[indent] = name;
      }
      continue;
    }
    const prefix = dirs.slice(0, indent).filter(Boolean).join('/');
    rows.push({
      name: prefix ? `${prefix}/${name}` : name,
      linePercent: parsePercent(cells[1]),
      branchPercent: parsePercent(cells[2]),
      functionsPercent: parsePercent(cells[3]),
    });
  }
  return rows;
};

/**
 * 取报告末尾的 `all files` 汇总行。门槛必须落在这一行上：它由 node:test 按真实的
 * 行/分支/函数计数加权算出，而我们手上只有每行百分比，自己求平均是假口径。
 * 配合 scope.coverageExclude，这条汇总行就恰好只统计本 scope 的文件。
 */
const AGGREGATE_ROW = /^\s*(?:[\u2139#]\s*)?all files\s+\|/;

const parseAggregate = (output) => {
  for (const line of stripAnsi(output).split('\n')) {
    if (!AGGREGATE_ROW.test(line)) continue;
    const cells = line.split('|');
    return {
      linePercent: parsePercent(cells[1]),
      branchPercent: parsePercent(cells[2]),
      functionsPercent: parsePercent(cells[3]),
    };
  }
  return null;
};

const formatAggregate = (aggregate) => {
  if (!aggregate) return '（报告里没有 all files 汇总行）';
  const show = (value) => (value === null ? 'n/a' : `${value.toFixed(2)}%`);
  return `行 ${show(aggregate.linePercent)} / 分支 ${show(aggregate.branchPercent)} / 函数 ${show(aggregate.functionsPercent)}`;
};

/**
 * 门槛判定：只看 scope 汇总行，且必须显式给出三个数字。缺失汇总行按失败处理——
 * 上游输出格式一变就红，而不是安静地跳过门槛。
 */
const THRESHOLD_CHECKS = [
  ['行覆盖率', 'linePercent', 'minLines'],
  ['分支覆盖率', 'branchPercent', 'minBranches'],
  ['函数覆盖率', 'functionsPercent', 'minFunctions'],
];

const evaluateThresholds = ({ aggregate, thresholds }) => {
  if (!aggregate) {
    return ['覆盖率报告里没有 all files 汇总行，无法判定门槛（解析规则可能已失效）'];
  }
  const failures = [];
  for (const [label, valueKey, minimumKey] of THRESHOLD_CHECKS) {
    const value = aggregate[valueKey];
    const minimum = thresholds[minimumKey];
    if (value === null) {
      failures.push(`${label}无法从报告里解析出来`);
      continue;
    }
    if (!Number.isFinite(minimum)) {
      failures.push(`门槛 ${minimumKey} 不是合法数字（收到 ${minimum}）`);
      continue;
    }
    if (value < minimum) {
      failures.push(`${label} ${value.toFixed(2)}% 低于门槛 ${minimum}%`);
    }
  }
  return failures;
};

/**
 * 白名单预算：条目会把文件整块挪出分母，而 `minimumReported` 恰好跟着条目数一起
 * 下降 —— 于是「组件门槛」可以一路变成空话。两个机械上限：条目数（政策）与被排除
 * 行数占本 scope 总行数的比例（真实口径）。
 */
const countSourceLines = (file) => {
  const content = readFileSync(path.join(root, file), 'utf8');
  let lines = 0;
  for (const char of content) if (char === NEWLINE) lines += 1;
  if (!content.endsWith(NEWLINE)) lines += 1;
  return lines;
};

const evaluateAllowlistBudget = ({ entries, totalLines, budget }) => {
  const entryFailures = [];
  const shareFailures = [];
  if (!Number.isFinite(budget.maxEntries)) {
    entryFailures.push(`白名单条目上限配置不是数字（收到 ${budget.maxEntries}）`);
  } else if (entries.length > budget.maxEntries) {
    entryFailures.push(
      `白名单条目 ${entries.length} 条，超过上限 ${budget.maxEntries} 条：` +
        '加例外等于承认这块没有回归证据，先删旧条目，或明确提高上限并在评审里解释'
    );
  }
  const excludedLines = entries.reduce((sum, entry) => sum + entry.lines, 0);
  const share = totalLines > 0 ? excludedLines / totalLines : 0;
  // totalLines=0 意味着行数这一半被静默废掉了（统计函数返回 0、根路径写错、文件读空）。
  // 白名单非空时这一定是 bug，不能当成「占比 0%，绿灯」。
  if (totalLines === 0 && entries.length > 0) {
    shareFailures.push(
      `白名单有 ${entries.length} 条，但本 scope 的总行数算出来是 0：占比预算失效，` +
        '检查 countSourceLines / root 路径，不要把这个状态下当成通过'
    );
  }
  if (totalLines > 0 && share > budget.maxExcludedLineShare) {
    shareFailures.push(
      `白名单把 ${excludedLines}/${totalLines} 行（${(share * 100).toFixed(2)}%）整块挪出了分母，` +
        `超过上限 ${(budget.maxExcludedLineShare * 100).toFixed(0)}%：` +
        '要么把这些文件真正加载进 Node 测试，要么把可测的状态机逻辑抽到 services/ 再写单测'
    );
  }
  return { entryFailures, shareFailures, excludedLines, totalLines, share };
};

const formatAllowlistBudget = ({ excludedLines, totalLines, share }, budget) =>
  `白名单预算 ${excludedLines}/${totalLines} 行（${(share * 100).toFixed(2)}%，` +
  `上限 ${(budget.maxExcludedLineShare * 100).toFixed(0)}%），条目上限 ${budget.maxEntries} 条`;

/**
 * 把报告行映射回 git 清单里的相对路径。
 * - 先比完整相对路径（`services/x/y.ts` 就是 git 里的相对路径）；
 * - 再比路径后缀：Node 报告印的是相对「各组公共根」的路径，components 组里
 *   `components/receiver/ReceiverUI.tsx` 会印成 `receiver/ReceiverUI.tsx`，src 组
 *   则直接印裸名 `worker.ts`，两种都得认；
 * - 后缀命中多个文件 = 同名遮蔽：行数校验此时照样通过，只有这一层能拦住。
 */
const resolveRowFiles = (name, expected) =>
  expected.filter((file) => file === name || file.endsWith(`/${name}`));

const inspect = ({ expected, rows, allowedUncovered, untrackedFiles = new Set() }) => {
  const resolved = rows.map((row) => ({ row, files: resolveRowFiles(row.name, expected) }));
  const ambiguous = resolved.filter((entry) => entry.files.length > 1);
  const matched = new Set(
    resolved.flatMap((entry) => (entry.files.length === 1 ? entry.files : []))
  );
  // 报告里的行解析不到本 scope 的任何文件 = 范围外文件混进了分母（coverageExclude
  // 漏了某个目录，或者新加了一个会被顺带加载的源码目录）。以前这种行是被静默忽略的。
  const unresolved = resolved
    .filter((entry) => entry.files.length === 0)
    .map((entry) => entry.row.name);
  // 工作树里还没 `git add` 的新源码（别人正在改的文件）会出现在本地报告里，却不在 git
  // 清单里。CI 上不存在这种行，本地不该因此判红，只提示一句。
  const untracked = unresolved.filter((name) => untrackedFiles.has(name));
  const unmatched = unresolved.filter((name) => !untrackedFiles.has(name));
  const missingAll = expected.filter((file) => !matched.has(file));
  const allowedMissing = missingAll.filter((file) => allowedUncovered.has(file));
  const missing = missingAll.filter((file) => !allowedUncovered.has(file));
  // 0% 行同样要看白名单：白名单文件的「存在性」已经豁免，覆盖率为 0 也就不再单独报。
  const zeroLine = resolved
    .filter((entry) => entry.files.length === 1 && entry.row.linePercent === 0)
    .map((entry) => entry.files[0])
    .filter((file) => !allowedUncovered.has(file));
  // 白名单条目必须属于本 scope：范围外的条目既不会被预算统计，又会把
  // `minimumReported` 悄悄降一格 —— 等于凭空给自己发一张免检券。
  const strayAllowed = [...allowedUncovered.keys()].filter((file) => !expected.includes(file));

  return {
    rows,
    rowCount: rows.length,
    minimumReported: expected.filter((file) => !allowedUncovered.has(file)).length,
    strayAllowed,
    missingAll,
    allowedMissing,
    missing,
    ambiguous,
    unmatched,
    untracked,
    zeroLine,
  };
};

/** 把判定结果翻译成人类可读的失败清单；空数组即通过。 */
const describeFailures = (state) => {
  const failures = [];
  if (state.missing.length > 0) {
    failures.push(
      '以下文件没有被任何测试加载（不会计入覆盖率分母）：\n' +
        state.missing.map((file) => `  - ${file}`).join('\n') +
        '\n如果确实无法在 Node 里加载，把它登记进该 scope 的 allowedUncovered 并写明理由。'
    );
  }
  if (state.ambiguous.length > 0) {
    failures.push(
      '以下报告行只给出路径后缀，却对应多个生产文件（同名遮蔽，无法判定覆盖率归属）：\n' +
        state.ambiguous
          .map((entry) => `  - ${entry.row.name} → ${entry.files.join(' / ')}`)
          .join('\n') +
        '\n给同名文件改名，或改成完整相对路径后再放行。'
    );
  }
  if (state.unmatched.length > 0) {
    failures.push(
      '报告里出现了不属于本 scope 的文件行（分母被范围外文件污染，门槛会被它们拉偏）：' +
        NEWLINE +
        state.unmatched.map((name) => `  - ${name}`).join(NEWLINE) +
        NEWLINE +
        '把它们加进该 scope 的 coverageExclude，或确认它们本来就该由另一个 scope 统计。'
    );
  }
  if (state.strayAllowed.length > 0) {
    failures.push(
      '以下白名单条目不属于本 scope（它既不在预算里，又会让「报告行数下限」凭空减少）：' +
        NEWLINE +
        state.strayAllowed.map((file) => `  - ${file}`).join(NEWLINE) +
        NEWLINE +
        '把条目移到它真正的 scope，或删掉。'
    );
  }
  if (state.zeroLine.length > 0) {
    failures.push(
      '以下文件进了分母但 line 覆盖率为 0%（等于没有回归证据）：\n' +
        state.zeroLine.map((file) => `  - ${file}`).join('\n')
    );
  }
  // 第二道校验：报告行数必须覆盖「期望文件 - 白名单」。解析规则被上游输出格式改动
  // 打破时，这一条会直接失败，而不是安静地漏掉一批文件。
  if (state.rowCount > 0 && state.rowCount < state.minimumReported) {
    failures.push(
      `报告只出现 ${state.rowCount} 行，少于期望的 ${state.minimumReported} 行（解析规则可能已失效）`
    );
  }
  return failures;
};

// ---------------------------------------------------------------------------
// --self-test：用内联 fixture 固定「报告格式 + 判定规则」，上游输出格式一变就红。
// ---------------------------------------------------------------------------

/**
 * 白名单理由的机械校验：理由要够长，且里面引用的测试文件必须真实存在（查工作树，
 * 含未跟踪文件）。理由里写「已有单测 X」而 X 不存在，是最容易混过去的假理由。
 */
const auditAllowlistReason = ({ reason, knownPaths }) => {
  const failures = [];
  if (typeof reason !== 'string' || reason.trim().length < 20) {
    failures.push('理由太短，写清楚真实约束（为什么它不能在 Node 里被测）');
  }
  for (const referenced of reason.match(/[\w./-]+\.test\.tsx?/g) ?? []) {
    if (!knownPaths.has(referenced)) {
      failures.push(`理由引用了不存在的测试文件 ${referenced}`);
    }
  }
  return failures;
};

const SELF_TEST_CASES = [
  {
    name: 'ℹ 行（本地 Node 24）能解析',
    report: 'ℹ  Foo.tsx               | 100.00 |  100.00 |  100.00 | \nℹ all files               | 100.00 |  100.00 |  100.00 | ',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
  },
  {
    name: '# 行（CI 上的 Node 22）能解析',
    report: '#  Foo.tsx               |  50.00 |   50.00 |   50.00 | 3-4',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
  },
  {
    name: 'ANSI 彩色行能解析',
    report: '\u001b[33mℹ  Foo.tsx               |  50.00 |   50.00 |   50.00 |\u001b[39m',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
  },
  {
    name: '表头/分隔线/目录行不计入行数',
    report: [
      'ℹ file                    | line % | branch % | funcs % | uncovered lines',
      'ℹ ------------------------ | ------ | -------- | ------- |',
      'ℹ components              |        |          |         |',
      'ℹ  Foo.tsx               | 100.00 |  100.00 |  100.00 |',
    ].join('\n'),
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
    wantRowCount: 1,
  },
  {
    name: '缺失文件会被点名',
    report: 'ℹ  Foo.tsx               | 100.00 |  100.00 |  100.00 |',
    expected: ['components/Foo.tsx', 'components/Bar.tsx'],
    allowedUncovered: new Map(),
    wantFailure: 'components/Bar.tsx',
  },
  {
    name: '白名单文件缺失只作为例外记录',
    report: 'ℹ  Foo.tsx               | 100.00 |  100.00 |  100.00 |',
    expected: ['components/Foo.tsx', 'components/Bar.tsx'],
    allowedUncovered: new Map([['components/Bar.tsx', 'self-test']]),
    wantFailure: null,
    wantAllowedMissing: ['components/Bar.tsx'],
  },
  {
    name: 'line 覆盖率 0% 判失败',
    report: 'ℹ  Foo.tsx               |   0.00 |    0.00 |    0.00 | 1-40',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: 'line 覆盖率为 0%',
  },
  {
    name: '白名单文件 0% 不重复报',
    report: 'ℹ  Foo.tsx               |   0.00 |    0.00 |    0.00 | 1-40',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map([['components/Foo.tsx', 'self-test']]),
    wantFailure: null,
  },
  {
    name: '报告行数不足判解析失效',
    report: 'ℹ  Foo.tsx               | 100.00 |  100.00 |  100.00 |',
    expected: ['components/Foo.tsx', 'components/Bar.tsx', 'components/Baz.tsx', 'components/Qux.tsx'],
    allowedUncovered: new Map([
      ['components/Baz.tsx', 'self-test'],
      ['components/Qux.tsx', 'self-test'],
    ]),
    wantFailure: '解析规则可能已失效',
  },
  {
    name: '报告行给完整相对路径（services 组）能对上',
    report: 'ℹ services/receive/persistedDirectoryHandle.ts | 100.00 | 100.00 | 100.00 |',
    expected: ['services/receive/persistedDirectoryHandle.ts'],
    allowedUncovered: new Map(),
    wantFailure: null,
  },
  {
    // 这条 fixture 专治「目录栈被绕过」：两个不同目录下都有 sendChunkSize.ts，报告里
    // 只有目录行 + 裸文件名。目录栈正确时两行各自命中唯一文件；一旦 prefix 失效、裸名
    // 退化成后缀匹配，两行就会同时命中两个文件（同名遮蔽）而判红。旧版本只放一个文件
    // 时，后缀兜底会把它认成命中，这条检查其实什么都没测。
    name: '分组缩进的裸文件名必须按目录栈还原（同名文件在另一目录也存在）',
    report: [
      '\u2139 services                  |        |          |         |',
      '\u2139  transfer                 |        |          |         |',
      '\u2139   sendChunkSize.ts        |  90.00 |   70.00 |   50.00 |',
      '\u2139 src                       |        |          |         |',
      '\u2139  transfer                 |        |          |         |',
      '\u2139   sendChunkSize.ts        |  80.00 |   60.00 |   40.00 |',
      '\u2139 all files                 |  85.00 |   65.00 |   45.00 |',
    ].join(NEWLINE),
    expected: ['services/transfer/sendChunkSize.ts', 'src/transfer/sendChunkSize.ts'],
    allowedUncovered: new Map(),
    wantFailure: null,
    wantRowCount: 2,
  },
  {
    name: '工作树里未跟踪的新文件只提示、不判红',
    report:
      '\u2139 services                                   |        |          |         |' +
      NEWLINE +
      '\u2139  screenShare                              |        |          |         |' +
      NEWLINE +
      '\u2139   shareStreamLifecycle.ts                 |   0.00 |    0.00 |    0.00 | 1-40' +
      NEWLINE +
      '\u2139 all files                                 |   0.00 |    0.00 |    0.00 |',
    expected: [],
    allowedUncovered: new Map(),
    untrackedFiles: new Set(['services/screenShare/shareStreamLifecycle.ts']),
    wantFailure: null,
    wantUntracked: ['services/screenShare/shareStreamLifecycle.ts'],
  },
  {
    name: '报告行给后缀路径（components 组印成 receiver/X.tsx）能对上',
    report: 'ℹ receiver/ReceiverUI.tsx | 60.00 | 50.00 | 58.00 |',
    expected: ['components/receiver/ReceiverUI.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
  },
  {
    name: 'scope 内掉点会红（门槛只看 all files 汇总行）',
    report:
      '\u2139 Foo.tsx | 40.00 | 58.00 | 40.00 |' + NEWLINE + '\u2139 all files | 51.80 | 58.00 | 40.00 |',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
    // 组件目录之外被顺带加载的文件已经被 coverageExclude 挡在这次报告之外，所以这里
    // 的汇总行就是组件自己的口径：51.8% 必须红。
    thresholds: { minLines: 60, minBranches: 58, minFunctions: 40 },
    wantThresholdFailure: '行覆盖率 51.80% 低于门槛 60%',
  },
  {
    name: 'exclude 生效的报告：scope 数字达标即通过',
    report:
      '\u2139 Foo.tsx | 90.00 | 70.00 | 50.00 |' + NEWLINE + '\u2139 all files | 62.00 | 60.00 | 45.00 |',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
    thresholds: { minLines: 60, minBranches: 58, minFunctions: 40 },
    wantThresholdFailure: null,
  },
  {
    name: '报告缺少 all files 汇总行按解析失效处理',
    report: '\u2139 Foo.tsx | 100.00 | 100.00 | 100.00 |',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: null,
    thresholds: { minLines: 60, minBranches: 58, minFunctions: 40 },
    wantThresholdFailure: 'all files 汇总行',
  },
  {
    name: '范围外文件混进报告（exclude 失效）必须失败',
    report:
      '\u2139 Foo.tsx | 100.00 | 100.00 | 100.00 |' +
      NEWLINE +
      '\u2139 constants/transfer.ts | 10.00 | 10.00 | 10.00 |' +
      NEWLINE +
      '\u2139 all files | 55.00 | 55.00 | 55.00 |',
    expected: ['components/Foo.tsx'],
    allowedUncovered: new Map(),
    wantFailure: '不属于本 scope',
  },
  {
    name: '同名文件遮蔽（两个目录同名、报告只给裸名）必须失败',
    report: 'ℹ Foo.tsx | 100.00 | 100.00 | 100.00 |',
    // 只比 basename 时这两个文件会被同一个 `Foo.tsx` 行同时「满足」，行数校验
    // （2 - 1 白名单 = 1 行）也照样通过 —— 这条 fixture 就是拦这个洞的。
    expected: ['services/a/Foo.tsx', 'services/b/Foo.tsx'],
    allowedUncovered: new Map([['services/b/Foo.tsx', 'self-test']]),
    wantFailure: '同名遮蔽',
  },
  {
    name: '白名单条目属于别的 scope 必须失败',
    report: [
      'ℹ all files               |  90.00 |    90.00 |   90.00 |',
      'ℹ services/a/Foo.tsx      |  90.00 |    90.00 |   90.00 |',
    ].join(NEWLINE),
    expected: ['services/a/Foo.tsx'],
    allowedUncovered: new Map([['components/Other.tsx', 'self-test']]),
    wantFailure: '不属于本 scope',
  },
];

// 白名单预算的 fixture：合成数据，只验证规则本身（条目数上限 / 行数占比上限）。
const BUDGET_CASES = [
  {
    name: '白名单在预算内可以通过',
    entries: [{ lines: 10 }, { lines: 20 }],
    totalLines: 1000,
    limit: { maxEntries: 2, maxExcludedLineShare: 0.7 },
    wantFailure: null,
  },
  {
    name: '白名单多一条就超条目上限，必须失败',
    entries: [{ lines: 10 }, { lines: 20 }, { lines: 30 }],
    totalLines: 1000,
    limit: { maxEntries: 2, maxExcludedLineShare: 0.7 },
    wantFailure: '超过上限 2 条',
  },
  {
    name: '被排除行数占比超上限，必须失败',
    entries: [{ lines: 700 }, { lines: 60 }],
    totalLines: 1000,
    limit: { maxEntries: 3, maxExcludedLineShare: 0.7 },
    wantFailure: '超过上限 70%',
  },
  {
    name: '总行数算成 0 时占比预算必须失败，不能当成 0% 通过',
    entries: [{ lines: 10 }],
    totalLines: 0,
    limit: { maxEntries: 3, maxExcludedLineShare: 0.8 },
    wantFailure: '总行数算出来是 0',
  },
  {
    name: '条目上限配置坏掉，必须失败',
    entries: [{ lines: 1 }],
    totalLines: 10,
    limit: { maxEntries: Number.NaN, maxExcludedLineShare: 0.7 },
    wantFailure: '条目上限配置不是数字',
  },
];

// 白名单理由的 fixture：knownPaths 是合成的，只验证「引用的测试文件必须存在」。
const REASON_CASES = [
  {
    name: '理由引用真实存在的测试文件可以通过',
    reason: '模块顶层读取 self，算法本体在 services/hashUtils.ts，已有单测 services/hashUtils.test.ts 覆盖',
    knownPaths: ['services/hashUtils.test.ts'],
    wantFailure: null,
  },
  {
    name: '理由引用不存在的测试文件必须失败',
    reason: '模块顶层读取 self，算法本体在 services/hashUtils.ts，已有单测 services/hashUtils.test.ts 覆盖',
    knownPaths: ['services/connectionPolicy.test.ts'],
    wantFailure: '不存在的测试文件 services/hashUtils.test.ts',
  },
  {
    name: '理由太短必须失败',
    reason: '跑不了',
    knownPaths: [],
    wantFailure: '理由太短',
  },
];

const runSelfTest = () => {
  const failures = [];
  for (const testCase of SELF_TEST_CASES) {
    const rows = parseReport(testCase.report);
    const state = inspect({
      expected: testCase.expected,
      rows,
      allowedUncovered: testCase.allowedUncovered,
      untrackedFiles: testCase.untrackedFiles ?? new Set(),
    });
    const problems = describeFailures(state);

    if (testCase.wantRowCount !== undefined && state.rowCount !== testCase.wantRowCount) {
      failures.push(
        `[${testCase.name}] 期望解析出 ${testCase.wantRowCount} 行，实际 ${state.rowCount} 行`
      );
    }
    if (testCase.wantFailure === null) {
      if (problems.length > 0) {
        failures.push(`[${testCase.name}] 期望通过，实际失败：\n${problems.join('\n')}`);
      }
    } else if (!problems.some((problem) => problem.includes(testCase.wantFailure))) {
      failures.push(
        `[${testCase.name}] 期望失败信息包含「${testCase.wantFailure}」，实际：\n${problems.join('\n') || '（无失败）'}`
      );
    }
    for (const pending of testCase.wantUntracked ?? []) {
      if (!state.untracked.includes(pending)) {
        failures.push(`[${testCase.name}] 期望 ${pending} 被记为未跟踪提示，实际没有`);
      }
    }
    for (const allowed of testCase.wantAllowedMissing ?? []) {
      if (!state.allowedMissing.includes(allowed)) {
        failures.push(`[${testCase.name}] 期望 ${allowed} 被记为已知例外，实际没有`);
      }
    }
    if (testCase.thresholds) {
      const problems = evaluateThresholds({
        aggregate: parseAggregate(testCase.report),
        thresholds: testCase.thresholds,
      });
      if (testCase.wantThresholdFailure === null) {
        if (problems.length > 0) {
          failures.push(`[${testCase.name}] 期望门槛通过，实际失败：${problems.join('；')}`);
        }
      } else if (!problems.some((problem) => problem.includes(testCase.wantThresholdFailure))) {
        failures.push(
          `[${testCase.name}] 期望门槛失败信息包含「${testCase.wantThresholdFailure}」，实际：${problems.join('；') || '（无失败）'}`
        );
      }
    }
  }

  // 白名单和排除项的卫生检查：条目过期、理由失真、白名单悄悄扩张，都会让守卫变成
  // 一句空话。这些检查是数据驱动的（直接读 git 清单与源码行数），不是内联 fixture。
  const allTracked = listTrackedSources(['.']);
  const knownPaths = listKnownPaths();
  for (const [scopeName, scope] of Object.entries(SCOPES)) {
    for (const [file, reason] of scope.allowedUncovered) {
      if (!allTracked.includes(file)) {
        failures.push(`[${scopeName}] 白名单条目 ${file} 不在 git 清单里（条目已过期或路径写错）`);
      }
      for (const problem of auditAllowlistReason({ reason, knownPaths })) {
        failures.push(`[${scopeName}] 白名单条目 ${file}：${problem}`);
      }
    }
    for (const pattern of scope.coverageExclude) {
      const prefix = pattern.replace(/\/\*\*$/, '/');
      const hits = allTracked.filter((file) => file === pattern || file.startsWith(prefix));
      if (hits.length === 0) {
        failures.push(`[${scopeName}] coverageExclude 条目 ${pattern} 没有命中任何源文件（过期或写错）`);
      }
      const own = scope.listFiles().filter((file) => file === pattern || file.startsWith(prefix));
      if (own.length > 0) {
        failures.push(
          `[${scopeName}] coverageExclude 把本 scope 的源文件也排除了（${own.slice(0, 3).join(' / ')}…），门槛会失去意义`
        );
      }
    }
    // 条目数上限在这里也判：白名单条数不该悄悄增长，这是政策问题，与当前覆盖率无关。
    const scopeFiles = scope.listFiles();
    const entries = scopeFiles
      .filter((file) => scope.allowedUncovered.has(file))
      .map((file) => ({ file, lines: countSourceLines(file) }));
    const totalLines = scopeFiles.reduce((sum, file) => sum + countSourceLines(file), 0);
    const budgetReport = evaluateAllowlistBudget({
      entries,
      totalLines,
      budget: scope.allowlistBudget,
    });
    for (const problem of budgetReport.entryFailures) failures.push(`[${scopeName}] ${problem}`);
    // 行数占比不在这里判：真实树的数字由 `--scope=...` 运行时判定（components 目前已知
    // 超标，自检必须保持可跑，否则「先修哪一项」的标志物会一起失效）。但也不能对超标的
    // 现状沉默，所以把这行数字打出来。
    if (budgetReport.shareFailures.length > 0) {
      console.warn(
        `check-coverage-scope: 注意 [${scopeName}] ${formatAllowlistBudget(budgetReport, scope.allowlistBudget)} —— 该 scope 运行时判定会因此失败`
      );
    }
  }

  // 理由审计用的是真实 knownPaths：合成 fixture 只能证明规则本身，证明不了
  // `listKnownPaths()` 取到的是真 git 清单（旧实现按 basename 会漏掉 *.test.ts）。
  if (!knownPaths.has('scripts/check-coverage-scope.test.ts')) {
    failures.push('真实 knownPaths 里没有 scripts/check-coverage-scope.test.ts：listKnownPaths 取值不对');
  }
  const realReasonProblems = auditAllowlistReason({
    reason: '算法本体在 scripts/check-coverage-scope.test.ts 里覆盖，这里只是入口',
    knownPaths,
  });
  if (realReasonProblems.length > 0) {
    failures.push(
      `引用真实存在的测试文件仍被判无效（knownPaths 取值坏了）：${realReasonProblems.join('；')}`
    );
  }

  for (const testCase of BUDGET_CASES) {
    const report = evaluateAllowlistBudget({
      entries: testCase.entries,
      totalLines: testCase.totalLines,
      budget: testCase.limit,
    });
    const problems = [...report.entryFailures, ...report.shareFailures];
    if (testCase.wantFailure === null) {
      if (problems.length > 0) {
        failures.push(`[${testCase.name}] 期望通过，实际失败：${problems.join('；')}`);
      }
    } else if (!problems.some((problem) => problem.includes(testCase.wantFailure))) {
      failures.push(
        `[${testCase.name}] 期望失败信息包含「${testCase.wantFailure}」，实际：${problems.join('；') || '（无失败）'}`
      );
    }
  }

  for (const testCase of REASON_CASES) {
    const problems = auditAllowlistReason({
      reason: testCase.reason,
      knownPaths: new Set(testCase.knownPaths),
    });
    if (testCase.wantFailure === null) {
      if (problems.length > 0) {
        failures.push(`[${testCase.name}] 期望通过，实际失败：${problems.join('；')}`);
      }
    } else if (!problems.some((problem) => problem.includes(testCase.wantFailure))) {
      failures.push(
        `[${testCase.name}] 期望失败信息包含「${testCase.wantFailure}」，实际：${problems.join('；') || '（无失败）'}`
      );
    }
  }

  if (failures.length > 0) {
    console.error(`check-coverage-scope: self-test FAILED（${failures.length} 个 fixture 不符合预期）`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `check-coverage-scope: self-test passed —— ${SELF_TEST_CASES.length} 个报告 fixture + ${BUDGET_CASES.length} 个白名单预算 fixture + ${REASON_CASES.length} 个理由 fixture 全部符合预期（含缺失文件、0% 行、行数不足、同名遮蔽、范围外文件污染、门槛口径六条失败路径，以及白名单预算上限、理由引用测试文件的存在性检查）`
  );
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

const scopeName = readArg('scope', 'services');
const scope = SCOPES[scopeName];
if (!scope) {
  console.error(
    `check-coverage-scope: 未知 scope「${scopeName}」，可用值：${Object.keys(SCOPES).join(' | ')}`
  );
  process.exit(2);
}

const thresholds = {
  minLines: Number(readArg('min-lines', scope.defaults.minLines)),
  minBranches: Number(readArg('min-branches', scope.defaults.minBranches)),
  minFunctions: Number(readArg('min-functions', scope.defaults.minFunctions)),
};

const expected = scope.listFiles();
if (expected.length === 0) {
  console.error('check-coverage-scope: git 没有列出任何源文件，检查命令是否在仓库根执行');
  process.exit(2);
}

// 白名单预算：条目数 + 被排除行数占比。两个上限都在真实树上判，和白名单本身一起
// 构成「这块到底还有多少在门禁里」的答案。
const allowlistBudgetReport = evaluateAllowlistBudget({
  entries: expected
    .filter((file) => scope.allowedUncovered.has(file))
    .map((file) => ({ file, lines: countSourceLines(file) })),
  totalLines: expected.reduce((sum, file) => sum + countSourceLines(file), 0),
  budget: scope.allowlistBudget,
});

/**
 * 跑一次覆盖率。`coverageExclude` 决定哪些范围外文件不进报告——这同时决定了
 * 「all files」汇总行的口径，所以门槛必须建立在排除后的报告上。
 * node:test 自己的阈值在这里一律置 0：门槛判定由下面的 evaluateThresholds 负责，
 * 否则它又会作用在混合分母上（组件掉到 51.8% 仍能过 60% 的老问题）。
 */
const runSuite = (coverageExclude) =>
  spawnSync(process.execPath, ['./scripts/run-node-tests.mjs', ...scope.suiteTargets], {
    cwd: root,
    encoding: 'utf8',
    // 刻意不传 `--test-coverage-include`：它在 Node 22.12 的 CI 上会让子进程直接退出、
    // 一行报告都留不下（本地 Node 24 才复现得了差异）。include 只是报告过滤器，不会把
    // 未加载的文件补进分母；分母的完整性由下面的 git 清单对比保证。
    env: {
      ...process.env,
      NODE_TEST_COVERAGE: '1',
      NODE_TEST_COVERAGE_INCLUDE: '',
      NODE_TEST_COVERAGE_EXCLUDE: coverageExclude.join(','),
      NODE_TEST_COVERAGE_MIN_LINES: '0',
      NODE_TEST_COVERAGE_MIN_BRANCHES: '0',
      NODE_TEST_COVERAGE_MIN_FUNCTIONS: '0',
    },
  });

const scopeRun = runSuite(scope.coverageExclude);
const scopeOutput = `${scopeRun.stdout ?? ''}${NEWLINE}${scopeRun.stderr ?? ''}`;
const rows = parseReport(scopeOutput);
const aggregate = parseAggregate(scopeOutput);
const trackedEverywhere = new Set(listTrackedSources(['.']));
const untrackedFiles = new Set(
  rows
    .map((row) => row.name)
    .filter((name) => !trackedEverywhere.has(name) && existsSync(path.join(root, name)))
);
const state = inspect({
  expected,
  rows,
  allowedUncovered: scope.allowedUncovered,
  untrackedFiles,
});

// 子进程如果连一行报告都没产出，先说清楚这一点：否则会把「测试没跑起来」误报成
// 「所有文件都没被加载」，上一版就因此在 CI 上给出过误导性的 108 文件全缺清单。
if (state.rowCount === 0) {
  console.error('check-coverage-scope: 覆盖率报告里没有任何文件行，测试进程很可能在产出报告前就退出了');
  console.error(`  子进程退出码: ${scopeRun.status ?? 'null'}${scopeRun.signal ? `，信号: ${scopeRun.signal}` : ''}`);
  if (scopeRun.stdout) process.stdout.write(scopeRun.stdout.slice(-6000));
  if (scopeRun.stderr) process.stderr.write(scopeRun.stderr.slice(-6000));
  process.exit(1);
}

console.log(
  `check-coverage-scope[${scopeName}]: ${expected.length} 个生产源文件（${scope.title}），报告里出现 ${state.rowCount} 行` +
    (state.allowedMissing.length > 0 ? `，已知例外 ${state.allowedMissing.length} 个` : '')
);

for (const file of state.allowedMissing) {
  console.log(`  ~ ${file}（例外：${scope.allowedUncovered.get(file)}）`);
}
for (const file of state.untracked) {
  console.log(`  ! ${file}（工作树新增、尚未被 git 跟踪：本次不参与判定，提交后自动进入分母）`);
}

console.log(
  `check-coverage-scope[${scopeName}]: scope 内覆盖率 ${formatAggregate(aggregate)}（门槛 行 ${thresholds.minLines}% / 分支 ${thresholds.minBranches}% / 函数 ${thresholds.minFunctions}%）`
);
console.log(
  `check-coverage-scope[${scopeName}]: ${formatAllowlistBudget(allowlistBudgetReport, scope.allowlistBudget)}`
);

// 混合口径只作为参考数字打印：它把范围外文件也算进分母，曾经让「组件 60%」变成
// 混合分母的 60%。成功输出里同时给出两个数字，避免下一个人再被它误导。
if (scope.coverageExclude.length > 0) {
  const mixedRun = runSuite([]);
  const mixedAggregate = parseAggregate(`${mixedRun.stdout ?? ''}${NEWLINE}${mixedRun.stderr ?? ''}`);
  console.log(
    mixedAggregate
      ? `check-coverage-scope[${scopeName}]: 混合口径（含 ${scope.coverageExclude.join(' / ')} 里被顺带加载的文件）${formatAggregate(mixedAggregate)} —— 仅作参考，不参与判定`
      : `check-coverage-scope[${scopeName}]: 混合口径报告没有产出汇总行，跳过这行参考数字`
  );
}

const failures = [
  ...describeFailures(state),
  ...allowlistBudgetReport.entryFailures,
  ...allowlistBudgetReport.shareFailures,
  ...evaluateThresholds({ aggregate, thresholds }),
];
if (failures.length > 0) {
  for (const failure of failures) console.error(`check-coverage-scope: ${failure}`);
}

// 阈值已经由 evaluateThresholds 判定，这里剩下的非零退出码只可能来自测试失败。
const testFailure = scopeRun.status !== 0;
if (testFailure && failures.length === 0) {
  console.error(`check-coverage-scope: 覆盖率运行时测试进程失败（退出码 ${scopeRun.status ?? 'null'}）`);
  if (scopeRun.stdout) process.stdout.write(scopeRun.stdout.slice(-4000));
  if (scopeRun.stderr) process.stderr.write(scopeRun.stderr.slice(-4000));
}

if (failures.length > 0 || testFailure) process.exit(1);
console.log(
  `check-coverage-scope[${scopeName}]: OK —— 分母只含本 scope 的源文件（0% 的也已排查），门槛按 scope 汇总行判定通过`
);

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
 * 说明：只解析人类可读报告里的文件名，不额外引入依赖。同名文件（例如两个
 * bitratePolicy.ts）可能互相遮蔽，因此同时比较「报告行数 >= 期望文件数 - 白名单」，
 * 作为第二道校验：解析正则一旦被上游输出格式改动打破，这里直接失败，而不是安静地
 * 漏掉一批文件。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readArg = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

// 行首标记不写死：本地 Node 24 是 `ℹ`，CI 上的 Node 22 观察到 `#`，日志前缀偶尔还会
// 把它替换掉。先剥 ANSI，再接受「可选标记 + 文件名 + 竖线」。
const REPORT_ROW = /^\s*(?:[ℹ#]\s*)?([^\s|]+\.tsx?)\s+\|/;

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
 * 允许暂时不进入覆盖率分母的例外。新文件默认必须被测试加载；只有登记在这里、
 * 且写了理由的文件才不会让守卫失败。加新条目等于承认这块没有回归证据，别随手加。
 */
const SCOPES = {
  services: {
    title: 'services/ + src/',
    listFiles: () => listTrackedSources(['services', 'src']),
    suiteTargets: ['services'],
    defaults: { minLines: '85', minBranches: '78', minFunctions: '75' },
    allowedUncovered: new Map([
      [
        'services/crc32.worker.ts',
        'Web Worker 入口：模块加载即读 self.onmessage，Node 宿主里无法加载；算法本体已由 crc32.test.ts 覆盖',
      ],
      [
        'services/receive/persistedDirectoryHandle.ts',
        '依赖 File System Access API（showDirectoryPicker 等），Node 无对应实现；纯判定已抽到可测模块',
      ],
      [
        'services/receive/sessionCoordinator.ts',
        '会话级集成编排，需要真实 IndexedDB/OPFS 与页面生命周期；等浏览器 harness 落地后再收',
      ],
    ]),
  },
  components: {
    title: 'components/',
    listFiles: () => listTrackedSources(['components']),
    // 组件套件之外再显式加载 scripts/component-import-smoke.test.ts：ErrorBoundary 和
    // PWAInstallPrompt 在 Node 里本来就能加载（实测 import 成功），却没有任何组件测试
    // import 它们。没有这条冒烟，它们永远进不了分母，守卫就又变成一句空话。
    suiteTargets: ['components', 'scripts/component-import-smoke.test.ts'],
    defaults: { minLines: '60', minBranches: '58', minFunctions: '40' },
    allowedUncovered: new Map([
      [
        'components/Receiver.tsx',
        '模块顶层就访问 document（初始化 DOM 副作用），Node 里 import 即抛 ReferenceError；交互路径由 Playwright e2e 覆盖',
      ],
      [
        'components/ScreenShare.tsx',
        '模块顶层访问 window（读写全局状态/定时器），Node 里 import 即抛 ReferenceError；屏幕共享流程由 test:e2e:product-transfer 覆盖',
      ],
      [
        'components/Sender.tsx',
        '模块顶层访问 window，Node 里 import 即抛 ReferenceError；传输路由/重试已抽到 services/send/ 并有单测，UI 由 e2e 覆盖',
      ],
    ]),
  },
};

// ---------------------------------------------------------------------------
// 纯函数：解析报告、判定是否失败。--self-test 直接复用它们，避免「测的是另一套逻辑」。
// ---------------------------------------------------------------------------

/** 解析人类可读覆盖率报告，只保留「文件名 + line%」；表头/分隔线/目录行不计入。 */
const parseReport = (output) => {
  const rows = [];
  for (const line of stripAnsi(output).split('\n')) {
    const match = line.match(REPORT_ROW);
    if (!match) continue;
    const cells = line.split('|');
    const percent = Number.parseFloat((cells[1] ?? '').trim());
    rows.push({
      name: match[1].trim().split('/').pop(),
      linePercent: Number.isFinite(percent) ? percent : null,
    });
  }
  return rows;
};

const inspect = ({ expected, rows, allowedUncovered }) => {
  const reported = new Set(rows.map((row) => row.name));
  const missingAll = expected.filter((file) => !reported.has(path.basename(file)));
  const allowedMissing = missingAll.filter((file) => allowedUncovered.has(file));
  const missing = missingAll.filter((file) => !allowedUncovered.has(file));
  // 0% 行同样要看白名单：白名单文件的「存在性」已经豁免，覆盖率为 0 也就不再单独报。
  const zeroLine = rows.filter(
    (row) =>
      row.linePercent === 0 &&
      expected.some((file) => path.basename(file) === row.name && !allowedUncovered.has(file))
  );
  return {
    rows,
    rowCount: rows.length,
    minimumReported: expected.length - allowedUncovered.size,
    missingAll,
    allowedMissing,
    missing,
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
  if (state.zeroLine.length > 0) {
    failures.push(
      '以下文件进了分母但 line 覆盖率为 0%（等于没有回归证据）：\n' +
        state.zeroLine.map((row) => `  - ${row.name}`).join('\n')
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
];

const runSelfTest = () => {
  const failures = [];
  for (const testCase of SELF_TEST_CASES) {
    const rows = parseReport(testCase.report);
    const state = inspect({ expected: testCase.expected, rows, allowedUncovered: testCase.allowedUncovered });
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
    for (const allowed of testCase.wantAllowedMissing ?? []) {
      if (!state.allowedMissing.includes(allowed)) {
        failures.push(`[${testCase.name}] 期望 ${allowed} 被记为已知例外，实际没有`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`check-coverage-scope: self-test FAILED（${failures.length} 个 fixture 不符合预期）`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `check-coverage-scope: self-test passed —— ${SELF_TEST_CASES.length} 个 fixture 全部符合预期（含缺失文件、0% 行、行数不足三条失败路径）`
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

const minLines = readArg('min-lines', scope.defaults.minLines);
const minBranches = readArg('min-branches', scope.defaults.minBranches);
const minFunctions = readArg('min-functions', scope.defaults.minFunctions);

const expected = scope.listFiles();
if (expected.length === 0) {
  console.error('check-coverage-scope: git 没有列出任何源文件，检查命令是否在仓库根执行');
  process.exit(2);
}

const result = spawnSync(process.execPath, ['./scripts/run-node-tests.mjs', ...scope.suiteTargets], {
  cwd: root,
  encoding: 'utf8',
  // 刻意不传 `--test-coverage-include`：它在 Node 22.12 的 CI 上会让子进程直接退出、
  // 一行报告都留不下（本地 Node 24 才复现得了差异）。include 只是报告过滤器，不会把
  // 未加载的文件补进分母；分母的完整性由下面的 git 清单对比保证。
  env: {
    ...process.env,
    NODE_TEST_COVERAGE: '1',
    NODE_TEST_COVERAGE_INCLUDE: '',
    NODE_TEST_COVERAGE_MIN_LINES: minLines,
    NODE_TEST_COVERAGE_MIN_BRANCHES: minBranches,
    NODE_TEST_COVERAGE_MIN_FUNCTIONS: minFunctions,
  },
});

const rows = parseReport(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
const state = inspect({ expected, rows, allowedUncovered: scope.allowedUncovered });

// 子进程如果连一行报告都没产出，先说清楚这一点：否则会把「测试没跑起来」误报成
// 「所有文件都没被加载」，上一版就因此在 CI 上给出过误导性的 108 文件全缺清单。
if (state.rowCount === 0) {
  console.error('check-coverage-scope: 覆盖率报告里没有任何文件行，测试进程很可能在产出报告前就退出了');
  console.error(`  子进程退出码: ${result.status ?? 'null'}${result.signal ? `，信号: ${result.signal}` : ''}`);
  if (result.stdout) process.stdout.write(result.stdout.slice(-6000));
  if (result.stderr) process.stderr.write(result.stderr.slice(-6000));
  process.exit(1);
}

console.log(
  `check-coverage-scope[${scopeName}]: ${expected.length} 个生产源文件（${scope.title}），报告里出现 ${state.rowCount} 行` +
    (state.allowedMissing.length > 0 ? `，已知例外 ${state.allowedMissing.length} 个` : '')
);

for (const file of state.allowedMissing) {
  console.log(`  ~ ${file}（例外：${scope.allowedUncovered.get(file)}）`);
}

const failures = describeFailures(state);
if (failures.length > 0) {
  for (const failure of failures) console.error(`check-coverage-scope: ${failure}`);
}

const thresholdFailure = result.status !== 0;
if (thresholdFailure && failures.length === 0) {
  console.error('check-coverage-scope: 覆盖率门槛未通过（详见上面的报告与失败信息）');
  if (result.stdout) process.stdout.write(result.stdout.slice(-4000));
  if (result.stderr) process.stderr.write(result.stderr.slice(-4000));
}

if (failures.length > 0 || thresholdFailure) process.exit(1);
console.log(
  `check-coverage-scope[${scopeName}]: OK —— 所有生产源文件都进入了覆盖率分母（0% 的也已排查），且门槛通过`
);

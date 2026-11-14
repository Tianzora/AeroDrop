import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tsxLoaderPath = pathToFileURL(resolve(scriptDir, '../node_modules/tsx/dist/loader.mjs')).href;
const testStubRegisterPath = pathToFileURL(resolve(scriptDir, 'test-stubs/register.mjs')).href;

// Pure helpers only: importing this module must never start a test run.
const readCoverageThreshold = (name, fallback) => {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const readList = (name) => (process.env[name] ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

// 覆盖率过滤器必须可用：没有它，覆盖率只统计「被加载过」的文件，新增一个没人
// import 的模块就不会进分母，门槛会永久绿灯。所以这里是 fail-closed：探测不到就
// 直接拒绝跑门禁，而不是静默退化成更弱的检查。
export const coverageFilterSupport = (flags = process.allowedNodeEnvironmentFlags) =>
  flags.has('--test-coverage-include') && flags.has('--test-coverage-exclude');

const coverageIncludeArgs = () =>
  readList('NODE_TEST_COVERAGE_INCLUDE').map((pattern) => `--test-coverage-include=${pattern}`);

const coverageExcludeArgs = () => {
  const defaults = ['**/*.test.ts', '**/*.test.tsx', 'scripts/test-stubs/**'];
  return [...defaults, ...readList('NODE_TEST_COVERAGE_EXCLUDE')]
    .map((pattern) => `--test-coverage-exclude=${pattern}`);
};

export const buildNodeTestArgs = (files, { coverageFiltersAvailable = coverageFilterSupport() } = {}) => {
  const coverageEnabled = process.env.NODE_TEST_COVERAGE === '1';
  if (coverageEnabled && !coverageFiltersAvailable) {
    throw new Error(
      'Coverage filters (--test-coverage-include/exclude) are unavailable in this Node build; ' +
        'refusing to run NODE_TEST_COVERAGE=1, because the gate would silently only measure loaded files.',
    );
  }
  return [
  // tsx 负责 TS/JSX 转译；test-stubs 把只在浏览器里做视觉效果的大 barrel 依赖
  // （motion/react、@hugeicons/*）换成本地极简实现，避免每个测试子进程重复转译。
  '--import',
  tsxLoaderPath,
  '--import',
  testStubRegisterPath,
  // services/signaling/sessionStore.sqlite.test.ts 用 node:sqlite 跑真实 SQL。
  // Node 22.12（.nvmrc 与 CI）仍需要这个开关；Node 24 接受但不再必需。
  '--experimental-sqlite',
  // CI 用 NODE_TEST_COVERAGE=1 打开覆盖率并卡阈值；本地默认关闭，保持测试快。
  // 默认覆盖率只统计「被加载过」的文件：新增一个没人 import 的模块不进分母，门槛
  // 会永久绿灯。`--test-coverage-include` 只是**报告过滤器**，不会把未加载的文件补进
  // 分母（它在 Node 22.12 上还会让测试进程一行报告都不产出），所以 CI 刻意不传它；
  // 分母的完整性由 scripts/check-coverage-scope.mjs 的 git 清单对比负责。
  ...(process.env.NODE_TEST_COVERAGE === '1'
    ? [
        '--experimental-test-coverage',
        ...coverageIncludeArgs(),
        ...coverageExcludeArgs(),
        `--test-coverage-lines=${readCoverageThreshold('NODE_TEST_COVERAGE_MIN_LINES', 85)}`,
        `--test-coverage-branches=${readCoverageThreshold('NODE_TEST_COVERAGE_MIN_BRANCHES', 78)}`,
        `--test-coverage-functions=${readCoverageThreshold('NODE_TEST_COVERAGE_MIN_FUNCTIONS', 75)}`,
      ]
    : []),
    '--test',
    ...files,
  ];
};

export const collectTestFiles = (targets) => {
  const discovered = new Set();

  const collect = (targetPath) => {
    const resolvedPath = resolve(targetPath);
    const stats = statSync(resolvedPath, { throwIfNoEntry: false });

    if (!stats) {
      throw new Error(`Test target not found: ${resolvedPath}`);
    }

    if (stats.isDirectory()) {
      for (const entry of readdirSync(resolvedPath, { withFileTypes: true })) {
        collect(resolve(resolvedPath, entry.name));
      }
      return;
    }

    // .test.tsx 也要收：UI 测试用 JSX 写在 .tsx 里，只收 .test.ts 会让它们静默不跑。
    if (resolvedPath.endsWith('.test.ts') || resolvedPath.endsWith('.test.tsx')) {
      discovered.add(resolvedPath);
    }
  };

  for (const target of targets) {
    collect(target);
  }

  const testFiles = Array.from(discovered).sort();

  if (testFiles.length === 0) {
    throw new Error(`No test files found for targets: ${targets.join(', ')}`);
  }

  return testFiles;
};

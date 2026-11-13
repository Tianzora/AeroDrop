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

export const buildNodeTestArgs = (files) => [
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
  ...(process.env.NODE_TEST_COVERAGE === '1'
    ? [
        '--experimental-test-coverage',
        `--test-coverage-lines=${readCoverageThreshold('NODE_TEST_COVERAGE_MIN_LINES', 85)}`,
        `--test-coverage-branches=${readCoverageThreshold('NODE_TEST_COVERAGE_MIN_BRANCHES', 78)}`,
        `--test-coverage-functions=${readCoverageThreshold('NODE_TEST_COVERAGE_MIN_FUNCTIONS', 75)}`,
      ]
    : []),
  '--test',
  ...files,
];

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

#!/usr/bin/env node
/**
 * 覆盖率「分母」守卫。
 *
 * 背景：Node 的 `--test-coverage-include` 只是**报告过滤器**，不会把没被任何测试 import
 * 的源文件补进分母。于是 `src/worker.ts` 这类只有集成路径才会加载的文件，长期可以零覆盖
 * 而门禁全绿（工程评审明确点过这条）。
 *
 * 做法：用 git 列出所有生产源文件（services/ 与 src/ 下的非测试 .ts/.tsx），跑一次带
 * include 的覆盖率报告，然后要求每个源文件都在报告里出现（可以 0%，但不能消失）。
 * 缺文件即非 0 退出，并把缺失清单打出来。
 *
 * 用法：node ./scripts/check-coverage-scope.mjs [--min-lines=85] [--min-branches=78]
 * 说明：只解析人类可读报告里的文件名，不额外引入依赖。同名文件（例如两个 bitratePolicy.ts）
 * 可能互相遮蔽，因此同时比较「报告行数 >= 期望文件数」，作为第二道校验。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readArg = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const minLines = readArg('min-lines', '85');
const minBranches = readArg('min-branches', '78');

/**
 * 允许暂时不进入覆盖率分母的例外。新文件默认必须被测试加载；只有登记在这里、
 * 且写了理由的文件才不会让守卫失败。加新条目等于承认这块没有回归证据，别随手加。
 */
const ALLOWED_UNCOVERED = new Map([
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
]);

/** 生产源文件（相对仓库根），与 CI 里的 include 名单保持一致。 */
const listSourceFiles = () => {
  const listed = execFileSync('git', ['ls-files', 'services', 'src'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
    .filter((file) => !file.endsWith('.d.ts'));
  return [...new Set(listed)].sort();
};

const expected = listSourceFiles();
if (expected.length === 0) {
  console.error('check-coverage-scope: git 没有列出任何源文件，检查命令是否在仓库根执行');
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ['./scripts/run-node-tests.mjs', 'services'],
  {
    cwd: root,
    encoding: 'utf8',
    // 刻意不传 `--test-coverage-include`：它在 Node 22.12 的 CI 上会让子进程直接退出、
    // 一行报告都留不下（本地 Node 24 才复现得了差异）。分母的完整性由下面的
    // git 清单对比保证——只要每个源文件都被加载，普通报告的覆盖率就是真实覆盖率。
    env: {
      ...process.env,
      NODE_TEST_COVERAGE: '1',
      NODE_TEST_COVERAGE_INCLUDE: '',
      NODE_TEST_COVERAGE_MIN_LINES: minLines,
      NODE_TEST_COVERAGE_MIN_BRANCHES: minBranches,
    },
  }
);

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const reportLines = output.split('\n');

// 报告行形如 `ℹ   worker.ts   | 71.53 | 75.62 | 53.33 | ...`；嵌套目录会多缩进，
// 但文件名总是最后一段，所以只取 basename 做存在性判断。
const reportedNames = new Set();
for (const line of reportLines) {
  const match = line.match(/^\s*ℹ\s+(.+?\.tsx?)\s+\|/);
  if (match) reportedNames.add(match[1].trim().split('/').pop());
}

const missingAll = expected.filter((file) => !reportedNames.has(file.split('/').pop()));
const missing = missingAll.filter((file) => !ALLOWED_UNCOVERED.has(file));
const allowedMissing = missingAll.filter((file) => ALLOWED_UNCOVERED.has(file));
const reportedCount = reportLines.filter((line) => /^\s*ℹ\s+.+?\.tsx?\s+\|/.test(line)).length;

console.log(
  `check-coverage-scope: ${expected.length} 个生产源文件，报告里出现 ${reportedCount} 行` +
    (allowedMissing.length > 0 ? `，已知例外 ${allowedMissing.length} 个` : '')
);

for (const file of allowedMissing) {
  console.log(`  ~ ${file}（例外：${ALLOWED_UNCOVERED.get(file)}）`);
}

if (missing.length > 0) {
  console.error('check-coverage-scope: 以下文件没有被任何测试加载（不会计入覆盖率分母）：');
  for (const file of missing) console.error(`  - ${file}`);
  console.error('如果确实无法在 Node 里加载，把它登记进 ALLOWED_UNCOVERED 并写明理由。');
}

const thresholdFailure = result.status !== 0;

// 子进程如果连一行报告都没产出，先说清楚这一点：否则会把「测试没跑起来」误报成
// 「所有文件都没被加载」，上一版就因此在 CI 上给出过误导性的 108 文件全缺清单。
if (reportedCount === 0) {
  console.error('check-coverage-scope: 覆盖率报告里没有任何文件行，测试进程很可能在产出报告前就退出了');
  console.error(`  子进程退出码: ${result.status ?? 'null'}${result.signal ? `，信号: ${result.signal}` : ''}`);
  if (result.stdout) process.stdout.write(result.stdout.slice(-6000));
  if (result.stderr) process.stderr.write(result.stderr.slice(-6000));
  process.exit(1);
}

if (thresholdFailure && missing.length === 0) {
  console.error('check-coverage-scope: 覆盖率门槛未通过（详见上面的报告与失败信息）');
  if (result.stdout) process.stdout.write(result.stdout.slice(-4000));
  if (result.stderr) process.stderr.write(result.stderr.slice(-4000));
}

if (missing.length > 0 || thresholdFailure) process.exit(1);
console.log('check-coverage-scope: OK —— 所有生产源文件都进入了覆盖率分母，且门槛通过');

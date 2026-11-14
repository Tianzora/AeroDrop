import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// 门禁的价值全在「它会不会红」。这里把几处「一次编辑就能悄悄关掉整条门禁」的接线钉住：
//   - `test:all` 少了某个 suite、被加上 `|| true`、或某个 suite 脚本退化成只跑一个文件；
//   - CI 的 job/step 被删掉，或加上 job 级 `if: false` / `continue-on-error: true`；
//   - 删掉失败证据上传、8787 空闲断言，或把 CI 下的采集能力断言换成恒真的 `expect(true)`。
// 这些都不是业务逻辑，但它们决定了其余测试有没有人跑。
//
// 解析 `ci.yml` 时按 job / step 切块，而不是在整份文件里搜字符串：整份搜索既会被注释里的
// 字样骗过（`# run: npm run test:all`），也会把命令算到错误的 job 上。注释必须先剥掉，
// 否则 `if: false # temporarily` 这类写法会漏判。
const ROOT = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

const packageJson = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
};

// 四个脚本按当前值精确固定：允许「只跑一个文件」「多接一条兜底命令」的空间，就等于允许
// 门禁被单点关掉。改了 suite 入口时同步改这里，让变更在评审里显形。
const EXPECTED_SCRIPTS: Record<string, string> = {
  'test:all': 'npm run test:services && npm run test:components && npm run test:scripts',
  'test:services': 'node ./scripts/run-node-tests.mjs services',
  'test:components': 'node ./scripts/run-node-tests.mjs components',
  'test:scripts': 'node ./scripts/run-node-tests.mjs scripts',
};

// 兜底/短路开关：`|| true` 让失败变绿，`;` 让后半段无论如何都跑，单个 `&` 把命令扔到
// 后台（CI 的 step 会立刻成功），`2>/dev/null` 吞掉错误。`test:all` 合法地用一个 `&&`
// 串联，所以单 `&` 用「不是 && 的一部分」判定；三个 suite 脚本连 `&` 都不该出现。
const SHELL_FALLBACK = /\|\||;|2>\s*\/dev\/null|(?<!&)&(?!&)/;
const SUITE_SHELL_TOKEN = /[|&;]/;

type Step = { name: string | null; lines: string[] };
type Job = { name: string; lines: string[]; steps: Step[] };

/** 剥掉 YAML 行尾注释：`#` 到行尾（行首注释整行清空），保留 `#` 前的空白。 */
const stripYamlComments = (source: string): string =>
  source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');

/**
 * 按 `^  ([a-z0-9-]+):` 切 job，按 `^\s+- ` 切 step。
 * step 正文（含 `run:` 块标量）留在该 step 里，避免把下一个 step 的内容算进来。
 */
const parseJobs = (source: string): Job[] => {
  const jobs: Job[] = [];
  let job: Job | null = null;
  let step: Step | null = null;
  for (const line of stripYamlComments(source).split('\n')) {
    const jobMatch = line.match(/^  ([a-z0-9-]+):\s*$/);
    if (jobMatch) {
      job = { name: jobMatch[1], lines: [], steps: [] };
      jobs.push(job);
      step = null;
      continue;
    }
    if (!job || !line.trim()) continue;
    job.lines.push(line);
    if (/^\s+- /.test(line)) {
      step = { name: null, lines: [line] };
      job.steps.push(step);
      const nameMatch = line.match(/^\s+- name:\s*(.+?)\s*$/);
      if (nameMatch) step.name = nameMatch[1];
      continue;
    }
    if (step) step.lines.push(line);
  }
  return jobs;
};

/** job 级字段都恰好缩进 4 格；step 从 6 格开始，正文更深。 */
const jobLevelLines = (job: Job): string =>
  job.lines.filter((line) => /^    [A-Za-z0-9_-]+:/.test(line)).join('\n');

/** step 的单行 run 值；块标量（`run: |`）返回 `|`。 */
const stepRun = (step: Step): string | null => {
  for (const line of step.lines) {
    const match = line.match(/^\s+run:\s*(.*?)\s*$/);
    if (match) return match[1];
  }
  return null;
};

const REQUIRED_COMMANDS: Record<string, string[]> = {
  verify: [
    'npm run typecheck',
    'npm run test:all',
    'node ./scripts/check-coverage-scope.mjs --scope=services',
    'npm run build',
  ],
  'coverage-components': ['node ./scripts/check-coverage-scope.mjs --scope=components'],
  e2e: ['npm run test:e2e'],
  'e2e-product': ['npm run test:e2e:product-transfer'],
};

test('test:all 与三个 suite 脚本必须精确指向完整套件，且不允许兜底短路', () => {
  for (const [name, expected] of Object.entries(EXPECTED_SCRIPTS)) {
    const actual = packageJson.scripts[name] ?? '';
    assert.equal(
      actual,
      expected,
      `package.json 的 ${name} 必须精确等于「${expected}」，实际「${actual}」：` +
        '改成只跑一个文件、少一个 suite 或加 `|| true` 都会让整条门禁静默失效'
    );
  }
  for (const [name, expected] of Object.entries(EXPECTED_SCRIPTS)) {
    const actual = packageJson.scripts[name] ?? '';
    assert.doesNotMatch(
      actual,
      SHELL_FALLBACK,
      `package.json 的 ${name} 不允许兜底/短路（||、;、单个 &、2>/dev/null）：失败必须让门禁红`
    );
  }
  for (const name of ['test:services', 'test:components', 'test:scripts']) {
    assert.doesNotMatch(
      packageJson.scripts[name] ?? '',
      SUITE_SHELL_TOKEN,
      `package.json 的 ${name} 不允许出现管道或后台符号：它必须是一个直白的 node 测试入口`
    );
  }
});

test('覆盖率守卫的自检与用例清单测试必须在仓库里', () => {
  for (const file of ['scripts/e2e-suite-inventory.test.ts', 'scripts/check-coverage-scope.test.ts']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} 不存在：门禁失去了自我校验`);
  }
});

test('四个 CI job 的真实执行命令都钉死，且没有 job/step 级跳过开关', () => {
  const jobs = new Map(parseJobs(read('.github/workflows/ci.yml')).map((job) => [job.name, job]));

  for (const [jobName, commands] of Object.entries(REQUIRED_COMMANDS)) {
    const job = jobs.get(jobName);
    assert.ok(job, `ci.yml 里找不到 job「${jobName}」：删掉整个 job 等于关掉这条门禁`);

    const level = jobLevelLines(job);
    assert.doesNotMatch(
      level,
      /^    if:/m,
      `job「${jobName}」不允许有 job 级 if：否则整条门禁可以被一个条件静默跳过`
    );
    assert.doesNotMatch(
      level,
      /^    continue-on-error:\s*true[ \t]*$/m,
      `job「${jobName}」不允许 continue-on-error: true：失败会被吞掉`
    );

    for (const command of commands) {
      const step = job.steps.find((candidate) => stepRun(candidate) === command);
      assert.ok(
        step,
        `job「${jobName}」缺少执行「${command}」的 step：` +
          '删掉它、改名或换成别的命令，都会让对应的测试/构建不再被 CI 执行'
      );
      const block = step.lines.join('\n');
      assert.doesNotMatch(
        block,
        /continue-on-error:\s*true/,
        `job「${jobName}」的「${step.name ?? command}」step 不允许 continue-on-error: true`
      );
      assert.doesNotMatch(
        block,
        /^\s*if:\s*(?:false|0|\$\{\{\s*false\s*\}\})[ \t]*$/m,
        `job「${jobName}」的「${step.name ?? command}」step 不允许 if: false`
      );
    }
  }
});

test('浏览器 job 的失败证据上传与 8787 空闲断言不能被删掉', () => {
  const jobs = new Map(parseJobs(read('.github/workflows/ci.yml')).map((job) => [job.name, job]));

  for (const jobName of ['e2e', 'e2e-product']) {
    const job = jobs.get(jobName);
    assert.ok(job, `ci.yml 里找不到 job「${jobName}」`);

    const upload = job.steps.find((step) =>
      step.lines.some((line) => /actions\/upload-artifact@/.test(line))
    );
    assert.ok(upload, `job「${jobName}」缺少 actions/upload-artifact step：失败证据会随 runner 一起消失`);
    const block = upload.lines.join('\n');
    assert.match(
      block,
      /^\s*if:\s*always\(\)[ \t]*$/m,
      `job「${jobName}」的上传 step 必须 if: always()：否则失败时 trace/screenshot 不会被上传`
    );
    assert.match(
      block,
      /path:\s*test-results\/[ \t]*$/m,
      `job「${jobName}」的上传 step 必须覆盖 test-results/`
    );
  }

  const productJob = jobs.get('e2e-product');
  assert.ok(productJob, 'ci.yml 里找不到 job「e2e-product」');
  const portStep = productJob.steps.find((step) => (step.name ?? '').includes('8787'));
  assert.ok(
    portStep,
    'job「e2e-product」缺少「8787 空闲」断言 step：端口被占用时 start-server-and-test 会误判服务已就绪'
  );
  const portBlock = portStep.lines.join('\n');
  assert.match(portBlock, /ss\s+-ltn/, '「8787 空闲」断言必须真的检查监听端口');
  assert.match(portBlock, /exit\s+1/, '「8787 空闲」断言在端口被占用时必须 exit 1');
});

test('浏览器用例在 CI 下必须断言采集能力可用', () => {
  const spec = read('e2e/screenshare.spec.ts');
  // 只接受 `expect(supported...).toBe(true)`：`expect(true).toBe(true)` 之类的恒真断言
  // 一旦混进来，采集能力回归时整批用例会 skip 而 job 依旧全绿。
  assert.match(
    spec,
    /if\s*\(\s*process\.env\.CI\s*\)\s*\{[\s\S]{0,800}?expect\(\s*supported\b[\s\S]{0,300}?\.toBe\(\s*true\s*\)/,
    'CI 下必须把「能否真采集」当断言（expect(supported, ...).toBe(true)）：否则采集能力回归时整批用例 skip，job 仍然全绿'
  );
});

test('两个浏览器 job 必须挂在 verify 之后', () => {
  const jobs = new Map(parseJobs(read('.github/workflows/ci.yml')).map((job) => [job.name, job]));

  for (const jobName of ['e2e', 'e2e-product']) {
    const job = jobs.get(jobName);
    assert.ok(job, `ci.yml 里找不到 job「${jobName}」`);
    assert.match(
      jobLevelLines(job),
      /^    needs:\s*verify[ \t]*$/m,
      `job「${jobName}」必须在 verify 绿了之后才跑（needs: verify）`
    );
  }
});

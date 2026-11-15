import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// 门禁的价值全在「它会不会红」。这里把几处「一次编辑就能悄悄关掉整条门禁」的接线钉住：
//   - `test:all` 少了某个 suite、被加上 `|| true`、或某个 suite 脚本退化成只跑一个文件；
//   - CI 的 job/step 被删掉，或被加上任何形式的跳过开关；
//   - 删掉失败证据上传、8787 空闲断言，或把 CI 下的采集能力断言换成恒真的 `expect(true)`。
// 这些都不是业务逻辑，但它们决定了其余测试有没有人跑。
//
// 判定逻辑集中在 `findWiringProblems()` 里，并用一组「在真实 workflow 上做一处变异」的
// fixture 钉住它自身：一个只会说「没发现问题」的检查器同样是门禁失效。跳过开关的判定
// 刻意不看取值 —— `continue-on-error: ${{ true }}`、`if: ${{ 1 == 2 }}` 与字面量
// `if: false` 是完全一样的后果，按字面量匹配只会挡住最笨的那一种写法。
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
      if (nameMatch) step.name = nameMatch[1].replace(/^['"]|['"]$/g, '');
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

const stepRunBlock = (step: Step): string => {
  const lines = step.lines;
  const start = lines.findIndex((line) => /^\s+run:/.test(line));
  if (start < 0) return '';
  return lines.slice(start).join('\n');
};

const REQUIRED_JOBS: Record<string, { commands: string[]; browser?: boolean; maxTimeout: number }> = {
  verify: {
    commands: [
      'npm run typecheck',
      'npm run test:all',
      'node ./scripts/check-coverage-scope.mjs --scope=services',
      'npm run build',
    ],
    maxTimeout: 20,
  },
  'coverage-components': {
    commands: ['node ./scripts/check-coverage-scope.mjs --scope=components'],
    maxTimeout: 20,
  },
  e2e: { commands: ['npm run test:e2e'], browser: true, maxTimeout: 45 },
  'e2e-product': { commands: ['npm run test:e2e:product-transfer'], browser: true, maxTimeout: 45 },
};

// 清理/上传步骤允许 `if: always()`（且必须是这个值）；其余任何 step 都不该有 `if:`。
const ALWAYS_STEP_NAME = /^(Upload|Kill stray)/;
// 门禁 step 的 run 里不允许 GitHub 表达式：`${{ }}` 可以凭空算出命令，等于把命令藏进别处。
const GH_EXPRESSION = /\$\{\{/;

/**
 * 返回所有接线问题（空数组 = 门禁完好）。
 * 只做静态判定，可以喂任意 workflow 文本 —— 下面那组 fixture 就是拿真实文件做一处变异，
 * 断言每种「悄悄关掉门禁」的写法都会被点名。
 */
export const findWiringProblems = (workflow: string): string[] => {
  const problems: string[] = [];
  const jobs = new Map(parseJobs(workflow).map((job) => [job.name, job]));

  // step 级：任何 step 都不允许 continue-on-error 或 GitHub 表达式；`if:` 只允许清理/上传
  // 步骤使用 always()。不判取值，因为表达式的效果与字面量相同。
  for (const job of jobs.values()) {
    for (const step of job.steps) {
      const label = `${job.name}/${step.name ?? '(未命名 step)'}`;
      const block = step.lines.join('\n');
      if (/^\s+continue-on-error:/m.test(block)) {
        problems.push(`${label} 不允许 continue-on-error（任何取值）：失败必须让 job 红`);
      }
      if (GH_EXPRESSION.test(block)) {
        problems.push(`${label} 的字段里不允许 GitHub 表达式：命令与开关必须写死在本文件`);
      }
      const ifMatch = block.match(/^\s+if:\s*(.+?)\s*$/m);
      if (ifMatch) {
        const value = ifMatch[1].replace(/\s+/g, ' ');
        const allowed = value === 'always()' && ALWAYS_STEP_NAME.test(step.name ?? '');
        if (!allowed) {
          problems.push(`${label} 的 if 只允许清理/上传 step 用 always()，实际「${value}」`);
        }
      }
    }
  }

  for (const [jobName, spec] of Object.entries(REQUIRED_JOBS)) {
    const job = jobs.get(jobName);
    if (!job) {
      problems.push(`缺少 job「${jobName}」`);
      continue;
    }
    const jobLevel = jobLevelLines(job);
    if (/^    if:/m.test(jobLevel)) {
      problems.push(`job「${jobName}」不允许 job 级 if：整条门禁可以被一个表达式跳过`);
    }
    if (/^    continue-on-error:/m.test(jobLevel)) {
      problems.push(`job「${jobName}」不允许 job 级 continue-on-error（任何取值）`);
    }
    const timeout = jobLevel.match(/^    timeout-minutes:\s*(\d+)\s*$/m);
    if (!timeout) {
      problems.push(`job「${jobName}」必须显式声明 timeout-minutes`);
    } else if (Number(timeout[1]) > spec.maxTimeout) {
      problems.push(
        `job「${jobName}」的 timeout-minutes 是 ${timeout[1]}，超过 ${spec.maxTimeout}：超时配大了，卡死的 job 会一直占着 runner`
      );
    }
    if (spec.browser && !/^    needs:\s*verify\s*$/m.test(jobLevel)) {
      problems.push(`job「${jobName}」必须 needs: verify（单测/类型检查挂了不该再烧浏览器 runner）`);
    }
    for (const command of spec.commands) {
      const step = job.steps.find((candidate) => (stepRun(candidate) ?? '').startsWith(command));
      if (!step) {
        problems.push(`job「${jobName}」缺少 run: ${command}`);
        continue;
      }
      const label = `${jobName}/${step.name ?? command}`;
      if (stepRun(step) !== command) {
        problems.push(`${label} 的门禁命令必须精确等于「${command}」，不允许多接内容`);
      }
      if (SHELL_FALLBACK.test(stepRunBlock(step))) {
        problems.push(`${label} 的命令里不允许兜底/短路（||、;、单个 &、2>/dev/null）`);
      }
    }
  }

  // 失败证据：两个浏览器 job 都必须在失败时仍上传 test-results/。
  for (const jobName of ['e2e', 'e2e-product']) {
    const job = jobs.get(jobName);
    if (!job) continue;
    const upload = job.steps.find((step) =>
      step.lines.some((line) => /actions\/upload-artifact@/.test(line))
    );
    if (!upload) {
      problems.push(`job「${jobName}」缺少 actions/upload-artifact step：失败证据会随 runner 一起消失`);
      continue;
    }
    const block = upload.lines.join('\n');
    if (!/^\s*if:\s*always\(\)[ \t]*$/m.test(block)) {
      problems.push(`job「${jobName}」的上传 step 必须 if: always()`);
    }
    if (!/^\s*path:\s*test-results\/[ \t]*$/m.test(block)) {
      problems.push(`job「${jobName}」的上传 step 必须覆盖 test-results/`);
    }
  }

  // 8787 断言：端口被占用时 start-server-and-test 会误判服务已就绪。
  const productJob = jobs.get('e2e-product');
  if (productJob) {
    const portStep = productJob.steps.find((step) => (step.name ?? '').includes('8787'));
    if (!portStep) {
      problems.push('job「e2e-product」缺少「8787 空闲」断言 step');
    } else {
      const block = portStep.lines.join('\n');
      if (!/ss\s+-ltn/.test(block)) problems.push('「8787 空闲」断言必须真的检查监听端口（ss -ltn）');
      if (!/exit\s+1/.test(block)) problems.push('「8787 空闲」断言在端口被占用时必须 exit 1');
    }
  }

  return problems;
};

const REAL_WORKFLOW = read('.github/workflows/ci.yml');

/** 在真实 workflow 上做一处替换；找不到目标说明文件结构变了，fixture 失效。 */
const mutate = (from: string, to: string): string => {
  assert.ok(
    REAL_WORKFLOW.includes(from),
    `fixture 失效：ci.yml 里找不到要变异的片段「${from}」——先更新 fixture，别让它悄悄空转`
  );
  return REAL_WORKFLOW.replace(from, to);
};

/** 断言某个变异会产出一条包含 expect 的问题。 */
const expectProblem = (workflow: string, expect: string): void => {
  const problems = findWiringProblems(workflow);
  assert.ok(
    problems.some((problem) => problem.includes(expect)),
    `期望门禁被点名「${expect}」，实际问题列表：${problems.join(' | ') || '（空）'}`
  );
};

test('workflow 接线检查器自身必须能抓住各种「悄悄关掉门禁」的写法', () => {
  assert.deepEqual(findWiringProblems(REAL_WORKFLOW), [], '真实 ci.yml 不应有任何接线问题');

  // 1. step 级表达式跳过（不是字面量 false，所以按字面量匹配的旧实现看不见）
  expectProblem(
    mutate("      - name: Typecheck\n        run: npm run typecheck", "      - name: Typecheck\n        if: ${{ 1 == 2 }}\n        run: npm run typecheck"),
    '的 if 只允许清理/上传 step 用 always()'
  );

  // 2. step 级 continue-on-error 用表达式：失败被吞，job 依旧绿
  expectProblem(
    mutate('      - name: Unit tests\n', '      - name: Unit tests\n        continue-on-error: ${{ true }}\n'),
    '不允许 continue-on-error（任何取值）'
  );

  // 3. job 级 continue-on-error 同理
  expectProblem(
    mutate('  verify:\n    name: typecheck + tests + build\n', '  verify:\n    name: typecheck + tests + build\n    continue-on-error: ${{ true }}\n'),
    '不允许 job 级 continue-on-error'
  );

  // 4. job 改名：整条门禁消失而其余 job 照跑
  expectProblem(mutate('  coverage-components:\n', '  coverage-components-renamed:\n'), '缺少 job「coverage-components」');

  // 5. 门禁 step 删掉
  expectProblem(
    mutate('      - name: Build\n        run: npm run build\n', ''),
    '缺少 run: npm run build'
  );

  // 6. run 里塞 GitHub 表达式，把真正执行的命令藏到别处
  expectProblem(
    mutate('        run: npm run test:e2e\n', '        run: ${{ github.event.inputs.test }} npm run test:e2e\n'),
    '不允许 GitHub 表达式'
  );

  // 7. 门禁命令加兜底，失败不再传播
  expectProblem(
    mutate('        run: npm run test:e2e\n', '        run: npm run test:e2e || true\n'),
    '不允许兜底/短路'
  );

  // 8. needs 改挂到别的 job：verify 红了浏览器用例照跑（或反过来被跳过）
  expectProblem(
    mutate(
      '    # 20 分钟。注意这不构成部署闸门 —— 部署走 Cloudflare 的 Git 集成，不看 CI。\n    needs: verify',
      '    # 20 分钟。注意这不构成部署闸门 —— 部署走 Cloudflare 的 Git 集成，不看 CI。\n    needs: coverage-components'
    ),
    '必须 needs: verify'
  );

  // 9. 上传 step 改成只在成功时上传：失败时的 trace/screenshot 就没了
  expectProblem(
    mutate('      - name: Upload Playwright artifacts\n        if: always()', '      - name: Upload Playwright artifacts\n        if: success()'),
    '的 if 只允许清理/上传 step 用 always()'
  );
});

test('test:all 与三个 suite 脚本必须精确指向完整套件，且不允许兜底短路', () => {
  for (const [name, expected] of Object.entries(EXPECTED_SCRIPTS)) {
    const actual = packageJson.scripts[name] ?? '';
    assert.equal(
      actual,
      expected,
      `package.json 的 ${name} 必须精确等于「${expected}」，实际「${actual}」：` +
        '改成只跑一个文件、少一个 suite 或加 `|| true` 都会让整条门禁静默失效'
    );
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
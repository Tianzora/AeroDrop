import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { buildNodeTestArgs, collectTestFiles } from './node-test-args.mjs';

test('buildNodeTestArgs uses an explicit tsx loader path instead of the bare package specifier', () => {
  const args = buildNodeTestArgs(['services/connectionPolicy.test.ts']);

  assert.equal(args[0], '--import');
  assert.notEqual(args[1], 'tsx');
  assert.match(args[1], /tsx[\\\\/].*loader\.mjs|tsx\/dist\/loader\.mjs/);
  // 断言「--test 在文件之前」而不是固定下标：中间会继续插入其它 node 开关
  // （--experimental-sqlite、覆盖率参数），钉死下标会让无害的加旗标变成红灯。
  const testFlagIndex = args.indexOf('--test');
  assert.ok(testFlagIndex >= 0, '--test 缺失');
  assert.equal(args[args.length - 1], 'services/connectionPolicy.test.ts');
  // node:sqlite 契约测试（sessionStore.sqlite.test.ts）在 Node 22.12 上需要这个开关。
  assert.ok(args.includes('--experimental-sqlite'), '--experimental-sqlite 缺失');
});

test('buildNodeTestArgs registers the test stubs after tsx so they win module resolution', () => {
  const args = buildNodeTestArgs(['components/TransferProgress.test.ts']);
  const tsxLoaderIndex = args.findIndex((arg) => /tsx[\\\\/].*loader\.mjs/.test(arg));
  const stubRegisterIndex = args.findIndex((arg) => /test-stubs[\\\\/]register\.mjs/.test(arg));

  assert.equal(args[2], '--import');
  assert.ok(tsxLoaderIndex >= 0, 'tsx loader 缺失');
  assert.ok(stubRegisterIndex >= 0, 'test-stubs register 缺失');
  // 顺序有意义：后注册的 resolve 钩子先执行，stub 必须排在 tsx 之后，
  // 否则大 barrel 依赖先被真实包解析掉，stub 永远不生效。
  assert.ok(tsxLoaderIndex < stubRegisterIndex);
});

test('coverage 只有显式打开时才加参数，CI 用它卡阈值而不拖慢本地测试', () => {
  const previous = process.env.NODE_TEST_COVERAGE;
  try {
    delete process.env.NODE_TEST_COVERAGE;
    assert.ok(!buildNodeTestArgs([]).includes('--experimental-test-coverage'));

    process.env.NODE_TEST_COVERAGE = '1';
    const args = buildNodeTestArgs([]);
    assert.ok(args.includes('--experimental-test-coverage'));
    assert.ok(args.includes('--test-coverage-lines=85'));
    assert.ok(args.includes('--test-coverage-branches=78'));

    process.env.NODE_TEST_COVERAGE_MIN_LINES = '90';
    assert.ok(buildNodeTestArgs([]).includes('--test-coverage-lines=90'));
  } finally {
    delete process.env.NODE_TEST_COVERAGE_MIN_LINES;
    if (previous === undefined) delete process.env.NODE_TEST_COVERAGE;
    else process.env.NODE_TEST_COVERAGE = previous;
  }
});

test('collectTestFiles 递归收 .test.ts 与 .test.tsx，忽略普通源码', () => {
  const root = mkdtempSync(join(tmpdir(), 'aerodrop-collect-'));
  try {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'a.test.ts'), '');
    writeFileSync(join(root, 'nested', 'b.test.tsx'), '');
    writeFileSync(join(root, 'nested', 'helper.ts'), '');
    writeFileSync(join(root, 'notes.md'), '');

    const files = collectTestFiles([root]).map((file) => relative(root, file).split(sep).join('/'));
    assert.deepEqual(files, ['a.test.ts', 'nested/b.test.tsx']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectTestFiles 对不存在的目标与空目录报错，而不是静默跑 0 条测试', () => {
  assert.throws(() => collectTestFiles(['definitely-missing-dir']), /Test target not found/);

  const empty = mkdtempSync(join(tmpdir(), 'aerodrop-empty-'));
  try {
    assert.throws(() => collectTestFiles([empty]), /No test files found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

const isolatedEnv = (): Record<string, string | undefined> => {
  // 子进程里残留 NODE_TEST_CONTEXT 会让它对 `node --test` 误以为自己是被父 runner
  // 启动的测试文件，失败时也返回 0——正是本条测试要防的假绿。
  const env: Record<string, string | undefined> = { ...process.env, NODE_TEST_COVERAGE: '0' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_REPORTER;
  return env;
};

test('runner 把子进程的失败退出码透传出去，不会把红测试报成绿', () => {
  // 直接断言脚本行为：以前 runner 只看 spawnSync 的 status，这里守住
  // 「测试失败 → 进程非 0」这条契约，避免 CI 靠退出码判断时假绿。
  const root = mkdtempSync(join(tmpdir(), 'aerodrop-runner-'));
  try {
    writeFileSync(
      join(root, 'failing.test.ts'),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        '',
        "test('fails on purpose', () => { assert.fail('boom'); });",
        '',
      ].join(String.fromCharCode(10)),
    );
    const result = spawnSync(process.execPath, [join('scripts', 'run-node-tests.mjs'), root], {
      cwd: process.cwd(),
      encoding: 'utf8',
      // 在 node --test 里再 spawn 一个 node --test：必须删掉 NODE_TEST_CONTEXT，
      // 否则子进程会以为自己是被父 runner 启动的测试文件，退出码不再反映结果。
      env: isolatedEnv(),
    });
    assert.notEqual(result.status, 0, '失败的测试必须让 runner 非 0 退出');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner 对不存在的目标直接非 0 退出，而不是空跑成功', () => {
  const result = spawnSync(process.execPath, [join('scripts', 'run-node-tests.mjs'), 'definitely-missing-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  assert.notEqual(result.status, 0);
});

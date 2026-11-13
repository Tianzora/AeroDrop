import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNodeTestArgs } from './node-test-args.mjs';

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

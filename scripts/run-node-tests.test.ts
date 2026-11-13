import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNodeTestArgs } from './node-test-args.mjs';

test('buildNodeTestArgs uses an explicit tsx loader path instead of the bare package specifier', () => {
  const args = buildNodeTestArgs(['services/connectionPolicy.test.ts']);

  assert.equal(args[0], '--import');
  assert.notEqual(args[1], 'tsx');
  assert.match(args[1], /tsx[\\/].*loader\.mjs|tsx\/dist\/loader\.mjs/);
  assert.equal(args[4], '--test');
  assert.equal(args[5], 'services/connectionPolicy.test.ts');
});

test('buildNodeTestArgs registers the test stubs after tsx so they win module resolution', () => {
  const args = buildNodeTestArgs(['components/TransferProgress.test.ts']);
  const tsxLoaderIndex = args.findIndex((arg) => /tsx[\\/].*loader\.mjs/.test(arg));
  const stubRegisterIndex = args.findIndex((arg) => /test-stubs[\\/]register\.mjs/.test(arg));

  assert.equal(args[2], '--import');
  assert.ok(tsxLoaderIndex >= 0, 'tsx loader 缺失');
  assert.ok(stubRegisterIndex >= 0, 'test-stubs register 缺失');
  // 顺序有意义：后注册的 resolve 钩子先执行，stub 必须排在 tsx 之后，
  // 否则大 barrel 依赖先被真实包解析掉，stub 永远不生效。
  assert.ok(tsxLoaderIndex < stubRegisterIndex);
});

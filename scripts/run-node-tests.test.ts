import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNodeTestArgs } from './node-test-args.mjs';

test('buildNodeTestArgs uses an explicit tsx loader path instead of the bare package specifier', () => {
  const args = buildNodeTestArgs(['services/connectionPolicy.test.ts']);

  assert.equal(args[0], '--import');
  assert.notEqual(args[1], 'tsx');
  assert.match(args[1], /tsx[\\/].*loader\.mjs|tsx\/dist\/loader\.mjs/);
  assert.equal(args[2], '--test');
  assert.equal(args[3], 'services/connectionPolicy.test.ts');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// 用例数在四个地方被引用（CI 的两处注释、覆盖率白名单理由、设计文档），而它已经连续
// 三轮漂移（9 → 10）。人工同步不可靠，所以把「真实用例数」与「被引用的数字」绑起来：
// 任何一边变了，这条测试就会红，并在消息里点名需要一起改的位置。
const ROOT = join(import.meta.dirname, '..');

const countTests = (file: string): number => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  // 顶层用例（product-transfer）与 describe 内的用例（screenshare，两空格缩进）都算。
  return source.match(/^ {0,2}test\(/gm)?.length ?? 0;
};

const readRepoFile = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

const referencedCounts = (source: string, pattern: RegExp): number[] =>
  Array.from(source.matchAll(pattern), (match) => Number(match[1]));

test('screenshare 用例数与被引用处一致', () => {
  const actual = countTests('e2e/screenshare.spec.ts');
  assert.equal(actual, 10, '改了 e2e/screenshare.spec.ts 的用例数，就要同步 CI 注释与白名单理由');

  const ci = readRepoFile('.github/workflows/ci.yml');
  assert.deepEqual(
    referencedCounts(ci, /含 (\d+) 条屏幕共享/g),
    [actual],
    '.github/workflows/ci.yml 里的「含 N 条屏幕共享」必须等于真实用例数'
  );
  assert.deepEqual(
    referencedCounts(ci, /screenshare\.spec\.ts（(\d+) 条/g),
    [actual],
    '.github/workflows/ci.yml 的用例清单里的数字必须等于真实用例数'
  );
  assert.deepEqual(
    referencedCounts(readRepoFile('scripts/check-coverage-scope.mjs'), /的 (\d+) 条 screenshare 用例覆盖/g),
    [actual],
    '覆盖率白名单理由里的数字必须等于真实用例数'
  );
  // 这个文件自己的头注释也写着「N 条用例会整组 skip」，同样会漂。
  assert.deepEqual(
    referencedCounts(readRepoFile('e2e/screenshare.spec.ts'), /一旦回归，(\d+) 条用例会整组 skip/g),
    [actual],
    'e2e/screenshare.spec.ts 头注释里的数字必须等于真实用例数'
  );
});

test('product-transfer 用例数与被引用处一致', () => {
  const actual = countTests('e2e/product-transfer.spec.ts');
  assert.equal(actual, 3, '改了 e2e/product-transfer.spec.ts 的用例数，就要同步 CI 注释');

  const ci = readRepoFile('.github/workflows/ci.yml');
  assert.deepEqual(
    referencedCounts(ci, /product-transfer\.spec\.ts（(\d+) 条/g),
    [actual],
    '.github/workflows/ci.yml 的用例清单里的数字必须等于真实用例数'
  );
});

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
  // 顶层用例（product-transfer）与 describe 内的用例（screenshare）都算，缩进深度不限：
  // 旧正则只认 0–2 空格，往 describe 里挪一层（4 空格）就会少数一条而测试仍然绿。
  return source.match(/^[ 	]*test\(/gm)?.length ?? 0;
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
  // 头注释写的是「N 条走 ensureDisplayCapture 的用例会整组 skip」：这些用例靠真采一次验证
  // 能力，探测失败就整体 skip。它和别的引用一样会漂，所以绑到真实调用点数量上。
  const spec = readRepoFile('e2e/screenshare.spec.ts');
  const probed = spec.match(/await ensureDisplayCapture\(/g)?.length ?? 0;
  assert.deepEqual(
    referencedCounts(spec, /一旦回归，(\d+) 条走 ensureDisplayCapture 的用例会整组 skip/g),
    [probed],
    'e2e/screenshare.spec.ts 头注释里的数字必须等于真正调用 ensureDisplayCapture 的用例数'
  );
  assert.ok(probed > 0 && probed <= actual, '探测点数量必须落在 1..用例数之间');
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

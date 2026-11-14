import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.equal(actual, 12, '改了 e2e/screenshare.spec.ts 的用例数，就要同步 CI 注释与白名单理由');

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

// `--list` 只读取配置与 spec 文件、不启动 preview/worker，也不会占用 8787/3401；
// 它验证的是「testMatch 实际选中的就是这两个文件、条数就是 13」，比数 `test(` 更接近
// CI 真正会跑的东西（例如 spec 被移出 testDir 时，计数仍然 13 但实际一条都不跑）。
const listProductTests = (): { total: number; files: number } | null => {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(
    npx,
    ['playwright', 'test', '--list', '--config=playwright.product.config.ts'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      // Windows 上 .cmd 必须经过 shell 才能执行（Node 的 spawn 安全策略）。
      shell: process.platform === 'win32',
    }
  );
  if (result.error || result.status !== 0) return null;
  const match = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(
    /Total:\s+(\d+)\s+tests?\s+in\s+(\d+)\s+files?/i
  );
  return match ? { total: Number(match[1]), files: Number(match[2]) } : null;
};

test('product 配置的 testMatch 同时选中两个 spec，并能列出 15 条用例', () => {
  const config = readRepoFile('playwright.product.config.ts');
  const testMatch = config.match(/testMatch:\s*\[([^\]]*)\]/);
  assert.ok(testMatch, 'playwright.product.config.ts 里找不到 testMatch 数组');
  const patterns = Array.from(testMatch[1].matchAll(/['"]([^'"]+)['"]/g), (match) => match[1]);
  for (const spec of ['screenshare.spec.ts', 'product-transfer.spec.ts']) {
    assert.ok(
      patterns.includes(spec),
      `playwright.product.config.ts 的 testMatch 少了 ${spec}：` +
        '删掉它不会让任何测试变红，只会让整个文件从产品级 E2E 里静默消失'
    );
  }

  const listed = listProductTests();
  if (listed) {
    assert.equal(
      listed.total,
      15,
      `--list 解析出 ${listed.total} 条产品级用例，期望 15 条（product-transfer 3 + screenshare 12）`
    );
    assert.equal(listed.files, 2, 'testMatch 必须恰好覆盖两个 spec 文件');
    return;
  }

  // 降级：本机 `npx` / Playwright 起不来（离线、未安装、Windows 下 .cmd 被安全策略挡住）
  // 时不把「工具链不可用」误报成门禁回归，改为解析 spec 里的 `test(` 计数。降级只校验
  // 条数与文件存在性，覆盖不到 testMatch 的选取范围 —— 上面那段已经单独钉住两个 pattern。
  const specs = ['e2e/product-transfer.spec.ts', 'e2e/screenshare.spec.ts'];
  const total = specs.reduce((sum, file) => sum + countTests(file), 0);
  for (const file of specs) {
    assert.ok(countTests(file) > 0, `${file} 里解析不到任何 test(，用例清单可能已被改坏`);
  }
  assert.equal(total, 15, `降级计数得到 ${total} 条产品级用例，期望 15 条`);
  assert.equal(specs.length, 2, '产品级套件必须恰好由两个 spec 文件组成');
});

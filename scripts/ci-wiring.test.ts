import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// 门禁的价值全在「它会不会红」。这里把几处「一次编辑就能悄悄关掉整条门禁」的接线钉住：
//   - `test:all` 忘了带某个 suite ⇒ 那条 suite 里的守卫（含本文件与 inventory 测试）静默消失；
//   - CI 的覆盖率 step 加 `if: false` / `continue-on-error` ⇒ job 永远绿；
//   - 删掉 CI 下「采集能力必须为 true」的断言 ⇒ 浏览器用例整批 skip 而 job 依旧全绿。
// 这些都不是业务逻辑，但它们决定了其余测试有没有人跑。
const ROOT = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

const packageJson = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
};

test('test:all 必须把三个 suite 都跑一遍', () => {
  const all = packageJson.scripts['test:all'] ?? '';
  for (const suite of ['test:services', 'test:components', 'test:scripts']) {
    assert.match(
      all,
      new RegExp(`npm run ${suite}\\b`),
      `package.json 的 test:all 少了 ${suite}：漏掉它会让该 suite 里的门禁测试静默消失`
    );
  }
});

test('覆盖率守卫的自检与用例清单测试必须在仓库里', () => {
  for (const file of ['scripts/e2e-suite-inventory.test.ts', 'scripts/check-coverage-scope.test.ts']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} 不存在：门禁失去了自我校验`);
  }
});

test('CI 的覆盖率 step 不允许被跳过或忽略失败', () => {
  const ci = read('.github/workflows/ci.yml');
  const steps = [
    'Unit test coverage gate (services + src)',
    'Component coverage gate',
  ];
  for (const name of steps) {
    const index = ci.indexOf(`- name: ${name}`);
    assert.ok(index >= 0, `ci.yml 里找不到「${name}」这一步`);
    // 取这一步到下一个 step 之间的文本，逐行检查跳过/忽略失败的开关。
    const rest = ci.slice(index);
    const nextStep = rest.indexOf('\n      - name:', 1);
    const block = nextStep >= 0 ? rest.slice(0, nextStep) : rest;
    assert.doesNotMatch(block, /^\s*if:\s*(false|0|\$\{\{\s*false\s*\}\})\s*$/m, `「${name}」不允许写 if: false`);
    assert.doesNotMatch(block, /continue-on-error:\s*true/, `「${name}」不允许 continue-on-error: true`);
    assert.match(block, /run:\s*node \.\/scripts\/check-coverage-scope\.mjs/, `「${name}」必须真的调守卫脚本`);
  }
});

test('浏览器用例在 CI 下必须断言采集能力可用', () => {
  const spec = read('e2e/screenshare.spec.ts');
  assert.match(
    spec,
    /if \(process\.env\.CI\) \{[\s\S]{0,400}?\.toBe\(true\)/,
    'CI 下必须把「能否真采集」当断言：否则 9 条用例整体 skip，job 仍然全绿'
  );
});

test('两个浏览器 job 必须挂在 verify 之后', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const job of ['e2e:', 'e2e-product:']) {
    const index = ci.indexOf(`\n  ${job}`);
    assert.ok(index >= 0, `ci.yml 里找不到 job ${job}`);
    const block = ci.slice(index, index + 900);
    assert.match(block, /needs:\s*verify/, `${job} 必须在 verify 绿了之后才跑`);
  }
});

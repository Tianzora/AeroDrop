import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// 守卫脚本靠解析 node 的人类可读覆盖率报告工作，最容易静默失效的地方就是解析/
// 判定规则本身（上游换个行首标记、多一层缩进、加个色彩转义，都能让门禁变成摆设）。
// 这里只 spawn 不跑测试套件的那两条路径：--self-test 校验内联 fixture，未知 scope
// 校验参数错误，都能在毫秒内给退出码和消息。
const scriptPath = path.resolve('scripts/check-coverage-scope.mjs');

const runGuard = (...args: string[]) =>
  spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });

test('--self-test 校验解析、判定、白名单预算与理由规则', () => {
  const result = runGuard('--self-test');

  assert.equal(result.status, 0, `self-test 失败：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /self-test passed/);
  assert.match(result.stdout, /fixture/);
  // fixture 里必须真的验证过「缺失文件 / 0% 行 / 行数不足 / 同名遮蔽 / 范围外文件污染 /
  // 门槛口径」这六条失败路径，否则自测只是在证明「能解析一段我自己写的文本」。同名遮蔽
  // 与门槛口径是后加的两条：裸文件名会互相顶替，而 all files 汇总行会把范围外文件的
  // 覆盖率算进组件门槛。
  assert.match(result.stdout, /缺失文件、0% 行、行数不足、同名遮蔽、范围外文件污染、门槛口径六条失败路径/);
  // 白名单预算与理由引用是后加的两组 fixture：前者拦「白名单把文件整块挪出分母」，
  // 后者拦「理由里写了一个不存在的测试文件」这种假理由（只查 git ls-files 的源码清单
  // 会漏掉全部 *.test.*，那条检查原本永远为真）。
  assert.match(result.stdout, /\d+ 个白名单预算 fixture/);
  assert.match(result.stdout, /\d+ 个理由 fixture/);
  assert.match(result.stdout, /白名单预算上限、理由引用测试文件的存在性检查/);
});

// 守卫本身没有价值这件事很隐蔽：脚本写得再好，CI 里不跑（或者只跑一半）就等于没有
// 门禁。这条测试直接读 workflow，确保两个 scope 都真的被调用，且浏览器用例排在
// verify 之后（单测/类型检查挂了不必再烧一个 runner）。
test('CI 里两个 scope 的守卫都被执行，浏览器用例排在 verify 之后', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');

  assert.match(workflow, /check-coverage-scope\.mjs --scope=services/);
  assert.match(workflow, /check-coverage-scope\.mjs --scope=components/);
  assert.match(workflow, /^  coverage-components:\r?$/m);
  assert.equal((workflow.match(/^    needs: verify\r?$/gm) ?? []).length, 2);
});

test('未知 scope 以退出码 2 拒绝并列出可用值', () => {
  const result = runGuard('--scope=not-a-scope');

  assert.equal(result.status, 2, `期望退出码 2，实际 ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /未知 scope「not-a-scope」/);
  assert.match(result.stderr, /services \| components/);
});

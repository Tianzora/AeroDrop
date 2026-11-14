import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

// 守卫脚本靠解析 node 的人类可读覆盖率报告工作，最容易静默失效的地方就是解析/
// 判定规则本身（上游换个行首标记、多一层缩进、加个色彩转义，都能让门禁变成摆设）。
// 这里只 spawn 不跑测试套件的那两条路径：--self-test 校验内联 fixture，未知 scope
// 校验参数错误，都能在毫秒内给退出码和消息。
const scriptPath = path.resolve('scripts/check-coverage-scope.mjs');

const runGuard = (...args: string[]) =>
  spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });

test('--self-test 校验解析与判定规则，并覆盖四条失败路径', () => {
  const result = runGuard('--self-test');

  assert.equal(result.status, 0, `self-test 失败：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /self-test passed/);
  assert.match(result.stdout, /fixture/);
  // fixture 里必须真的验证过「缺失文件 / 0% 行 / 行数不足 / 同名遮蔽」这四条失败路径，
  // 否则自测只是在证明「能解析一段我自己写的文本」。同名遮蔽是最后一条：报告行只给
  // 裸文件名时，两个不同目录的同名文件会互相顶替，行数校验拦不住。
  assert.match(result.stdout, /缺失文件、0% 行、行数不足、同名遮蔽四条失败路径/);
});

test('未知 scope 以退出码 2 拒绝并列出可用值', () => {
  const result = runGuard('--scope=not-a-scope');

  assert.equal(result.status, 2, `期望退出码 2，实际 ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /未知 scope「not-a-scope」/);
  assert.match(result.stderr, /services \| components/);
});

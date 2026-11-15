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
  // 数量写死：成功文案由 fixture 名字拼出来（不是另一句人写的总结），所以删掉任意一条
  // fixture 都会同时改变数量与名字。只断言「fixture 这个词出现过」等于允许自测被删空。
  assert.match(result.stdout, /19 个报告 fixture/);
  assert.match(result.stdout, /5 个白名单预算 fixture/);
  assert.match(result.stdout, /3 个理由 fixture/);
  assert.match(result.stdout, /10 个阈值政策 fixture/);
  // 逐条点名：这些失败路径必须各有一条 fixture 在证明它，删掉就该变红。
  for (const name of [
    '缺失文件会被点名',
    'line 覆盖率 0% 判失败',
    '报告行数不足判解析失效',
    '同名文件遮蔽（两个目录同名、报告只给裸名）必须失败',
    '范围外文件混进报告（exclude 失效）必须失败',
    'scope 内掉点会红（门槛只看 all files 汇总行）',
    '分组缩进的裸文件名必须按目录栈还原（同名文件在另一目录也存在）',
    '白名单条目属于别的 scope 必须失败',
  ]) {
    assert.ok(
      result.stdout.includes(name),
      `self-test 输出里没有「${name}」：对应的 fixture 被删了或被改名了，这条失败路径不再有人证`
    );
  }
  // 白名单预算与阈值政策也必须逐条出现在输出里：预算被放宽、门槛被改松都属于政策变更。
  for (const name of ['白名单在预算内可以通过', '被排除行数占比超上限，必须失败', '总行数算成 0 时占比预算必须失败']) {
    assert.ok(result.stdout.includes(name), `self-test 输出里没有「${name}」`);
  }
  for (const name of ['services 行门槛 85', 'components 白名单条目上限 3', 'components 白名单行占比上限 80%']) {
    assert.ok(result.stdout.includes(name), `self-test 输出里没有「${name}」：阈值政策 fixture 被改动了`);
  }
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

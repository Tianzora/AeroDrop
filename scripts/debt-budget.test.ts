// 结构债的机械上限：只许往下调，不许悄悄新增。
//
// 复评反复指出「结构债只有数字记录，没有解除路径」。数字写进文档会漂移，所以这里把
// 当轮的上限钉成测试：新增一处 `as any`、把某个千行组件再撑大、或者把覆盖白名单的
// 预算放宽，都必须先改这个文件——改的时候会被要求同时更新 docs 里的解除路径表。
//
// 上限只降不升：每完成一个阶段就下调一档，直到归零。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const readText = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8');

const trackedSources = (): string[] =>
  execFileSync('git', ['ls-files', 'services', 'src', 'components'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /\.(ts|tsx)$/.test(line))
    .filter((line) => !/\.test\.(ts|tsx)$/.test(line))
    .filter((line) => !line.endsWith('.d.ts'));

test('生产代码里的 as any 不得超过当轮上限，且分布必须与文档一致', () => {
  const LIMIT = 16;
  const files = trackedSources();
  const offenders = files
    .map((file) => ({ file, count: (readText(file).match(/\bas any\b/g) ?? []).length }))
    .filter((entry) => entry.count > 0);

  const total = offenders.reduce((sum, entry) => sum + entry.count, 0);
  assert.ok(
    total <= LIMIT,
    `as any 总数 ${total} 超过上限 ${LIMIT}：${offenders.map((entry) => `${entry.file}=${entry.count}`).join(', ')}`
  );

  // 分布写进注释也写进断言：真正要拆的是 ScreenShare（11 处），不是"随便哪两个组件"。
  const byFile = new Map(offenders.map((entry) => [entry.file, entry.count]));
  assert.equal(byFile.get('components/ScreenShare.tsx') ?? 0, 11, 'ScreenShare 的 as any 数量变了，需同步更新文档');
  assert.equal(byFile.get('components/Sender.tsx') ?? 0, 2, 'Sender 的 as any 数量变了，需同步更新文档');
});

test('千行组件的体量不得超过当轮上限（只降不升）', () => {
  const limits: [string, number][] = [
    ['components/Receiver.tsx', 3367],
    ['components/ScreenShare.tsx', 2900],
    ['components/Sender.tsx', 1670],
  ];
  for (const [file, limit] of limits) {
    // 与 `wc -l` 对齐：数换行符，末尾是否带换行不影响结果。
    const lines = (readText(file).match(/\n/g) ?? []).length;
    assert.ok(lines <= limit, `${file} 有 ${lines} 行，超过上限 ${limit}；拆分阶段完成后再上调这个测试`);
  }
});

test('覆盖率白名单预算不得被放宽', () => {
  const source = readText('scripts/check-coverage-scope.mjs');
  const components = source.slice(source.indexOf('components: {'));
  assert.match(components, /allowlistBudget: \{ maxEntries: 3, maxExcludedLineShare: 0\.8 \}/, '组件白名单预算被改动');
  const services = source.slice(source.indexOf('services: {'), source.indexOf('components: {'));
  assert.match(
    services,
    /allowlistBudget: \{ maxEntries: 2, maxExcludedLineShare: 0\.05 \}/,
    '服务白名单预算被改动'
  );
});

test('解除路径必须写在文档里，并与本文件的上限对应', () => {
  // 只匹配布尔结果：直接把整份文档塞进断言消息会淹没输出。
  const docs = readText('docs/design-scale-out.md');
  const missing = [
    ['结构债的解除路径', /结构债的解除路径/],
    ['阶段 1–4', /阶段 [1-4]/],
    ['as any 的终态 16 -> 0', /as any.{0,40}16.{0,40}0/],
    ['noUncheckedIndexedAccess 的起点 200', /noUncheckedIndexedAccess[^\n]*200/],
  ]
    .filter(([, pattern]) => !(pattern as RegExp).test(docs))
    .map(([label]) => label as string);

  assert.deepEqual(missing, [], `docs/design-scale-out.md 缺少解除路径要素：${missing.join(' / ')}`);
});

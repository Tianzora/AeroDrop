import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// 「本轮实测」这类数字已经连续三轮漂移，每次都是人手重算、手改文档。人算就会错，而
// 一条写错的「白名单只剩 472 行余量」会让 CI 里唯一的预警文本失效。这里把文档与 CI 注释
// 里的数字直接绑到 `check-coverage-scope.mjs --metrics` 的静态统计上（不跑测试套件，
// 所以这条测试是毫秒级）：文件数、例外数、白名单行数、总行数、占比、组件行数上限里的
// 「行数」都必须是算出来的，不是抄来的。
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
const lineCount = (file: string): number => read(file).split('\n').length - 1;

type ScopeMetrics = {
  scope: string;
  files: number;
  exceptions: number;
  reportedRows: number;
  excludedLines: number;
  totalLines: number;
  sharePercent: number;
};

const metricsFor = (scope: 'services' | 'components'): ScopeMetrics => {
  const result = spawnSync(
    process.execPath,
    ['./scripts/check-coverage-scope.mjs', '--metrics', `--scope=${scope}`],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `--metrics 失败：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as ScopeMetrics;
};

const serviceMetrics = metricsFor('services');
const componentMetrics = metricsFor('components');
const docs = read('docs/design-scale-out.md');
const workflow = read('.github/workflows/ci.yml');

/** 白名单位于 80% 上限以内还剩下多少行（向下取整，与文档里的「余量约 N 行」一致）。 */
const allowlistMargin = (metrics: ScopeMetrics, maxShare: number): number =>
  Math.floor(metrics.totalLines * maxShare) - metrics.excludedLines;

/**
 * 只取最新章节（§8.N 最大值）的正文。
 *
 * 「本轮实测」数字必须落在**最新**那一节里才算数：§8.17 之类是上一轮的快照，正文里
 * 至今仍写着同一个 119/117/2，所以在整份文档上 `includes()` 会被旧节救活——把最新节
 * 写错一个数字，测试照样全绿（第十七轮工程复评 MF1 就是这条）。因此这里按标题切段，
 * 与 `docs-current-pointer.test.ts` 的 `sectionBody` 保持同一套语义。
 */
const latestSectionBody = (markdown: string): { label: string; body: string } => {
  const headings = [...markdown.matchAll(/^#{2,4} 8\.(\d+) /gm)].map((match) => ({
    label: `8.${match[1]}`,
    level: (/^#+/.exec(match[0])?.[0] ?? '###').length,
    index: match.index ?? 0,
  }));
  assert.ok(headings.length > 0, 'docs/design-scale-out.md 里找不到任何 §8.N 小节');
  const latest = headings.reduce((left, right) => (Number(right.label.slice(2)) > Number(left.label.slice(2)) ? right : left));
  const lines = markdown.slice(latest.index).split('\n');
  const body: string[] = [];
  for (const line of lines) {
    if (body.length > 0 && new RegExp(`^#{1,${latest.level}} `).test(line)) break;
    body.push(line);
  }
  return { label: latest.label, body: body.join('\n') };
};

const latestDocs = latestSectionBody(docs);

test('设计文档的「本轮实测」数字必须等于守卫算出来的数字', () => {
  for (const metrics of [serviceMetrics, componentMetrics]) {
    const denominator = `${metrics.files} 文件 / ${metrics.reportedRows} 行 / ${metrics.exceptions} 例外`;
    assert.ok(
      latestDocs.body.includes(denominator),
      `docs/design-scale-out.md 的 §${latestDocs.label}（最新节）里没有「${denominator}」：${metrics.scope} scope 的\n` +
        '文件数/例外数变了，「本轮实测」必须跟着 --metrics 的输出走（手算已经错过三次）。\n' +
        '注意：只认最新一节——把旧的快照节改成正确值不算修好，因为下一轮它又会变成错的'
    );
    const budget = `预算 ${metrics.excludedLines}/${metrics.totalLines}（${metrics.sharePercent.toFixed(2)}%`;
    assert.ok(
      latestDocs.body.includes(budget),
      `docs/design-scale-out.md 的 §${latestDocs.label}（最新节）里没有「${budget}）：白名单预算数字与实际不符`
    );
  }
});

test('CI 注释里的白名单预算与余量必须等于守卫算出来的数字', () => {
  const budget = `${componentMetrics.excludedLines}/${componentMetrics.totalLines} 行 = ${componentMetrics.sharePercent.toFixed(2)}%`;
  assert.ok(workflow.includes(budget), `ci.yml 里没有「${budget}」：CI 的预警文本写错了就等于没有预警`);
  const margin = allowlistMargin(componentMetrics, 0.8);
  assert.ok(
    workflow.includes(`余量约 ${margin} 行`),
    `ci.yml 里的「余量约 N 行」应等于 ${margin}（totalLines × 80% − 白名单行数）：上限算错会让预警失效`
  );
  assert.ok(
    workflow.includes(`现在实测 ${componentMetrics.sharePercent.toFixed(2)}% ≤ 80% 上限`),
    'ci.yml 的 job 头注释必须写出当前实测占比'
  );
});

test('组件行数与文档/CI 里的数字一致', () => {
  const sizes = {
    'components/Receiver.tsx': lineCount('components/Receiver.tsx'),
    'components/ScreenShare.tsx': lineCount('components/ScreenShare.tsx'),
    'components/Sender.tsx': lineCount('components/Sender.tsx'),
  };
  for (const [file, lines] of Object.entries(sizes)) {
    assert.ok(
      latestDocs.body.includes(`\`${file}\`（${lines} 行）`),
      `docs/design-scale-out.md 的 §${latestDocs.label}（最新节）里的「${file}（${lines} 行）」与文件实际行数不符：行数是结构债规模的唯一口径`
    );
  }
  assert.ok(
    workflow.includes(`ScreenShare ${sizes['components/ScreenShare.tsx']} 行`),
    'ci.yml 的白名单注释必须写出 ScreenShare 的实际行数'
  );
});

test('最新章节里不得残留上一轮的旧数字', () => {
  // 只查最新章节：§8.4–§8.N-1 是各轮的**快照**，那里出现当时的旧数字是正确记录，
  // 不能要求它们跟着今天的值变（否则历史就没法读了）。
  const headings = [...docs.matchAll(/^### (8\.\d+) /gm)].map((match) => ({
    label: match[1],
    index: match.index ?? 0,
  }));
  assert.ok(headings.length > 0, 'docs/design-scale-out.md 里找不到任何 ### 8.N 小节');
  const latest = headings[headings.length - 1];
  const body = docs.slice(latest.index);
  for (const stale of ['152/17528', '7898/10464', 'ScreenShare 2861 行', '当前 89.22 / 75.37 / 79.61']) {
    assert.ok(!body.includes(stale), `最新章节 ${latest.label} 里仍残留旧数字「${stale}」：数字漂移就是这么开始的`);
  }
});
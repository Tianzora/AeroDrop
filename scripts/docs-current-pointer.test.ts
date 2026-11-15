// 「当前」指针不得悬空，历史快照不得被追溯覆盖。
//
// 复评连续三轮在文档上掉了分：横幅写「当前以 §8.13 为准」但 §8.13 是更早的快照、
// 表格里的「当前 65.30 / 70.43」在下一轮变成 65.43 / 71.43 之后没人改、§8.15 的
// 「本轮实测」被第十四轮的数字整段覆盖。这类漂移靠人眼审不出来，所以钉成测试：
//  1. 最新章节号（§8.N 的最大值）是唯一的「当前」；
//  2. 任何带「当前」并被当作指针（见/以/指向 §8.N）的句子都必须指向它；
//  3. 两个相邻章节的「本轮实测」块不得逐字相同（历史快照必须各记各的）；
//  4. ROADMAP 的最新阶段必须指向同一章节。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const readText = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8');

const designDoc = (): string => readText('docs/design-scale-out.md');

const sectionNumbers = (markdown: string): number[] =>
  [...markdown.matchAll(/^#{2,4} 8\.(\d+)/gm)].map((match) => Number(match[1]));

const latestSection = (markdown: string): number => {
  const numbers = sectionNumbers(markdown);
  assert.ok(numbers.length > 0, '设计文档里一个 §8.x 章节都没有');
  return Math.max(...numbers);
};

const sectionBody = (markdown: string, section: number): string => {
  const lines = markdown.split('\n');
  const startIndex = lines.findIndex((line) => new RegExp(`^#{2,4} 8\\.${section}\\b`).test(line));
  assert.notEqual(startIndex, -1, `设计文档缺少 §8.${section}`);
  const level = (/^#+/.exec(lines[startIndex] ?? '')?.[0] ?? '###').length;
  // 只切到「同级或更高级」的下一个标题：章节内部的 `####` 子标题不算章节结束，
  // 否则「本轮实测」块写在子标题之后就会被误判为缺失。
  const body: string[] = [];
  for (const line of lines.slice(startIndex)) {
    if (body.length > 0 && new RegExp(`^#{1,${level}} `).test(line)) break;
    body.push(line);
  }
  return body.join('\n');
};

test('横幅里的「当前」章节必须是最新章节', () => {
  const markdown = designDoc();
  const current = latestSection(markdown);
  const banner = markdown.split('\n').find((line) => line.includes('数字说明'));
  assert.ok(banner, '设计文档缺少「数字说明」横幅');
  const referenced = /以 §8\.(\d+) 末尾为准/.exec(banner ?? '');
  assert.ok(referenced, '横幅必须写明「当前实测一律以 §8.N 末尾为准」');
  assert.equal(
    Number(referenced?.[1]),
    current,
    `横幅指向 §8.${referenced?.[1]}，但最新章节是 §8.${current}`
  );
});

test('所有「当前」指针都必须指向最新章节，不得指向历史快照', () => {
  const markdown = designDoc();
  const current = latestSection(markdown);

  // 逐行记录「这一行属于哪一节」：只有两种指针是合法的——
  //   1. 指向最新章节（任何地方都可以这样写）；
  //   2. 在 §8.K 内部指向 §8.K 自己（那是在说「本节这次实测」）。
  // 早先的实现用「整行含『快照/历史/当时』就跳过」做豁免，第十七轮工程复评 MF2 证明它
  // 能被一行合法规避：「当前 89.11 / …，见 §8.15」所在行本来就带『第八轮快照』，于是
  // 把指针改回历史章节也不会红。现在改成按所属章节判定，豁免不再依赖字样。
  const dangling: string[] = [];
  let enclosing: number | null = null;
  markdown.split('\n').forEach((line, index) => {
    const heading = /^#{2,4} 8\.(\d+)\b/.exec(line);
    if (heading) enclosing = Number(heading[1]);
    if (!line.includes('当前')) return;
    // 引号里的字符串是「引用别人的话」，不是本行的指针（例如缺陷描述里引用了一句错的
    // 横幅文案「当前以 §8.13 为准」）。先剥掉成对引号再找指针。
    const scanned = line.replace(/「[^」]*」|『[^』]*』|“[^”]*”|`[^`]*`/g, '');
    for (const match of scanned.matchAll(/(?:见|以|指向)\s*§8\.(\d+)/g)) {
      const section = Number(match[1]);
      if (section === current) continue;
      if (enclosing !== null && section === enclosing) continue;
      dangling.push(`L${index + 1} → §8.${section}`);
    }
  });

  assert.deepEqual(
    dangling,
    [],
    `以下「当前」指针指向了非最新章节（最新是 §8.${current}）；只有指向本节自身的历史快照可以豁免`
  );
});

test('相邻两轮的「本轮实测」块不得逐字相同（历史快照不许被追溯覆盖）', () => {
  const markdown = designDoc();
  const current = latestSection(markdown);
  const previous = current - 1;
  const currentBlock = sectionBody(markdown, current).includes('本轮实测');
  const previousBlock = sectionBody(markdown, previous).includes('本轮实测');
  assert.ok(currentBlock, `§8.${current} 必须有自己的「本轮实测」块`);
  assert.ok(previousBlock, `§8.${previous} 的「本轮实测」块被删掉了`);
  assert.notEqual(
    sectionBody(markdown, current),
    sectionBody(markdown, previous),
    `§8.${previous} 与 §8.${current} 内容逐字相同，说明历史快照被覆盖了`
  );
});

test('ROADMAP 的最新阶段必须指向同一章节', () => {
  const markdown = designDoc();
  const current = latestSection(markdown);
  const roadmap = readText('docs/ROADMAP-next.md');
  const headings = [...roadmap.matchAll(/^## 阶段 (\d+)/gm)].map((match) => Number(match[1]));
  assert.ok(headings.length > 0, 'ROADMAP 里没有任何「## 阶段 N」');
  const latest = Math.max(...headings);
  const start = roadmap.search(new RegExp(`^## 阶段 ${latest}\\b`, 'm'));
  const body = roadmap.slice(start);
  const nextHeading = body.slice(1).search(/^## /m);
  const section = nextHeading === -1 ? body : body.slice(0, nextHeading + 1);
  assert.match(
    section,
    new RegExp(`§8\\.${current}\\b`),
    `ROADMAP 阶段 ${latest} 没有指向最新章节 §8.${current}`
  );
});

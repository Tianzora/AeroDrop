import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TransferProgressCard } from './TransferProgress.tsx';

const baseProps: React.ComponentProps<typeof TransferProgressCard> = {
  progress: 42,
  transferredBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
};

const render = (overrides: Partial<React.ComponentProps<typeof TransferProgressCard>> = {}) =>
  renderToStaticMarkup(React.createElement(TransferProgressCard, { ...baseProps, ...overrides }));

test('传输中：文件名、确定性进度条、速度与剩余时间', () => {
  const html = render({
    fileName: '1.wav',
    filePosition: '第 2 / 3 个文件',
    currentSpeedBytes: 2_100_000,
    averageSpeedBytes: 1_900_000,
    eta: '00:32',
  });

  assert.match(html, /1\.wav/);
  assert.match(html, /第 2 \/ 3 个文件/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="42"/);
  assert.match(html, /平均/);
  assert.match(html, /剩余 00:32/);
});

test('未完成时进度条使用品牌色，不出现完成勾选', () => {
  const html = render({ progress: 0, fileName: '1.wav' });

  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /bg-brand-500/);
  assert.doesNotMatch(html, /bg-emerald-500/);
});

test('完成态：满格、emerald 底、隐藏实时速度', () => {
  const html = render({
    progress: 100,
    transferredBytes: 4 * 1024 * 1024,
    fileName: '1.wav',
    currentSpeedBytes: 2_100_000,
    eta: '00:00',
  });

  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /bg-emerald-500/);
  assert.doesNotMatch(html, /剩余 00:00/);
});

test('不传速度时不渲染速度区', () => {
  const html = render({ fileName: '1.wav' });

  assert.doesNotMatch(html, /平均/);
  assert.doesNotMatch(html, /剩余/);
});

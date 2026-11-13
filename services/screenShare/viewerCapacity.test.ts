import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeViewerCapacity,
  resolveRecommendedViewerCount,
  shouldWarnViewerCapacity,
} from './viewerCapacity.ts';

test('建议人数由上行预算推导，并且不超过硬上限', () => {
  assert.equal(resolveRecommendedViewerCount(), 4);
  assert.equal(resolveRecommendedViewerCount(6), 4);
  // 硬上限比预算推导值更小时以硬上限为准。
  assert.equal(resolveRecommendedViewerCount(2), 2);
  // 异常输入不能变成 0 人或无限人。
  assert.equal(resolveRecommendedViewerCount(Number.NaN), 4);
  assert.equal(resolveRecommendedViewerCount(-3), 1);
});

test('容量描述同时给出建议值与硬上限', () => {
  assert.deepEqual(describeViewerCapacity(), { max: 6, recommended: 4 });
  assert.deepEqual(describeViewerCapacity(10), { max: 10, recommended: 4 });
});

test('只有超过建议人数才提示，超过硬上限由 share-full 拒绝', () => {
  assert.equal(shouldWarnViewerCapacity(3, 4), false);
  assert.equal(shouldWarnViewerCapacity(4, 4), false);
  assert.equal(shouldWarnViewerCapacity(5, 4), true);
  assert.equal(shouldWarnViewerCapacity(6, 4), true);
  assert.equal(shouldWarnViewerCapacity(Number.NaN, 4), false);
});

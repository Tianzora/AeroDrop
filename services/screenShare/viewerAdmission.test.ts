import assert from 'node:assert/strict';
import { canAdmitViewer } from './viewerAdmission.ts';

// 空场可以接纳
assert.equal(canAdmitViewer({ activeViewers: 0, pendingViewers: 0, maxViewers: 6 }), true);
// 已有 5 人 + 1 人正在 answer → 名额已满，不能再接纳（并发超员的根因）
assert.equal(canAdmitViewer({ activeViewers: 5, pendingViewers: 1, maxViewers: 6 }), false);
// 只有 pending 也算占用名额
assert.equal(canAdmitViewer({ activeViewers: 0, pendingViewers: 6, maxViewers: 6 }), false);
// 未达上限仍可接纳
assert.equal(canAdmitViewer({ activeViewers: 3, pendingViewers: 2, maxViewers: 6 }), true);
// 异常输入按 0 处理，不能因为 NaN 把名额算成可用或永久占满
assert.equal(canAdmitViewer({ activeViewers: Number.NaN, pendingViewers: 0, maxViewers: 6 }), true);
assert.equal(canAdmitViewer({ activeViewers: -3, pendingViewers: 0, maxViewers: 6 }), true);
console.log('viewerAdmission tests passed');

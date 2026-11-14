import test from 'node:test';
import assert from 'node:assert/strict';

import { planViewerErrorSurface } from './viewerErrorSurface.ts';

test('画面还在放时的信令错误不落红条：观众看得见画面，红条只会自相矛盾', () => {
  assert.equal(
    planViewerErrorSurface({ hasMediaConnection: true, mediaHealthy: true }),
    'suppress'
  );
});

test('媒体连接断了就落终态：这时候用户确实看不了', () => {
  assert.equal(
    planViewerErrorSurface({ hasMediaConnection: true, mediaHealthy: false }),
    'surface'
  );
});

test('还没拿到 call 的信令错误照常显示：否则用户看不到任何反馈', () => {
  assert.equal(
    planViewerErrorSurface({ hasMediaConnection: false, mediaHealthy: false }),
    'surface'
  );
});

test('只有后者为真的组合不会误吞：没有媒体连接时健康与否无意义', () => {
  assert.equal(
    planViewerErrorSurface({ hasMediaConnection: false, mediaHealthy: true }),
    'surface'
  );
});

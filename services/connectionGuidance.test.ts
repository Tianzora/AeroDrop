import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPeerRuntimeErrorMessage,
  SIGNALING_MESSAGE_TOO_LARGE_MESSAGE,
  SIGNALING_UNREACHABLE_MESSAGE,
} from './connectionGuidance.ts';

test('信令错误文案区分「连不上」「消息超限」「被占用」，不再泄漏英文技术标识', () => {
  assert.equal(getPeerRuntimeErrorMessage('disconnected'), SIGNALING_UNREACHABLE_MESSAGE);
  assert.equal(getPeerRuntimeErrorMessage('rate-limited'), '连接请求过多，请稍后再试');
  assert.equal(
    getPeerRuntimeErrorMessage('message-too-large'),
    SIGNALING_MESSAGE_TOO_LARGE_MESSAGE,
  );
  assert.equal(getPeerRuntimeErrorMessage('unavailable-id'), '该口令已被占用，请换一个');
  assert.equal(getPeerRuntimeErrorMessage('unauthorized'), '口令或凭证已失效，请让发送端重新分享');
  assert.equal(getPeerRuntimeErrorMessage('invalid-id'), '口令无效，请确认后重试');
  assert.equal(getPeerRuntimeErrorMessage('something-new'), '连接错误: something-new');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMediaConnectionErrorMessage,
  getPeerRuntimeErrorMessage,
  getShareFullMessage,
  ICE_CONNECTION_FAILED_MESSAGE,
  SIGNALING_MESSAGE_TOO_LARGE_MESSAGE,
  SIGNALING_UNREACHABLE_MESSAGE,
  UNKNOWN_CONNECTION_ERROR_MESSAGE,
} from './connectionGuidance.ts';

test('信令错误文案区分「连不上」「消息超限」「被占用」，不再泄漏英文技术标识', () => {
  assert.equal(getPeerRuntimeErrorMessage('disconnected'), SIGNALING_UNREACHABLE_MESSAGE);
  assert.equal(getPeerRuntimeErrorMessage('rate-limited'), '连接请求过多，请稍后再试');
  assert.equal(
    getPeerRuntimeErrorMessage('message-too-large'),
    SIGNALING_MESSAGE_TOO_LARGE_MESSAGE,
  );
  assert.equal(getPeerRuntimeErrorMessage('unavailable-id'), '该口令已被占用，请换一个');
  assert.equal(
    getPeerRuntimeErrorMessage('session-conflict'),
    '分享会话已被其他连接占用，请重新开始共享',
  );
  assert.equal(getPeerRuntimeErrorMessage('unauthorized'), '口令或凭证已失效，请让发送端重新分享');
  assert.equal(getPeerRuntimeErrorMessage('invalid-id'), '口令无效，请确认后重试');
});

test('未知类型不再直出技术标识，ICE/媒体失败有单独文案', () => {
  assert.equal(getPeerRuntimeErrorMessage('something-new'), UNKNOWN_CONNECTION_ERROR_MESSAGE);
  assert.doesNotMatch(getPeerRuntimeErrorMessage('something-new'), /something-new/);
  assert.equal(getPeerRuntimeErrorMessage('webrtc-error'), ICE_CONNECTION_FAILED_MESSAGE);
  assert.equal(getPeerRuntimeErrorMessage('ice-failed'), ICE_CONNECTION_FAILED_MESSAGE);
  assert.equal(
    getPeerRuntimeErrorMessage('peer-unavailable'),
    '找不到该分享者，请确认分享链接是否仍然有效',
  );
  assert.equal(getPeerRuntimeErrorMessage('server-error'), '信令服务器暂时不可用，请稍后重试');
  assert.equal(getPeerRuntimeErrorMessage('socket-error'), '信令连接异常，请检查网络后重试');
});

test('媒体连接错误按 type 优先，type 缺失时用 ICE 关键词兜底', () => {
  assert.equal(
    getMediaConnectionErrorMessage({ type: 'peer-unavailable' }),
    '找不到该分享者，请确认分享链接是否仍然有效',
  );
  assert.equal(
    getMediaConnectionErrorMessage({ type: 'webrtc-error', message: 'Ice connection failed.' }),
    ICE_CONNECTION_FAILED_MESSAGE,
  );
  assert.equal(
    getMediaConnectionErrorMessage({ message: 'ICE failed while connecting' }),
    ICE_CONNECTION_FAILED_MESSAGE,
  );
  assert.equal(getMediaConnectionErrorMessage({ message: 'closed' }), UNKNOWN_CONNECTION_ERROR_MESSAGE);
  assert.equal(getMediaConnectionErrorMessage(null), UNKNOWN_CONNECTION_ERROR_MESSAGE);
});

test('人数上限文案是容量拒绝，不暗示网络故障', () => {
  const message = getShareFullMessage(6);
  assert.match(message, /6 人/);
  assert.match(message, /稍后再试/);
  assert.doesNotMatch(message, /网络|连接错误/i);
});

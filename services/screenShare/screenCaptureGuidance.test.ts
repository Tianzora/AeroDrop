import test from 'node:test';
import assert from 'node:assert/strict';

import { describeScreenCaptureFailure } from './screenCaptureGuidance.ts';

const ENV = { embedded: false, userActivation: true };

const error = (name: string, message: string) => Object.assign(new Error(message), { name });

test('浏览器的英文 message 不会拼进中文提示：用户看到的必须是一句完整中文', () => {
  const cases = [
    error('NotAllowedError', 'Permission denied by system'),
    error('NotReadableError', 'Could not start video source'),
    error('NotFoundError', 'Requested device not found'),
    error('NotSupportedError', 'Not supported'),
    error('SecurityError', 'The request is not allowed'),
    error('AbortError', 'The user aborted a request'),
  ];

  for (const failure of cases) {
    const result = describeScreenCaptureFailure(failure, ENV);
    assert.doesNotMatch(result.description, /[A-Za-z]{4,}/, `${failure.name} 的说明里混进了英文：${result.description}`);
    assert.equal(result.name, failure.name, '原始 name 仍要带出去供日志定位');
  }
});

test('NotAllowedError 的三种成因对应三条可行动的提示', () => {
  const permissionDenied = describeScreenCaptureFailure(error('NotAllowedError', 'Permission denied'), ENV);
  assert.equal(permissionDenied.isCancel, true, '"Permission denied" 且用户手势存在时视为用户取消');

  const embedded = describeScreenCaptureFailure(error('NotAllowedError', 'Permission denied'), {
    embedded: true,
    userActivation: true,
  });
  assert.equal(embedded.isCancel, false, '嵌在 iframe 里被拒不是用户取消');
  assert.match(embedded.description, /新标签页/);

  const noGesture = describeScreenCaptureFailure(error('NotAllowedError', 'Permission denied'), {
    embedded: false,
    userActivation: false,
  });
  assert.equal(noGesture.isCancel, false);
  assert.match(noGesture.description, /手动点击/);
});

test('未知失败给一句可行动的中文兜底，而不是把原始错误直出', () => {
  const result = describeScreenCaptureFailure(new Error('boom'), ENV);

  assert.equal(result.isCancel, false);
  assert.doesNotMatch(result.description, /boom/);
  assert.match(result.description, /屏幕录制权限/);
});

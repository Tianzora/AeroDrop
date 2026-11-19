import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VOICE_VOLUME_DEFAULT,
  clampVolume,
  canJoinVoice,
  describeMicrophoneError,
  describeVoiceStatus,
  volumeToGain,
} from './voiceCore.ts';

test('clampVolume 收敛到 0–200 且非法值回到默认', () => {
  assert.equal(clampVolume(-20), 0);
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(75), 75);
  assert.equal(clampVolume(200), 200);
  assert.equal(clampVolume(400), 200);
  assert.equal(clampVolume(Number.NaN), VOICE_VOLUME_DEFAULT);
});

test('volumeToGain 把百分比音量换成 0–2 增益', () => {
  assert.equal(volumeToGain(0), 0);
  assert.equal(volumeToGain(100), 1);
  assert.equal(volumeToGain(200), 2);
});

test('canJoinVoice 需要连接且尚未加入', () => {
  assert.equal(canJoinVoice(false, false), false);
  assert.equal(canJoinVoice(true, true), false);
  assert.equal(canJoinVoice(true, false), true);
});

test('describeVoiceStatus 区分未加入、静音与通话中', () => {
  assert.match(describeVoiceStatus({ joined: false, muted: false, remoteMemberCount: 0, error: null }), /未加入/);
  assert.match(describeVoiceStatus({ joined: true, muted: true, remoteMemberCount: 2, error: null }), /已静音.*2 位/);
  assert.match(describeVoiceStatus({ joined: true, muted: false, remoteMemberCount: 1, error: null }), /麦克风已开启.*1 位/);
  assert.match(describeVoiceStatus({ joined: true, muted: false, remoteMemberCount: 0, error: 'x' }), /语音不可用/);
});

test('describeMicrophoneError 对权限/设备错误给出易懂文案', () => {
  assert.match(describeMicrophoneError(new DOMException('denied', 'NotAllowedError')), /权限被拒绝/);
  assert.match(describeMicrophoneError(new DOMException('missing', 'NotFoundError')), /没有检测到可用麦克风/);
  assert.match(describeMicrophoneError(new Error('boom')), /boom/);
});

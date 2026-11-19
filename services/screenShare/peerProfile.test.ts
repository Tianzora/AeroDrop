import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_AVATAR } from '../profile/localProfile.ts';
import {
  PEER_PROFILE_MESSAGE_TYPE,
  createPeerProfileMessage,
  isPeerProfileMessage,
  sanitizePeerProfile,
} from './peerProfile.ts';

test('身份帧类型固定为 peer-profile，和聊天/共享控制帧区分开', () => {
  assert.equal(PEER_PROFILE_MESSAGE_TYPE, 'peer-profile');
});

test('isPeerProfileMessage 只认带 name/avatar 的 peer-profile 对象', () => {
  assert.equal(isPeerProfileMessage({ type: 'peer-profile', name: '阿狸', avatar: '🦊' }), true);
  assert.equal(isPeerProfileMessage({ type: 'peer-profile', name: '阿狸' }), false);
  assert.equal(isPeerProfileMessage({ type: 'share-state', activeSharerId: null }), false);
  assert.equal(isPeerProfileMessage('peer-profile'), false);
  assert.equal(isPeerProfileMessage(null), false);
});

test('sanitizePeerProfile 清掉空名字与非法头像', () => {
  assert.deepEqual(sanitizePeerProfile({ type: 'peer-profile', name: '  阿狸 ', avatar: '🦊' }), {
    name: '阿狸',
    avatar: '🦊',
  });
  assert.equal(sanitizePeerProfile({ type: 'peer-profile', name: '   ', avatar: '🦊' }), null);
  assert.deepEqual(sanitizePeerProfile({ type: 'peer-profile', name: '阿狸', avatar: 'bad' }), {
    name: '阿狸',
    avatar: DEFAULT_AVATAR,
  });
  assert.equal(sanitizePeerProfile({ type: 'nope' }), null);
});

test('createPeerProfileMessage 发送前也做一次规整', () => {
  assert.deepEqual(createPeerProfileMessage({ name: '  阿狸  ', avatar: '🐼' }), {
    type: 'peer-profile',
    name: '阿狸',
    avatar: '🐼',
  });
  assert.deepEqual(createPeerProfileMessage({ name: '   ', avatar: 'bad' }), {
    type: 'peer-profile',
    name: '访客',
    avatar: DEFAULT_AVATAR,
  });
});
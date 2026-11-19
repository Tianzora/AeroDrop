import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_AVATAR } from '../profile/localProfile.ts';
import {
  PEER_PROFILE_LIST_MESSAGE_TYPE,
  PEER_PROFILE_LIST_MAX_ENTRIES,
  PEER_PROFILE_LIST_MAX_KEY_LENGTH,
  PEER_PROFILE_MESSAGE_TYPE,
  createPeerProfileListMessage,
  createPeerProfileMessage,
  isPeerProfileListMessage,
  isPeerProfileMessage,
  mergePeerProfile,
  removePeerProfile,
  sanitizePeerProfile,
  sanitizePeerProfileMap,
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
test('成员映射帧类型为 peer-profile-list，和单帧 peer-profile 区分开', () => {
  assert.equal(PEER_PROFILE_LIST_MESSAGE_TYPE, 'peer-profile-list');
  assert.equal(isPeerProfileListMessage({ type: 'peer-profile-list', profiles: {} }), true);
  assert.equal(isPeerProfileListMessage({ type: 'peer-profile', name: '阿狸', avatar: '🦊' }), false);
  assert.equal(isPeerProfileListMessage({ type: 'peer-profile-list', profiles: [] }), false);
  assert.equal(isPeerProfileListMessage({ type: 'peer-profile-list' }), false);
  assert.equal(isPeerProfileListMessage(null), false);
});

test('sanitizePeerProfileMap 逐项清洗，丢弃空键/空名/非对象条目', () => {
  const map = sanitizePeerProfileMap({
    type: 'peer-profile-list',
    profiles: {
      'peer-a': { name: '  阿狸 ', avatar: '🦊' },
      'peer-b': { name: '阿呆', avatar: 'bad' },
      'peer-c': { name: '   ', avatar: '🐼' },
      'peer-d': 'nope',
      '': { name: '无键', avatar: '🐼' },
    },
  });
  assert.deepEqual(map, {
    'peer-a': { name: '阿狸', avatar: '🦊' },
    'peer-b': { name: '阿呆', avatar: DEFAULT_AVATAR },
  });
  assert.deepEqual(sanitizePeerProfileMap({ type: 'nope' }), {});
});

test('createPeerProfileListMessage 发送前清洗整个映射', () => {
  const message = createPeerProfileListMessage({
    'peer-a': { name: '  阿狸  ', avatar: '🐼' },
    'peer-b': { name: '', avatar: '🐼' },
  });
  assert.equal(message.type, 'peer-profile-list');
  assert.deepEqual(message.profiles, { 'peer-a': { name: '阿狸', avatar: '🐼' } });
});

test('成员映射有条目数与键长上限，超限条目直接丢弃', () => {
  const profiles: Record<string, { name: string; avatar: string }> = {};
  for (let i = 0; i < PEER_PROFILE_LIST_MAX_ENTRIES + 3; i += 1) {
    profiles[`peer-${i}`] = { name: `成员${i}`, avatar: '🐼' };
  }
  const map = sanitizePeerProfileMap({ type: 'peer-profile-list', profiles });
  assert.equal(Object.keys(map).length, PEER_PROFILE_LIST_MAX_ENTRIES);

  const longKey = 'p'.repeat(PEER_PROFILE_LIST_MAX_KEY_LENGTH + 1);
  assert.deepEqual(
    sanitizePeerProfileMap({
      type: 'peer-profile-list',
      profiles: { [longKey]: { name: '超长键', avatar: '🐼' } },
    }),
    {}
  );
});

test('mergePeerProfile / removePeerProfile 都返回新映射，不修改入参', () => {
  const base = { 'peer-a': { name: '阿狸', avatar: '🦊' } };
  const merged = mergePeerProfile(base, 'peer-b', { name: '阿呆', avatar: '🐼' });
  assert.deepEqual(base, { 'peer-a': { name: '阿狸', avatar: '🦊' } });
  assert.deepEqual(merged, {
    'peer-a': { name: '阿狸', avatar: '🦊' },
    'peer-b': { name: '阿呆', avatar: '🐼' },
  });

  const removed = removePeerProfile(merged, 'peer-a');
  assert.deepEqual(merged, {
    'peer-a': { name: '阿狸', avatar: '🦊' },
    'peer-b': { name: '阿呆', avatar: '🐼' },
  });
  assert.deepEqual(removed, { 'peer-b': { name: '阿呆', avatar: '🐼' } });
});

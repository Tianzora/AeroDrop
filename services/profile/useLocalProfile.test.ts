import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_AVATAR } from './localProfile.ts';
import {
  __resetLocalProfileCacheForTests,
  getLocalProfileSnapshot,
  setLocalProfile,
  useLocalProfile,
} from './useLocalProfile.ts';

test('未设置身份时快照是「访客-四位数字」，且引用稳定', () => {
  __resetLocalProfileCacheForTests();
  const first = getLocalProfileSnapshot();
  assert.match(first.name, /^访客-\d{4}$/);
  assert.equal(first.avatar, DEFAULT_AVATAR);
  assert.equal(getLocalProfileSnapshot(), first);
});

test('setLocalProfile 规整昵称与头像，并写回快照', () => {
  __resetLocalProfileCacheForTests();
  const saved = setLocalProfile({ name: '  小明  ', avatar: '🦊' });
  assert.deepEqual(saved, { name: '小明', avatar: '🦊' });
  assert.equal(getLocalProfileSnapshot().name, '小明');
});

test('非法头像回退默认头像，空昵称回退访客名', () => {
  __resetLocalProfileCacheForTests();
  setLocalProfile({ name: '   ', avatar: '不存在的头像' });
  const snapshot = getLocalProfileSnapshot();
  assert.equal(snapshot.avatar, DEFAULT_AVATAR);
  assert.match(snapshot.name, /^访客-\d{4}$/);
});

test('useLocalProfile 暴露成对的身份与设置函数', () => {
  assert.equal(typeof useLocalProfile, 'function');
});
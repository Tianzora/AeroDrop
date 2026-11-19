import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AVATAR,
  LOCAL_PROFILE_STORAGE_KEY,
  PROFILE_AVATARS,
  PROFILE_NAME_MAX_LENGTH,
  createGuestName,
  isProfileAvatar,
  normalizeProfile,
  sanitizeProfileName,
} from './localProfile.ts';

test('存储键与原型一致，改键等于丢掉用户已有身份', () => {
  assert.equal(LOCAL_PROFILE_STORAGE_KEY, 'aerodrop.profile.v2');
});

test('预设头像 12 个，默认取第一个', () => {
  assert.equal(PROFILE_AVATARS.length, 12);
  assert.equal(DEFAULT_AVATAR, PROFILE_AVATARS[0]);
});

test('createGuestName 生成「访客-」加四位数字', () => {
  assert.equal(createGuestName(() => 0), '访客-0000');
  assert.equal(createGuestName(() => 0.9999), '访客-9999');
});

test('isProfileAvatar 只认预设头像', () => {
  assert.equal(isProfileAvatar('🐟'), true);
  assert.equal(isProfileAvatar('😀'), false);
  assert.equal(isProfileAvatar(1), false);
});

test('sanitizeProfileName 去空白、截到 16 字、空串回退', () => {
  assert.equal(sanitizeProfileName('  小明  ', 'x'), '小明');
  assert.equal(sanitizeProfileName('a'.repeat(20), 'x'), 'a'.repeat(PROFILE_NAME_MAX_LENGTH));
  assert.equal(sanitizeProfileName('   ', '访客-0001'), '访客-0001');
  assert.equal(sanitizeProfileName(42, 'f'), 'f');
});

test('normalizeProfile 容忍脏数据并回退访客名/默认头像', () => {
  assert.deepEqual(normalizeProfile({ name: ' 阿狸 ', avatar: '🦊' }, '访客-0000'), {
    name: '阿狸',
    avatar: '🦊',
  });
  assert.deepEqual(normalizeProfile({ name: '', avatar: 'bad' }, '访客-0000'), {
    name: '访客-0000',
    avatar: DEFAULT_AVATAR,
  });
  assert.deepEqual(normalizeProfile(null, '访客-0000'), {
    name: '访客-0000',
    avatar: DEFAULT_AVATAR,
  });
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReceiverRouteSessionId,
  getOrCreateReceiverRouteSessionId,
  rotateReceiverRouteSessionId,
} from './receiverRouteSessionId.ts';

const createFakeStorage = (seed: Record<string, string> = {}) => {
  const values = new Map(Object.entries(seed));
  return {
    storageKey: 'receiver-route-session',
    values,
    read: (key: string) => values.get(key) ?? null,
    write: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

test('getOrCreateReceiverRouteSessionId：已有会话直接复用，不再生成', () => {
  const storage = createFakeStorage({ 'receiver-route-session': 'rcv-existing' });
  assert.equal(getOrCreateReceiverRouteSessionId(storage), 'rcv-existing');
  assert.equal(storage.values.size, 1);
});

test('getOrCreateReceiverRouteSessionId：没有会话时生成并持久化一次', () => {
  const storage = createFakeStorage();
  const created = getOrCreateReceiverRouteSessionId({ ...storage, createId: () => 'rcv-new' });
  assert.equal(created, 'rcv-new');
  assert.equal(storage.values.get('receiver-route-session'), 'rcv-new');

  const again = getOrCreateReceiverRouteSessionId({ ...storage, createId: () => 'rcv-should-not-use' });
  assert.equal(again, 'rcv-new', '第二次进入必须复用已写入的会话');
});

test('rotateReceiverRouteSessionId：总是替换并返回新值', () => {
  const storage = createFakeStorage({ 'receiver-route-session': 'rcv-old' });
  const rotated = rotateReceiverRouteSessionId({ ...storage, createId: () => 'rcv-rotated' });
  assert.equal(rotated, 'rcv-rotated');
  assert.equal(storage.values.get('receiver-route-session'), 'rcv-rotated');
});

test('createReceiverRouteSessionId：格式稳定且两次生成不相同', () => {
  const first = createReceiverRouteSessionId();
  const second = createReceiverRouteSessionId();
  assert.match(first, /^rcv-[0-9a-z]+-[0-9a-z]{8}$/);
  assert.notEqual(first, second);
});

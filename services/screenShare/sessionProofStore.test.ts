import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forgetSessionProof,
  recallSessionProof,
  rememberSessionProof,
  type ProofStorage,
} from './sessionProofStore.ts';

const createStorage = (): ProofStorage & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
};

test('proof 按房号的 peerId 存取：重建 peer 时能把轮换凭证接回来', () => {
  const storage = createStorage();

  assert.equal(rememberSessionProof('AERO-1', 'proof-1', storage), true);
  assert.equal(recallSessionProof('AERO-1', storage), 'proof-1');
  // 别的房号不能读到：跨房号复用 proof 会被服务端当成会话冲突。
  assert.equal(recallSessionProof('AERO-2', storage), null);
});

test('新的 proof 覆盖旧的：只认最近一次服务端下发的那一个', () => {
  const storage = createStorage();

  rememberSessionProof('AERO-1', 'proof-1', storage);
  rememberSessionProof('AERO-1', 'proof-2', storage);

  assert.equal(recallSessionProof('AERO-1', storage), 'proof-2');
});

test('停止分享/终态要清掉 proof：撤销的房号不该留着一份还能用的凭证', () => {
  const storage = createStorage();
  rememberSessionProof('AERO-1', 'proof-1', storage);

  forgetSessionProof('AERO-1', storage);

  assert.equal(recallSessionProof('AERO-1', storage), null);
  assert.equal(storage.entries.size, 0);
});

test('没有 sessionStorage（隐私模式/被策略禁用）也不影响共享本身', () => {
  assert.equal(rememberSessionProof('AERO-1', 'proof-1', null), false);
  assert.equal(recallSessionProof('AERO-1', null), null);
  assert.doesNotThrow(() => forgetSessionProof('AERO-1', null));
});

test('存储抛错被吞掉：写不进 proof 只会退化成旧行为，不能让初始化直接失败', () => {
  const throwing: ProofStorage = {
    getItem: () => { throw new Error('quota'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('quota'); },
  };

  assert.equal(rememberSessionProof('AERO-1', 'proof-1', throwing), false);
  assert.equal(recallSessionProof('AERO-1', throwing), null);
  assert.doesNotThrow(() => forgetSessionProof('AERO-1', throwing));
});

test('空 proof 不落盘：空串会让 WS URL 带上一个无意义参数', () => {
  const storage = createStorage();

  assert.equal(rememberSessionProof('AERO-1', '', storage), false);
  assert.equal(storage.entries.size, 0);
});

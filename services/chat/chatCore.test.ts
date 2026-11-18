import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_CONFIG } from '../../constants/chat.ts';
import {
  ChatHistory,
  ChatSession,
  SlidingWindowRateLimiter,
  formatChatTranscript,
  measureChatMessageBytes,
  normalizeChatMessage,
} from './chatCore.ts';

const big = { rateLimitMaxMessages: 100000, rateLimitWindowMs: 10_000_000 };

test('chat constants expose the agreed boundaries', () => {
  assert.equal(CHAT_CONFIG.MAX_MESSAGE_BYTES, 2048);
  assert.equal(CHAT_CONFIG.RING_BUFFER_CAPACITY, 1000);
  assert.equal(CHAT_CONFIG.CHANNEL_LABEL, 'aero-room');
});

test('ring buffer truncates to 1000, dropping the oldest first', () => {
  const session = new ChatSession({ ...big, now: () => 1 });
  for (let i = 0; i < 1005; i += 1) {
    const accepted = session.receive({ id: `m${i}`, fromPeerId: 'p', ts: 1, text: 'x' });
    assert.ok(accepted, `message ${i} should be accepted`);
  }
  const messages = session.getMessages();
  assert.equal(messages.length, 1000);
  assert.equal(messages[0].id, 'm5');
  assert.equal(messages[messages.length - 1].id, 'm1004');
});

test('duplicate ids are deduplicated and do not grow the buffer', () => {
  const session = new ChatSession({ ...big, now: () => 1 });
  assert.ok(session.receive({ id: 'dup', fromPeerId: 'p', ts: 1, text: 'hello' }));
  assert.equal(session.receive({ id: 'dup', fromPeerId: 'p', ts: 1, text: 'hello again' }), null);
  assert.equal(session.getMessages().length, 1);
  assert.equal(session.getMessages()[0].text, 'hello');
});

test('per-peer rate limit blocks flooding but leaves other peers unaffected', () => {
  let clock = 0;
  const session = new ChatSession({ rateLimitMaxMessages: 3, rateLimitWindowMs: 10_000, now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    assert.ok(session.receive({ id: `a${i}`, fromPeerId: 'peerA', ts: 1, text: 'x' }), `a${i} allowed`);
  }
  assert.equal(session.receive({ id: 'a3', fromPeerId: 'peerA', ts: 1, text: 'x' }), null, '4th blocked');
  assert.ok(session.receive({ id: 'b0', fromPeerId: 'peerB', ts: 1, text: 'x' }), 'peerB still allowed');
  clock = 10_001;
  assert.ok(session.receive({ id: 'a4', fromPeerId: 'peerA', ts: 1, text: 'x' }), 'window slid forward');
});

test('oversize messages are dropped on receive and compose', () => {
  let n = 0;
  const session = new ChatSession({
    ...big,
    maxMessageBytes: 200,
    maxTextLength: 5000,
    localPeerId: 'me',
    createId: () => `id-${n++}`,
    now: () => 1,
  });
  const longText = 'a'.repeat(400);
  assert.equal(session.receive({ id: 'big', fromPeerId: 'p', ts: 1, text: longText }), null);
  assert.equal(session.getMessages().length, 0, 'oversize receive not buffered');
  assert.equal(session.compose(longText), null, 'oversize compose rejected');
  assert.equal(session.getMessages().length, 0, 'oversize compose not buffered');
});

test('malformed frames are dropped without throwing', () => {
  const session = new ChatSession({ ...big, now: () => 1 });
  assert.equal(session.receive('not json'), null);
  assert.equal(session.receive('{"id":'), null);
  assert.equal(session.receive(null), null);
  assert.equal(session.receive({}), null);
  assert.equal(session.receive({ id: '', fromPeerId: 'p', ts: 1, text: 'x' }), null);
  assert.equal(session.receive({ id: 'x', fromPeerId: 'p', ts: 'nope', text: 'x' }), null);
  assert.equal(session.receive({ id: 'x', fromPeerId: 'p', ts: 1, text: '' }), null);
  assert.equal(session.getMessages().length, 0);
});

test('export transcript renders one line per message: time sender text', () => {
  const history = new ChatHistory(10);
  history.add({ id: '1', fromPeerId: 'me', ts: 1000, text: 'hello' });
  history.add({ id: '2', fromPeerId: 'peerA', ts: 2000, text: 'hi there' });
  const text = formatChatTranscript(history.toArray(), (ts) => `@${ts}`);
  assert.equal(text, '@1000 me: hello\n@2000 peerA: hi there\n');
  assert.equal(formatChatTranscript([], (ts) => `@${ts}`), '');
});

test('session exports what it buffered through compose and receive', () => {
  let n = 0;
  const session = new ChatSession({
    ...big,
    localPeerId: 'me',
    createId: () => `id-${n++}`,
    now: () => 1000,
  });
  const sent = session.compose('first');
  assert.ok(sent);
  assert.ok(session.receive({ id: 'r1', fromPeerId: 'peerA', ts: 2000, text: 'second' }));
  const exported = session.exportTranscript((ts) => `@${ts}`);
  assert.equal(exported, '@1000 me: first\n@2000 peerA: second\n');
});

test('compose rejects empty/whitespace text', () => {
  const session = new ChatSession({ ...big, localPeerId: 'me', now: () => 1 });
  assert.equal(session.compose(''), null);
  assert.equal(session.compose('   '), null);
  assert.equal(session.getMessages().length, 0);
});

test('normalizeChatMessage and byte measurement agree on shape', () => {
  const normalized = normalizeChatMessage({ id: 'i', fromPeerId: 'p', ts: 5, text: 'ok' });
  assert.deepEqual(normalized, { id: 'i', fromPeerId: 'p', ts: 5, text: 'ok' });
  assert.ok(measureChatMessageBytes(normalized!) > 0);
});

test('SlidingWindowRateLimiter resets and forgets', () => {
  const limiter = new SlidingWindowRateLimiter(2, 1000);
  assert.ok(limiter.allow('p', 10));
  assert.ok(limiter.allow('p', 20));
  assert.equal(limiter.allow('p', 30), false);
  limiter.forget('p', 30);
  assert.ok(limiter.allow('p', 30));
  limiter.reset('p');
  assert.ok(limiter.allow('p', 40));
});
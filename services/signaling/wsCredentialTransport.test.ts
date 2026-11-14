import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WS_BASE_PROTOCOL,
  WS_CREDENTIAL_PROTOCOL_PREFIX,
  decodeWsCredentials,
  encodeWsCredentials,
  parseWsProtocols,
  pickAcceptedProtocol,
} from './wsCredentialTransport.ts';

// 测试侧只用来「构造坏输入」，实现里不允许走 Node 的 Buffer。
const base64url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

const credentialProtocols = (credentials: Parameters<typeof encodeWsCredentials>[0]): string[] => {
  const { protocol, baseProtocol } = encodeWsCredentials(credentials);
  return parseWsProtocols(`${baseProtocol}, ${protocol}`);
};

test('凭证往返：四个秘密字段原样还原，且不再出现在 URL 里', () => {
  const credentials = {
    code: '483920',
    token: 'f'.repeat(64),
    sessionSecretHash: 'a'.repeat(64),
    sessionProof: 'b'.repeat(64),
  };
  const { protocol, baseProtocol } = encodeWsCredentials(credentials);

  assert.equal(baseProtocol, WS_BASE_PROTOCOL);
  assert.ok(protocol.startsWith(WS_CREDENTIAL_PROTOCOL_PREFIX));
  // 子协议名必须只含 tchar，否则浏览器在构造 WebSocket 时抛 SyntaxError。
  assert.match(protocol, /^[A-Za-z0-9._~-]+$/);

  const protocols = parseWsProtocols(`${baseProtocol}, ${protocol}`);
  assert.deepEqual(decodeWsCredentials(protocols), credentials);
});

test('非 ASCII 口令不会像 btoa 那样抛错，且编码结果仍是纯 ASCII', () => {
  const credentials = { token: '口令-é😀-token', code: '123456' };
  const { protocol } = encodeWsCredentials(credentials);

  for (const char of protocol) {
    assert.ok(char.charCodeAt(0) < 128, '协议名只能是 ASCII');
  }
  assert.deepEqual(decodeWsCredentials([protocol]), credentials);
});

test('空字段不写进载荷；完全没有凭证时也能往返', () => {
  const { protocol } = encodeWsCredentials({ code: '', token: undefined });
  assert.deepEqual(decodeWsCredentials([protocol]), {});

  const onlyCode = encodeWsCredentials({ code: '000000', sessionProof: undefined }).protocol;
  assert.deepEqual(decodeWsCredentials([onlyCode]), { code: '000000' });
});

test('坏 base64url / 坏 JSON / 坏字段类型一律返回 null（调用方回落 query）', () => {
  const prefix = WS_CREDENTIAL_PROTOCOL_PREFIX;
  assert.equal(decodeWsCredentials([`${prefix}!!!not-base64!!!`]), null);
  // 4n+1 长度不可能由字节序列编码出来。
  assert.equal(decodeWsCredentials([`${prefix}A`]), null);
  assert.equal(decodeWsCredentials([`${prefix}${base64url('not json')}`]), null);
  assert.equal(decodeWsCredentials([`${prefix}${base64url('[1,2,3]')}`]), null);
  assert.equal(decodeWsCredentials([`${prefix}${base64url('null')}`]), null);
  assert.equal(decodeWsCredentials([`${prefix}${base64url('{"token":42}')}`]), null);
  // null 字段按「没带」处理，其余字段照常可用。
  assert.deepEqual(decodeWsCredentials([`${prefix}${base64url('{"code":null}')}`]), {});
});

test('只认带前缀的协议；没有匹配项返回 null', () => {
  assert.equal(decodeWsCredentials([]), null);
  assert.equal(decodeWsCredentials(['aerodrop.v1']), null);
  assert.equal(decodeWsCredentials(['chat', 'superchat']), null);

  const { protocol } = encodeWsCredentials({ token: 'abc' });
  assert.deepEqual(decodeWsCredentials(['chat', protocol]), { token: 'abc' });
});

test('回显协议只选非秘密的 aerodrop.v1', () => {
  const { protocol, baseProtocol } = encodeWsCredentials({ token: 'abc' });

  assert.equal(pickAcceptedProtocol([baseProtocol, protocol]), baseProtocol);
  // 只带凭证协议时不回显任何东西：把凭证协议回显给客户端等于把它再写进响应头。
  assert.equal(pickAcceptedProtocol([protocol]), undefined);
  // 旧客户端不带任何协议 → 不设响应头（浏览器照常连接）。
  assert.equal(pickAcceptedProtocol([]), undefined);
  assert.equal(pickAcceptedProtocol(['chat']), undefined);
});

test('parseWsProtocols 按逗号拆分并去掉空项', () => {
  assert.deepEqual(parseWsProtocols('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseWsProtocols('  '), []);
  assert.deepEqual(parseWsProtocols(null), []);
});

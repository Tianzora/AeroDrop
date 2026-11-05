import test from 'node:test';
import assert from 'node:assert/strict';

import { parseShareCodeFromClipboard } from './shareCodeSession.ts';


test('parses six-digit codes from pasted text and share URLs', () => {

  assert.equal(parseShareCodeFromClipboard('123456'), '123456');
  assert.equal(parseShareCodeFromClipboard('  654321  '), '654321');
  assert.equal(parseShareCodeFromClipboard('https://example.com/?code=654321&view=share'), '654321');
  assert.equal(parseShareCodeFromClipboard('https://example.com/?foo=1&code=111222'), '111222');
  assert.equal(parseShareCodeFromClipboard('https://example.com/?code=1234'), null, '4-digit codes are gone');
  assert.equal(parseShareCodeFromClipboard('hello world'), null);
  assert.equal(parseShareCodeFromClipboard(''), null);
  assert.equal(parseShareCodeFromClipboard(null), null);
  assert.equal(parseShareCodeFromClipboard('1234567'), null);
});

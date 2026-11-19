import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useRoomVoice } from './useRoomVoice.ts';

function surface() {
  const api = useRoomVoice();
  return createElement('div', null, JSON.stringify({
    joined: api.joined,
    muted: api.muted,
    volume: api.volume,
    remoteMemberCount: api.remoteMemberCount,
    error: api.error,
    hasJoin: typeof api.joinVoice === 'function',
    hasToggle: typeof api.toggleMute === 'function',
    hasAttach: typeof api.attachConnection === 'function',
  }));
}

test('useRoomVoice SSR 初始态：未加入、未静音、默认音量 100、命令齐全', () => {
  const html = renderToStaticMarkup(createElement(surface));
  assert.match(html, /&quot;joined&quot;:false/);
  assert.match(html, /&quot;muted&quot;:false/);
  assert.match(html, /&quot;volume&quot;:100/);
  assert.match(html, /&quot;hasJoin&quot;:true/);
  assert.match(html, /&quot;hasAttach&quot;:true/);
});

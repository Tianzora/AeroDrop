import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProfileMenu } from './ProfileMenu.tsx';

const render = () => renderToStaticMarkup(React.createElement(ProfileMenu));

test('标题栏身份入口可访问，未设置时显示访客名与预设头像', () => {
  const markup = render();
  assert.match(markup, /aria-label="设置资料"/);
  assert.match(markup, /title="设置资料"/);
  assert.match(markup, /aria-haspopup="dialog"/);
  assert.match(markup, /访客-\d{4}/);
});

test('默认不渲染「设置资料」弹窗，避免首屏多一层遮罩', () => {
  const markup = render();
  assert.doesNotMatch(markup, /<h3[^>]*>设置资料<\/h3>/);
  assert.doesNotMatch(markup, /aria-modal/);
});
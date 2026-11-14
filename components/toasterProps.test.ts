import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toaster } from 'sonner';

import { TOASTER_PROPS } from './toasterProps.ts';

test('toast 容器是 live region：sonner 的 section 带 aria-live，且标签是中文', () => {
  const markup = renderToStaticMarkup(React.createElement(Toaster, TOASTER_PROPS));

  // 读屏用户要靠这个 live region 才能听到「传输完成 / 分享已失效」这类 toast。
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /aria-label="通知/);
});

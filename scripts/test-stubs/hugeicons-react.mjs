// HugeiconsIcon 的极简替代：测试不断言图标 SVG，只要渲染出一个占位节点、不把
// 非 DOM 属性透传到宿主元素上即可（否则 React 会打印 invalid DOM property 警告）。
import React from 'react';

export const HugeiconsIcon = ({ icon, className, size, color, strokeWidth, altIcon, ...rest }) =>
  React.createElement('span', {
    className,
    'data-hugeicon': icon?.__hugeiconStub ?? 'stub',
    'aria-hidden': true,
  });

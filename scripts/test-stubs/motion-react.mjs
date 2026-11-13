// node:test 加载层里替换 `motion/react` 的极简实现。
//
// 为什么存在：组件测试只断言渲染出的文本、class、aria 和事件，不需要真实动画；
// 而 motion 的 ESM 入口在 tsx 下每个测试子进程要逐文件转译约 30s。
//
// 约束：被断言的 DOM 契约必须原样保留——className/style/data-*/aria-* 与子节点文本
// 直接透传；只有动画相关的 props（initial/animate/transition/...）被丢弃。
import React from 'react';

const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileDrag',
  'whileInView',
  'viewport',
  'layout',
  'layoutId',
  'layoutDependency',
  'layoutScroll',
  'layoutRoot',
  'drag',
  'dragConstraints',
  'dragElastic',
  'dragMomentum',
  'dragDirectionLock',
  'dragPropagation',
  'dragSnapToOrigin',
  'dragListener',
  'dragControls',
  'onAnimationStart',
  'onAnimationComplete',
  'onUpdate',
  'onDragStart',
  'onDrag',
  'onDragEnd',
  'onDragTransitionEnd',
  'onDirectionLock',
  'onViewportEnter',
  'onViewportLeave',
  'onLayoutAnimationStart',
  'onLayoutAnimationComplete',
  'transformTemplate',
  'inherit',
  'custom',
]);

/** 真实库的 MotionValue 是带动画对象的句柄；测试里只需要能读当前值。 */
class StubMotionValue {
  constructor(current) {
    this.current = current;
  }

  get() {
    return this.current;
  }

  set(next) {
    this.current = next;
  }

  on() {
    return () => {};
  }

  destroy() {}
}

const isMotionValue = (value) => value instanceof StubMotionValue;

const unwrap = (value) => (isMotionValue(value) ? value.get() : value);

const unwrapStyle = (style) => {
  if (!style) return style;
  const next = {};
  for (const [key, value] of Object.entries(style)) {
    next[key] = unwrap(value);
  }
  return next;
};

const unwrapChildren = (children) => {
  if (isMotionValue(children)) return children.get();
  if (Array.isArray(children)) return children.map(unwrapChildren);
  return children;
};

// 同一标签复用同一个组件，避免每次渲染产生新的组件类型导致 React 重新挂载。
const componentCache = new Map();

const createMotionComponent = (tag) => {
  const cached = componentCache.get(tag);
  if (cached) return cached;

  const Component = React.forwardRef(function MotionStub(props, ref) {
    const domProps = {};
    let style;
    let children;

    for (const [key, value] of Object.entries(props)) {
      if (key === 'style') {
        style = unwrapStyle(value);
      } else if (key === 'children') {
        children = unwrapChildren(value);
      } else if (!MOTION_PROPS.has(key)) {
        domProps[key] = value;
      }
    }

    return React.createElement(tag, { ...domProps, style, ref }, children);
  });

  componentCache.set(tag, Component);
  return Component;
};

export const motion = new Proxy(
  {},
  {
    get(_target, tag) {
      if (typeof tag !== 'string') return undefined;
      // motion.create(Component) 在真实库里返回 motion 化的组件。
      if (tag === 'create') return (Component) => Component;
      return createMotionComponent(tag);
    },
  },
);

export const AnimatePresence = ({ children }) =>
  React.createElement(React.Fragment, null, children);

export const useReducedMotion = () => false;

export const motionValue = (initial) => new StubMotionValue(initial);

export const useMotionValue = (initial) => {
  const ref = React.useRef(null);
  if (ref.current === null) {
    ref.current = new StubMotionValue(initial);
  }
  return ref.current;
};

export const useSpring = (initial) => useMotionValue(initial);

export const useTransform = (input, transformer) => {
  if (typeof input === 'function') {
    return new StubMotionValue(input());
  }

  const read = Array.isArray(input) ? input.map(unwrap) : unwrap(input);
  const value = typeof transformer === 'function' ? transformer(read) : read;
  return new StubMotionValue(value);
};

/** 同步落到终值并返回 thenable，保持 `animate(...).then(...)` 的调用形态。 */
export const animate = (target, keyframes) => {
  const apply = () => {
    if (isMotionValue(target)) {
      target.set(keyframes);
      return;
    }
    if (Array.isArray(target)) {
      const next = Array.isArray(keyframes) ? keyframes : [keyframes];
      target.forEach((entry, index) => {
        if (isMotionValue(entry)) entry.set(next[index]);
      });
      return;
    }
    if (target && typeof target === 'object' && keyframes && typeof keyframes === 'object') {
      for (const [key, value] of Object.entries(keyframes)) {
        if (isMotionValue(target[key])) target[key].set(value);
      }
    }
  };

  apply();

  const finished = Promise.resolve();
  return {
    then: (...args) => finished.then(...args),
    catch: (...args) => finished.catch(...args),
    finally: (...args) => finished.finally(...args),
    finished,
    stop: () => {},
    cancel: () => {},
  };
};

export default { motion, AnimatePresence };

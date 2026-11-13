// 只替换视觉实现：图标数据本身没有断言，但组件测试要能把它当 props 传下去。
const iconData = (name) => Object.freeze({ __hugeiconStub: name });

export const Tick02Icon = iconData('Tick02Icon');

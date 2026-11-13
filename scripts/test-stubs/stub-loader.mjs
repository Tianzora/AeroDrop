// 组件测试的加载层别名：把「只在浏览器里做视觉效果」的大 barrel 依赖换成本地
// 极简实现。真实入口在 tsx 下要逐文件转译（motion/react ≈34s/进程，
// @hugeicons/core-free-icons ≈81s/进程，后者共 131MB），是组件测试慢的全部原因。
//
// 只做 specifier → 本地 stub 的映射；其余解析一律交回默认/tsx 的钩子。
const STUB_MODULES = new Map([
  ['motion/react', './motion-react.mjs'],
  ['@hugeicons/react', './hugeicons-react.mjs'],
  ['@hugeicons/core-free-icons', './hugeicons-core-free-icons.mjs'],
  // Workers 运行时模块：Node 里不存在，但 worker 编排测试需要 import src/worker.ts。
  ['cloudflare:workers', './cloudflare-workers.mjs'],
]);

const stubUrl = (relative) => new URL(relative, import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const stub = STUB_MODULES.get(specifier);
  if (stub) {
    return { url: stubUrl(stub), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

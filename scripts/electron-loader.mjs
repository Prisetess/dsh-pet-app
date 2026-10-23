/** Node 模块解析钩子：把 `import ... from 'electron'` 指到假模块（纯测试用） */
const STUB = new URL('./electron-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}

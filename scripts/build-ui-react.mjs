/**
 * 构建「官方 React 设置页」→ ui-react/dist/。
 *
 * 需要三个包（本机离线时装不上，联网后执行一次即可）：
 *   npm i -D esbuild react@18 react-dom@18
 *
 * 注意 react 与 react-dom 的**大版本必须一致**：react-dom@19 会去读 React 19 的内部对象，
 * 配上 react@18 会直接崩。这里构建前先校验，避免装错了还以为能跑。
 */
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(appRoot, 'package.json'));
const outDir = path.join(appRoot, 'ui-react', 'dist');

function fail(message) {
  console.error('[build-ui-react] 失败：' + message);
  process.exit(1);
}

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  fail('没装 esbuild。联网后执行：npm i -D esbuild react@18 react-dom@18');
}

/** 校验 react / react-dom 版本，并拿到它们的解析路径（必须在 appRoot 下才能被 esbuild 打包） */
function resolveReactPair() {
  let reactPkg;
  let domPkg;
  try {
    reactPkg = require('react/package.json');
    domPkg = require('react-dom/package.json');
  } catch {
    fail('没装 react / react-dom。联网后执行：npm i -D esbuild react@18 react-dom@18');
  }
  const major = (version) => String(version).split('.')[0];
  if (major(reactPkg.version) !== major(domPkg.version) || major(reactPkg.version) !== '18') {
    fail(
      `react@${reactPkg.version} 与 react-dom@${domPkg.version} 不匹配（本方案按 React 18 编写）。\n` +
        '        请执行：npm i -D react@18 react-dom@18',
    );
  }
  return { react: reactPkg.version, reactDom: domPkg.version };
}

const versions = resolveReactPair();
console.log(`[build-ui-react] react@${versions.react} + react-dom@${versions.reactDom}`);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(appRoot, 'ui-react', 'entry.ts')],
  outfile: path.join(outDir, 'settings.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome114'],
  jsx: 'automatic',
  sourcemap: false,
  minify: false,
  loader: { '.ts': 'ts' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

for (const file of ['index.html', 'theme.css']) {
  await cp(path.join(appRoot, 'ui-react', file), path.join(outDir, file));
}

const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
if (!html.includes('settings.js')) fail('index.html 里没有引用 settings.js');

console.log('[build-ui-react] 完成 → ' + outDir);
console.log('[build-ui-react] 重启 App 即生效（main.mjs 会优先用 ui-react/dist）');

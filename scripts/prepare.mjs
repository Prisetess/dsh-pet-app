/**
 * 准备 vendor/plugin —— 把已安装的 dsh-pet 复制进来并打两个小补丁。
 *
 * 为什么要复制而不是直接引用 node_modules：
 *   1. 打包时必须带上插件本体与 60MB 素材，node_modules 不会进包；
 *   2. 我们要改插件的两份文件（桌面端菜单 + 宿主拉起 helper 的时机），
 *      直接改用户的 node_modules 会在下次 pnpm install 时被冲掉。
 *
 * 补丁一（runtime/electron-helper/sprite.js，手写 JS，非构建产物）：
 *   右键菜单加「设置」，并让「打开网站 / 查看余额 / 碎碎念 / 对话」按平台能力隐藏
 *   —— 独立模式没有 DSH 站点、没有凭证、没有模型，留着就是点了报错。
 *
 * 补丁二（lib/index.js，构建产物，用行锚点定位）：
 *   宿主 apply() 默认会自己 spawn 一个 Electron 去开宠物窗；本 App 自己在同一个进程里开窗，
 *   所以要让它在 DSH_PET_EMBEDDED=1 时跳过 —— 否则会出现「两套宠物窗」并且打包后拉不起来。
 */
import { copyFile, cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 我们要打包的插件版本（与 dsh-pet 保持一致；换版本时改这里） */
const PLUGIN_VERSION = '0.3.6';

const vendorRoot = path.join(appRoot, 'vendor');
const vendorPlugin = path.join(vendorRoot, 'plugin');
const stampFile = path.join(vendorRoot, 'plugin.stamp');

/**
 * 插件从哪来？依次尝试：
 *   1. 环境变量 DSH_PET_PLUGIN_ROOT（CI 或自定义位置）
 *   2. 本机已安装的 DSH 插件 ~/.dsh/profiles/desktop/node_modules/dsh-pet
 *   3. npm pack dsh-pet@<版本>（干净 clone 后自动下载，需要网络）
 * 都失败就给出可执行的提示，而不是让后面的补丁报一个看不懂的错。
 */
let pluginRoot = process.env.DSH_PET_PLUGIN_ROOT || null;

function defaultPluginRoot() {
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet');
}

/**
 * 拿插件 tarball 的两条路（都踩过坑，所以按顺序回退）：
 *
 * 1. `node <npm-cli.js> pack ...` —— 不用 cmd、不用 npm.cmd。
 *    Windows 上 Node 20+ 拒绝直接 spawn .cmd（CVE-2024-27980 → ENOENT/EINVAL），
 *    而 `cmd /c npm pack "pkg"` 会把引号原样传给 npm（报 Unknown command: ""pack"" /
 *    Invalid package name）。直接调 npm 的 JS 入口绕开这两个问题，同时仍遵守 npm 的
 *    registry / 代理配置。
 * 2. 直接下载 tarball（Node 20+ 自带 fetch）—— npm 入口不存在时兜底。
 */
const REGISTRY = process.env.DSH_PET_REGISTRY || 'https://registry.npmjs.org';

function findNpmCli() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(candidate) ? candidate : null;
}

function clearTarballs(cacheDir) {
  for (const name of readdirSync(cacheDir)) {
    if (name.endsWith('.tgz')) rmSync(path.join(cacheDir, name), { force: true });
  }
}

function pickTarball(cacheDir) {
  const tgz = readdirSync(cacheDir).find((name) => name.endsWith('.tgz'));
  return tgz ? path.join(cacheDir, tgz) : null;
}

async function downloadTarball(cacheDir) {
  const url = `${REGISTRY}/dsh-pet/-/dsh-pet-${PLUGIN_VERSION}.tgz`;
  log('回退到直接下载：' + url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}（${url}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const target = path.join(cacheDir, `dsh-pet-${PLUGIN_VERSION}.tgz`);
  await writeFile(target, buffer);
  return target;
}

/** 用 npm pack（或直接下载）把指定版本拉到 vendor/.cache 并解包，返回 package 目录 */
async function fetchPluginFromNpm() {
  const cacheDir = path.join(vendorRoot, '.cache');
  await mkdir(cacheDir, { recursive: true });
  clearTarballs(cacheDir);
  log(`本机没有安装 dsh-pet，尝试获取 dsh-pet@${PLUGIN_VERSION}…`);

  try {
    const npmCli = findNpmCli();
    if (npmCli) {
      try {
        // stdio 忽略：npm 会打印整份 tarball 清单（294 个文件），pipe 解析容易撞 maxBuffer
        execFileSync(process.execPath, [npmCli, 'pack', `dsh-pet@${PLUGIN_VERSION}`, '--pack-destination', cacheDir], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (error) {
        log('npm pack 失败，改用直接下载：' + (error instanceof Error ? error.message.split('\n')[0] : String(error)));
      }
    }

    let archive = pickTarball(cacheDir);
    if (!archive) archive = await downloadTarball(cacheDir);
    log(`已获取 ${path.basename(archive)}（${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB），解包…`);

    execFileSync('tar', ['-xf', archive, '-C', cacheDir], { stdio: 'inherit' });
    const packageDir = path.join(cacheDir, 'package');
    if (!existsSync(packageDir)) throw new Error('解包后没有 package 目录');
    return packageDir;
  } catch (error) {
    throw new Error(
      [
        `拿不到 dsh-pet@${PLUGIN_VERSION}：${error instanceof Error ? error.message : String(error)}`,
        '',
        '三个办法任选其一：',
        '  1) 装一次 DSH 桌宠插件（dsh-pet），让 ~/.dsh/profiles/desktop/node_modules/dsh-pet 存在；',
        `  2) 手动下载：npm pack dsh-pet@${PLUGIN_VERSION}，解包后把 package 目录复制到 vendor/plugin；`,
        '  3) 设置环境变量 DSH_PET_PLUGIN_ROOT 指向已有的 dsh-pet 目录。',
        '',
        '（走代理时记得同时设置 https_proxy 与 HTTPS_PROXY，npm 才认）',
      ].join('\n'),
    );
  }
}

/** 只复制运行时需要的目录（src 也带上：设置页要从 src 里读字段定义做兼容），不带 README/测试 */
const COPY_DIRS = ['lib', 'runtime', 'assets', 'src'];
const COPY_FILES = ['package.json', 'LICENSE'];

function log(message) {
  console.log('[prepare] ' + message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function copyPlugin(version) {
  await mkdir(vendorPlugin, { recursive: true });
  for (const dir of COPY_DIRS) {
    const from = path.join(pluginRoot, dir);
    if (!existsSync(from)) continue;
    await cp(from, path.join(vendorPlugin, dir), { recursive: true, force: true });
  }
  for (const file of COPY_FILES) {
    const from = path.join(pluginRoot, file);
    if (!existsSync(from)) continue;
    await cp(from, path.join(vendorPlugin, file), { force: true });
  }
  await writeFile(stampFile, JSON.stringify({ version, at: new Date().toISOString() }, null, 2), 'utf8');
  log(`已复制 dsh-pet@${version} → ${vendorPlugin}`);
}

/** 补丁一：桌面端右键菜单 */
async function patchSprite() {
  const file = path.join(vendorPlugin, 'runtime', 'electron-helper', 'sprite.js');
  let source = await readFile(file, 'utf8');

  /** 每处替换都必须命中，命中不到就是上游改了结构 —— 大声失败，别让用户面对一个没有「设置」的菜单 */
  const applyOnce = (from, to, label) => {
    if (!source.includes(from)) {
      throw new Error(`sprite.js 补丁失败（${label}）：锚点未找到，插件版本可能变了`);
    }
    source = source.replace(from, to);
  };
  /** 幂等版：源码里已经有 marker 就跳过（重复跑 prepare 不会炸） */
  const applyIfMissing = (marker, from, to, label) => {
    if (source.includes(marker)) return;
    applyOnce(from, to, label);
  };

  applyIfMissing(
    'const __caps',
    "    const tools = [{ label: '打开网站', action: 'open-site' }];",
    [
      '    // [dsh-pet-app] 独立 App：按平台能力裁剪工具项（没有 DSH 站点/凭证/模型，留着只会点了报错）',
      "    const __caps = (window.petBridge && window.petBridge.capabilities) || { site: true, balance: true, llm: true };",
      '    const tools = [];',
      "    if (__caps.site) tools.push({ label: '打开网站', action: 'open-site' });",
    ].join('\n'),
    '工具项数组',
  );

  applyIfMissing(
    '__caps.balance',
    "    if (this.pet.balanceEnabled) tools.push({ label: '查看余额', action: 'show-balance' });",
    "    if (this.pet.balanceEnabled && __caps.balance) tools.push({ label: '查看余额', action: 'show-balance' });",
    '余额项',
  );

  applyIfMissing(
    "action: 'settings'",
    [
      '    tools.push(',
      "      { label: '碎碎念', action: 'whisper' },",
      "      { label: '对话', action: 'chat' },",
      "      { label: '回到初始位置', action: 'home' },",
    ].join('\n'),
    [
      "    if (__caps.llm) tools.push({ label: '碎碎念', action: 'whisper' }, { label: '对话', action: 'chat' });",
      '    tools.push(',
      "      { label: '设置', action: 'settings' },",
      "      { label: '回到初始位置', action: 'home' },",
    ].join('\n'),
    '碎碎念/对话 + 设置项',
  );

  applyIfMissing(
    "if (leaf.action === 'settings')",
    "    if (leaf.action === 'home') {",
    [
      "    if (leaf.action === 'settings') {",
      '      // [dsh-pet-app] 打开独立设置窗口（由 preload 暴露 → 主进程建窗）',
      "      if (window.petBridge && typeof window.petBridge.openSettings === 'function') window.petBridge.openSettings();",
      '      return;',
      '    }',
      "    if (leaf.action === 'home') {",
    ].join('\n'),
    '动作分发',
  );

  // 大小子菜单（右键菜单里快速调大小）
  applyIfMissing(
    '大小子菜单',
    "      { label: '设置', action: 'settings' },",
    [
      '      // [dsh-pet-app] 大小子菜单',
      '      {',
      "        label: '大小',",
      '        children: [',
      "          { label: '变大', action: 'size-larger' },",
      "          { label: '变小', action: 'size-smaller' },",
      "          { label: '还原默认', action: 'size-reset' },",
      '        ],',
      '      },',
      "      { label: '设置', action: 'settings' },",
    ].join('\n'),
    '大小子菜单',
  );

  // 大小子菜单的动作分发
  applyIfMissing(
    '大小动作',
    "    if (leaf.action === 'settings') {",
    [
      '    // [dsh-pet-app] 大小动作：写配置后由主进程重建窗口',
      "    if (leaf.action === 'size-larger' || leaf.action === 'size-smaller' || leaf.action === 'size-reset') {",
      "      const mode = leaf.action === 'size-larger' ? 'larger' : leaf.action === 'size-smaller' ? 'smaller' : 'reset';",
      "      if (window.petBridge && typeof window.petBridge.adjustSize === 'function') window.petBridge.adjustSize(mode);",
      '      return;',
      '    }',
      "    if (leaf.action === 'settings') {",
    ].join('\n'),
    '大小动作',
  );

  await writeFile(file, source, 'utf8');
  log('sprite.js 补丁完成：菜单加「设置」+ 能力裁剪');
}

/** 补丁二：宿主不再自己 spawn Electron（本 App 在进程内开窗） */
async function patchHostBundle() {
  const file = path.join(vendorPlugin, 'lib', 'index.js');
  let lines = (await readFile(file, 'utf8')).split('\n');
  if (lines.some((line) => line.includes('DSH_PET_EMBEDDED'))) {
    log('lib/index.js 已是补丁版本，跳过');
    return;
  }
  const start = lines.findIndex((line) => line.includes('const startHelper = () => {'));
  if (start < 0) throw new Error('lib/index.js 补丁失败：没找到 startHelper');
  const guard = lines.findIndex(
    (line, index) => index > start && line.includes('if (helper || electronEnsure || disposed) return;'),
  );
  if (guard < 0) throw new Error('lib/index.js 补丁失败：没找到 startHelper 的幂等守卫');
  lines.splice(
    guard + 1,
    0,
    '\t\tif (process.env.DSH_PET_EMBEDDED === "1") return; // [dsh-pet-app] 嵌入式运行：窗口由 App 主进程自己创建',
  );
  await writeFile(file, lines.join('\n'), 'utf8');
  log('lib/index.js 补丁完成：嵌入式模式下跳过 helper 拉起');
}

/**
 * 给 vendor 里的插件补上它需要的 5 个外部依赖 —— 全部是**桩**。
 *
 * lib/index.js（DSH 构建）在模块顶层 import 这些包：三个 DSH 服务包 + 两个 Electron 下载包。
 * 本 App 不需要它们（DSH 服务由伪 ctx 提供，Electron 由 App 自己就是），但模块图必须能加载。
 * 这与插件自带的 src/standalone/shims/* 是同一套手法（它的独立模式也是这么做的）。
 */
const STUBS = {
  '@deepseek-ai/dsh-home-paths': `import { homedir } from 'node:os';
import { join } from 'node:path';
/** 与插件 host/helper-process.ts 的 dshHomeDir() 同口径 */
export function resolveDshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh'); }
`,
  '@deepseek-ai/dsh-credentials': `export function credentialRef(ref) { return ref; }\n`,
  '@deepseek-ai/dsh-llm': `export function createUserMessage(input) { return { role: 'user', content: input.content, source: input.source }; }
export function createAssistantMessage(input) { return { role: 'assistant', content: input.content, source: input.source }; }
export function ReasoningEffortId(id) { return id; }
export class BlockAssembler {
  #chunks = [];
  push(chunk) { if (chunk && chunk.type === 'text' && typeof chunk.text === 'string') this.#chunks.push(chunk.text); }
  blocks() { const text = this.#chunks.join(''); return text === '' ? [] : [{ type: 'text', text }]; }
}
`,
  '@electron/get': `export async function downloadArtifact() { throw new Error('dsh-pet-app: 嵌入式运行不下载 Electron'); }\n`,
  '@electron-internal/extract-zip': `export default async function extract() { throw new Error('dsh-pet-app: 嵌入式运行不解压 Electron'); }\n`,
};

async function writeStubs() {
  const nodeModules = path.join(vendorPlugin, 'node_modules');
  for (const [name, source] of Object.entries(STUBS)) {
    const dir = path.join(nodeModules, ...name.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '0.0.0-app-stub', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2),
      'utf8',
    );
    await writeFile(path.join(dir, 'index.js'), source, 'utf8');
  }
  log(`已写入 ${Object.keys(STUBS).length} 个依赖桩 + dsh-home.mjs`);
}

/**
 * 编译"前台窗口监视器"（全屏自动隐藏用）。失败不算错——功能会自动关闭。
 */
/** 把 build/app.ico 同步到 ui/app.ico：托盘图标 + 窗口图标在运行时从这里读 */
async function syncAppIcon() {
  const from = path.join(appRoot, 'build', 'app.ico');
  const to = path.join(appRoot, 'ui', 'app.ico');
  if (!existsSync(from)) {
    // 干净 clone 里没有构建产物：从 ui/guide.png 现场生成（缺 csc/PS 就跳过，不影响运行）
    const script = path.join(appRoot, 'scripts', 'build-icon.ps1');
    if (!existsSync(script)) {
      log('缺 build/app.ico 与 build-icon.ps1，跳过图标同步');
      return;
    }
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        stdio: 'inherit',
      });
    } catch (error) {
      log('生成图标失败（跳过）：' + (error instanceof Error ? error.message : String(error)));
      return;
    }
  }
  await copyFile(from, to);
  log('ui/app.ico 已同步');
}

async function buildForegroundMonitor() {
  const out = path.join(appRoot, 'build', 'fgmon.exe');
  const source = path.join(appRoot, 'scripts', 'fgmon', 'ForegroundMonitor.cs');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!existsSync(csc) || !existsSync(source)) {
    log('跳过 fgmon 编译（缺 csc 或源码），全屏自动隐藏不可用');
    return;
  }
  if (existsSync(out) && (await stat(out)).mtimeMs >= (await stat(source)).mtimeMs) {
    log('fgmon.exe 已是最新');
    return;
  }
  try {
    await mkdir(path.dirname(out), { recursive: true });
    execFileSync(csc, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', `/out:${out}`, source], {
      stdio: 'ignore',
    });
    log('已编译 build/fgmon.exe');
  } catch (error) {
    log('编译 fgmon 失败（全屏自动隐藏不可用）：' + (error instanceof Error ? error.message : String(error)));
  }
}

async function resolvePluginRoot() {
  const candidates = [];
  if (process.env.DSH_PET_PLUGIN_ROOT) candidates.push(process.env.DSH_PET_PLUGIN_ROOT);
  candidates.push(defaultPluginRoot());
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'package.json'))) {
      log('插件来源：' + dir);
      return dir;
    }
  }
  return await fetchPluginFromNpm();
}

async function main() {
  pluginRoot = await resolvePluginRoot();
  const pkg = await readJson(path.join(pluginRoot, 'package.json'));
  const stamp = existsSync(stampFile) ? await readJson(stampFile).catch(() => null) : null;
  const upToDate = stamp && stamp.version === pkg.version && existsSync(path.join(vendorPlugin, 'lib', 'index.js'));

  if (!upToDate) {
    await copyPlugin(pkg.version);
  } else {
    log(`vendor 已是最新（dsh-pet@${pkg.version}），跳过复制`);
  }

  await patchSprite();
  await buildForegroundMonitor();
  await syncAppIcon();
  await patchHostBundle();
  await writeStubs();

  const size = (await stat(path.join(vendorPlugin, 'assets'))).isDirectory() ? 'ok' : 'missing';
  log(`素材目录：${size}`);
  log('准备完成，可以 npm start');
}

main().catch((error) => {
  console.error('[prepare] 失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

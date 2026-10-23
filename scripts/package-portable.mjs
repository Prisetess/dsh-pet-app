/**
 * 打包成「双击即用」的便携版（完全离线，不需要 electron-builder）。
 *
 * ⚠️ 不再把 electron.exe 改名。实测：改名后的副本在本机会被 SmartScreen/策略静默拦在
 * Electron 原生层（连一行日志都不写、进程秒退），而原版 electron.exe 能正常跑。
 * 所以这里保留 `electron.exe` 原名，用「快捷方式 + 启动器」提供双击入口：
 *
 *   dist/DSH Pet/
 *   ├── electron.exe            原版运行时（双击它没有界面，因为要带参数）
 *   ├── DSH Pet.lnk             双击这个（指向 electron.exe + resources\app）
 *   ├── 启动.bat                 同上，命令行入口
 *   ├── 诊断.bat                 带 --enable-logging 跑一次并打印日志
 *   └── resources/app/          我们的代码 + 插件 + 素材
 *
 * 想要"一个 exe 文件"的形态，需要 electron-builder（联网）打 portable target。
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(appRoot, 'dist');
const outDir = path.join(distRoot, 'DSH Pet');
const electronDist = process.env.DSH_PET_ELECTRON_DIST || path.join(os.homedir(), '.dsh', 'electron');

/** 需要放进 resources/app 的目录（scripts/ 是开发用的，不进包） */
const APP_ENTRIES = ['src', 'ui', 'vendor'];
const APP_FILES = ['package.json'];

const log = (message) => console.log('[package] ' + message);

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0) + ' MB';


async function main() {
  if (!existsSync(path.join(electronDist, 'electron.exe'))) {
    throw new Error(
      `没找到 Electron 发行版：${electronDist}\n` +
        '用 DSH_PET_ELECTRON_DIST 指向一个解压好的 electron 目录（里面要有 electron.exe）。',
    );
  }
  if (!existsSync(path.join(appRoot, 'vendor', 'plugin', 'lib', 'index.js'))) {
    throw new Error('vendor/plugin 还没准备好：先跑 npm run vendor');
  }

  log('清空旧产物…');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log(`复制 Electron 发行版（${electronDist}）…`);
  await cp(electronDist, outDir, { recursive: true, force: true });

  const appDir = path.join(outDir, 'resources', 'app');
  await mkdir(appDir, { recursive: true });
  for (const file of APP_FILES) {
    await cp(path.join(appRoot, file), path.join(appDir, file));
  }
  for (const entry of APP_ENTRIES) {
    if (!existsSync(path.join(appRoot, entry))) continue;
    await cp(path.join(appRoot, entry), path.join(appDir, entry), { recursive: true, force: true });
  }
  if (existsSync(path.join(appRoot, 'ui-react', 'dist', 'index.html'))) {
    await cp(path.join(appRoot, 'ui-react', 'dist'), path.join(appDir, 'ui-react', 'dist'), {
      recursive: true,
      force: true,
    });
    log('已包含官方 React 设置页（ui-react/dist）');
  }

  // 启动器一律纯 ASCII：.bat 由 cmd.exe 按 OEM 代码页解析，中文注释会乱码
  await writeFile(
    path.join(outDir, '启动.bat'),
    [
      '@echo off',
      'rem Clear ELECTRON_RUN_AS_NODE: if set, electron runs as plain node and exits with no window.',
      'set "ELECTRON_RUN_AS_NODE="',
      'rem Launch the app that lives in resources\\app using the bundled electron runtime.',
      'start "" "%~dp0electron.exe" "%~dp0resources\\app"',
    ].join('\r\n'),
    'ascii',
  );

  await writeFile(
    path.join(outDir, '诊断.bat'),
    [
      '@echo off',
      'cd /d "%~dp0"',
      'set "ELECTRON_RUN_AS_NODE="',
      'echo ============================================',
      'echo  DSH Pet diagnostic mode',
      'echo  -^> run.log                            : Electron/Chromium output',
      'echo  -^> %USERPROFILE%\\.dsh\\dsh-pet-app.log : App log',
      'echo ============================================',
      'echo.',
      'echo Starting... (wait 15s even if no window shows up)',
      'echo.',
      '"%~dp0electron.exe" "%~dp0resources\\app" --enable-logging > "%~dp0run.log" 2>&1',
      'echo.',
      'echo ==== app exited, log follows ====',
      'echo.',
      'if exist "%USERPROFILE%\\.dsh\\dsh-pet-app.log" (',
      '  type "%USERPROFILE%\\.dsh\\dsh-pet-app.log"',
      ') else (',
      '  echo [missing %USERPROFILE%\\.dsh\\dsh-pet-app.log] main process never ran JS',
      ')',
      'echo.',
      'echo ==== run.log (Electron/Chromium output) ====',
      'if exist "%~dp0run.log" type "%~dp0run.log"',
      'echo.',
      'pause',
    ].join('\r\n'),
    'ascii',
  );

  await writeFile(
    path.join(outDir, '使用说明.txt'),
    [
      'DSH Pet 便携版',
      '',
      '【怎么启动】',
      '双击「DSH Pet.exe」——这是本工程自己编译的启动器（45KB），它会拉起同目录的 electron.exe。',
      '如果还没有 DSH Pet.exe：先跑一次「npm run launcher」，或直接双击「启动.bat」。',
      '',
      '想放到桌面：右键「DSH Pet.exe」→ 发送到 → 桌面快捷方式。',
      '',
      '【用法】',
      '- 右键宠物 →「设置」：调大小 / 位置 / 物理手感',
      '- 托盘图标（右下角）：「设置…」「重新加载桌宠」「打开配置目录」「退出」',
      '',
      '【没反应时】',
      '1. 双击「诊断.bat」，等 15 秒，把窗口里的内容发回来',
      '2. 日志：%USERPROFILE%\\.dsh\\dsh-pet-app.log',
      '3. run.log 在同一个目录里',
      '',
      '【注意】',
      '- 整个文件夹可以随便挪，但不能只拷部分文件',
      '- 配置：%USERPROFILE%\\.dsh\\dsh-pet\\main-config.jsonc（与 DSH 里的桌宠插件共用）',
    ].join('\r\n'),
    'utf8',
  );

  const total = await dirSize(outDir);
  const appSize = await dirSize(appDir);
  log('');
  log('打包完成：' + outDir);
  if (existsSync(path.join(outDir, 'DSH Pet.exe'))) {
    log('  双击入口    DSH Pet.exe');
  } else {
    log('  双击入口    启动.bat（还没编译启动器：跑 npm run launcher 会生成 DSH Pet.exe）');
  }
  log(`  应用代码    resources/app  ${mb(appSize)}`);
  log(`  总体积      ${mb(total)}`);
}

main().catch((error) => {
  console.error('[package] 失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

/**
 * 用本机的 Electron 启起这个 App。
 *
 * 优先顺序：
 *   1. DSH_PET_ELECTRON_EXE（显式指定）；
 *   2. $DSH_HOME/electron/electron.exe —— DSH 已经下载过的运行时（默认 ~/.dsh/electron）；
 *   3. 本地 node_modules/electron/dist/electron.exe（自己 npm i electron 之后）。
 *
 * 打包成安装包后这一步由 electron-builder 接管，不再需要本脚本。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const candidates = [
  process.env.DSH_PET_ELECTRON_EXE,
  path.join(os.homedir(), '.dsh', 'electron', 'electron.exe'),
  path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
].filter(Boolean);

const exe = candidates.find((candidate) => existsSync(candidate));
if (!exe) {
  console.error(
    '没找到 Electron 运行时。三种解决办法：\n' +
      '  1. DSH_PET_ELECTRON_EXE=C:\\path\\to\\electron.exe npm start\n' +
      '  2. 先让 DSH 下载过（默认落在 ~/.dsh/electron/）\n' +
      '  3. 在本目录 npm i electron',
  );
  process.exit(1);
}

console.log('[start] Electron: ' + exe);
const child = spawn(exe, [appRoot], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));

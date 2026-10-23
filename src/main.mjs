/**
 * DSH Pet —— 独立 Windows 桌宠 App（主进程）
 *
 * 这个进程一个人干四件事：
 *   1. 起 HTTP 宿主：伪 Cordis ctx + 插件自己的 apply(ctx)（路由/配置/素材全复用插件实现）；
 *   2. 开透明宠物窗：直接加载插件的 runtime/electron-helper/renderer（纯 DOM，不依赖 DSH 前端）；
 *   3. 开设置窗：右键宠物 →「设置」，或者托盘菜单；
 *   4. 托盘常驻：宠物窗/设置窗都是子窗口，关掉不退出。
 *
 * 为什么宠物窗在本进程里开、而不是像 DSH 里那样再 spawn 一个 Electron：
 * 打包后的 exe 只加载内置 app.asar，`exe helper.js` 那条路走不通；而本进程本来就是 Electron，
 * 直接建窗既省一份 200MB 运行时，也让「保存配置 → 重建宠物窗」变成进程内的动作。
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, dialog } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 必须在加载插件宿主之前设置：让它的 startHelper() 直接返回（窗口由本文件创建）
process.env.DSH_PET_EMBEDDED = '1';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const vendorPlugin = path.join(appRoot, 'vendor', 'plugin');
const petWindowRoot = path.join(vendorPlugin, 'runtime', 'electron-helper');
const uiRoot = path.join(appRoot, 'ui');
/** 设置页优先用「官方 React 页」（ui-react/dist，需先 npm run build:ui-react），没有再退回内置页 */
const uiReactRoot = path.join(appRoot, 'ui-react', 'dist');
const settingsRoot = existsSync(path.join(uiReactRoot, 'index.html')) ? uiReactRoot : uiRoot;
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

// ---------------------------------------------------------------- 日志
// 按需求：不再自动生成日志文件。只写控制台（开发时看得到），不落盘。
// 需要排查时用环境变量 DSH_PET_LOG_FILE 指定一个路径，才会写文件。
const LOG_FILE = process.env.DSH_PET_LOG_FILE || '';

function fileLog(level, message) {
  if (!LOG_FILE) return;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${level} ${message}\n`, 'utf8');
  } catch {
    /* 日志写不进去也不能让 App 挂掉 */
  }
}

process.on('uncaughtException', (error) => {
  fileLog('FATAL', error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error('[dsh-pet-app] 未捕获异常：', error);
});
process.on('unhandledRejection', (reason) => {
  fileLog('REJECT', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  console.error('[dsh-pet-app] 未处理的 Promise 拒绝：', reason);
});

const APP_STARTED_AT = Date.now();
fileLog('BOOT', `启动 pid=${process.pid} electron=${process.versions.electron}`);

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下有已知缺陷：
//   - 拖拽移动时窗口四周出现黑色边框（插件 issue #37）
//   - 大透明窗移动覆盖小透明窗时，被覆盖的窗口内容丢失
//   - 拖拽跟随明显掉帧、发涩
// 插件自己的 helper 也是这么处理的（只在 win32 关，macOS/Linux 合成路径不同，保留硬件加速）。
// 代价是设置窗也走软件渲染 —— 它只是个表单页，无感。
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  fileLog('INFO', '已关闭硬件加速');
}

const SCALE = Number(process.env.DSH_PET_SCALE || '1') || 1;
/** 与插件 helper 一致：60ms。兜底通道要够快，否则光标进出宠物身体后的穿透翻转会明显滞后 */
const POINTER_POLL_MS = 60;

const log = (message) => {
  console.log('[dsh-pet-app] ' + message);
  fileLog('INFO', String(message));
};
const logError = (message) => {
  console.error('[dsh-pet-app] ' + message);
  fileLog('ERROR', String(message));
};

/** win.id → 穿透状态（true = 整窗穿透）；所有 setIgnoreMouseEvents 只走 setWindowIgnore 一个出口 */
const windowIgnore = new Map();
/** win.id → 渲染端正拿着鼠标输入（拖拽/菜单/对话框开着），兜底轮询期间绝不翻回穿透 */
const inputBusy = new Map();
/** win.id → 上一次请求的内容区 bounds（去重必须比我们请求的值，不能回读 Win32 的取整结果） */
const lastRequestedBounds = new Map();
/** petId → BrowserWindow */
const petWindows = new Map();

let server = null;
let hostContext = null;
let baseUrl = '';
let settingsWin = null;
let guideWin = null;
let tray = null;
let quitting = false;
let cleanupDone = false;
let displaysTimer = null;
let rebuildTimer = null;
let pausedState = false;
let petsVisible = true;

// ---------------------------------------------------------------- 可选性能探针
// DSH_PET_PERF=1 时每 5 秒打一行：帧间隔（渲染端有没有按 60fps 喂 bounds）、
// setContentBounds 的耗时（OS/合成器有多慢）、穿透翻转次数（翻转抖动会打断输入）。
// 排查卡顿时先看这三个数，别猜。
const PERF = process.env.DSH_PET_PERF === '1';
const perf = { lastAt: 0, gaps: [], costs: [], flips: 0, frames: 0, since: Date.now() };

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

function perfSample(costMs) {
  if (!PERF) return;
  const now = performance.now();
  if (perf.lastAt > 0) {
    const gap = now - perf.lastAt;
    if (gap > 0 && gap < 500) perf.gaps.push(gap);
  }
  perf.lastAt = now;
  perf.costs.push(costMs);
  perf.frames += 1;
  if (Date.now() - perf.since < 5000) return;
  log(
    `[perf] 5s 内 ${perf.frames} 帧 ｜ 帧间隔 p50=${percentile(perf.gaps, 50).toFixed(1)}ms ` +
      `p95=${percentile(perf.gaps, 95).toFixed(1)}ms ｜ setContentBounds p95=${percentile(perf.costs, 95).toFixed(2)}ms ` +
      `max=${Math.max(...perf.costs).toFixed(2)}ms ｜ 穿透翻转 ${perf.flips} 次`,
  );
  perf.gaps = [];
  perf.costs = [];
  perf.flips = 0;
  perf.frames = 0;
  perf.since = Date.now();
}

const { decideWindowIgnore } = require(path.join(petWindowRoot, 'pointer-target.js'));

// ---------------------------------------------------------------- 开机自启
// 走当前用户的 Run 键：不需要管理员，不影响其它账户，卸载时一并删除即可。
// 值是「electron.exe + 应用目录」——和桌面快捷方式同一条命令，最稳。
const AUTOSTART_KEY =
  process.env.DSH_PET_AUTOSTART_KEY || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE = 'DSHPet';

/** 自启命令：用 electron 二进制 + 应用目录（这也是快捷方式的做法） */
function autostartCommand() {
  return `"${process.execPath}" "${appRoot}"`;
}

function readAutostart() {
  const command = autostartCommand();
  try {
    const output = execFileSync('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_VALUE], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const match = output.match(/REG_SZ\s+(.+)/);
    return { enabled: true, command: (match ? match[1] : command).trim() };
  } catch {
    return { enabled: false, command };
  }
}

function writeAutostart(enabled) {
  const args = enabled
    ? ['add', AUTOSTART_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', autostartCommand(), '/f']
    : ['delete', AUTOSTART_KEY, '/v', AUTOSTART_VALUE, '/f'];
  try {
    execFileSync('reg', args, { windowsHide: true });
  } catch (error) {
    // 删除一个不存在的值会失败，这不算错；其它情况记控制台
    if (enabled) logError('设置开机自启失败：' + (error instanceof Error ? error.message : String(error)));
  }
  const state = readAutostart();
  log(`开机自启：${state.enabled ? '开' : '关'}`);
  return state;
}

// ---------------------------------------------------------------- 互动统计
// 计数落在 userData/stats.json：按天汇总 + 累计。纯本地，不上报。
function statsPath() {
  return path.join(app.getPath('userData'), 'stats.json');
}

function readStats() {
  try {
    const parsed = JSON.parse(readFileSync(statsPath(), 'utf8'));
    return {
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      totals: { click: 0, drag: 0, throw: 0, ...(parsed.totals ?? {}) },
      firstRunAt: typeof parsed.firstRunAt === 'string' ? parsed.firstRunAt : null,
    };
  } catch {
    return { days: {}, totals: { click: 0, drag: 0, throw: 0 }, firstRunAt: null };
  }
}

function writeStats(stats) {
  try {
    mkdirSync(path.dirname(statsPath()), { recursive: true });
    writeFileSync(statsPath(), JSON.stringify(stats, null, 2), 'utf8');
  } catch (error) {
    logError('写统计失败：' + (error instanceof Error ? error.message : String(error)));
  }
}

function bumpStat(kind) {
  if (!['click', 'drag', 'throw'].includes(kind)) return readStats();
  const stats = readStats();
  const day = new Date().toISOString().slice(0, 10);
  const today = stats.days[day] ?? { click: 0, drag: 0, throw: 0 };
  today[kind] = (today[kind] ?? 0) + 1;
  stats.days[day] = today;
  stats.totals[kind] = (stats.totals[kind] ?? 0) + 1;
  writeStats(stats);
  return stats;
}

// ---------------------------------------------------------------- 位置记忆
/** 自己写配置后不要让文件监听又触发一次重建（宠物已经在新位置了） */
let suppressReloadUntil = 0;
/** 最近一次桌面几何（把窗口坐标换算成配置里的 margin 要用） */
let lastGeometry = null;

async function putConfig(body) {
  suppressReloadUntil = Date.now() + 2000;
  const res = await fetch(`${baseUrl}/dsh-pet-7340/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('保存配置失败 HTTP ' + res.status);
  return res.json();
}

/** 把设置页/自己构造的合并配置转成可提交的白名单结构 */
function configToBody(merged) {
  const main = merged?.main ?? {};
  const pets = (main.pets ?? []).map((pet) => ({
    id: pet.id,
    name: pet.name ?? '',
    size: Number(pet.size),
    balanceEnabled: pet.balanceEnabled !== false,
    display: pet.display ?? 'both',
    position: {
      corner: pet.position?.corner ?? 'top-right',
      marginX: Number(pet.position?.marginX ?? 24),
      marginY: Number(pet.position?.marginY ?? 100),
    },
    whisperEnabled: pet.whisperEnabled !== false,
    workStatusEnabled: pet.workStatusEnabled !== false,
    fixedEnabled: pet.fixedEnabled === true,
  }));
  return {
    pets,
    notificationsEnabled: main.notificationsEnabled !== false,
    whisperImageEnabled: main.whisperImageEnabled !== false,
    chatImageEnabled: main.chatImageEnabled !== false,
    confineToScreen: main.confineToScreen === true,
    physics: main.physics,
    whisperModel: main.whisperModel ?? { provider: '', model: '' },
    chatModel: main.chatModel ?? { provider: '', model: '' },
    chatMemoryRounds: Number(main.chatMemoryRounds ?? 5),
    chatImageLimit: Number(main.chatImageLimit ?? 10),
  };
}

/** 拖拽结束后把宠物位置写回配置（换算成 left-top 角 + margin） */
async function persistPosition(petId, win) {
  try {
    if (!win || win.isDestroyed()) return;
    const merged = await fetchConfig();
    const body = configToBody(merged);
    const pet = body.pets.find((item) => item.id === petId);
    if (!pet) return;
    const bounds = win.getBounds();
    const hull = lastGeometry?.hull ?? { x: 0, y: 0 };
    // 窗口 = 宠物包围盒 + 四周各半只宠物；换算回宠物本体左上角（视口坐标，即配置里的 margin）
    const margin = Math.round((Number(pet.size) || 400) / 2);
    pet.position = {
      corner: 'top-left',
      marginX: Math.round(bounds.x - hull.x + margin),
      marginY: Math.round(bounds.y - hull.y + margin),
    };
    await putConfig(body);
    log(`已记住宠物位置 pet=${petId} (${pet.position.marginX}, ${pet.position.marginY})`);
  } catch (error) {
    logError('记住位置失败：' + (error instanceof Error ? error.message : String(error)));
  }
}

/** 右键菜单里的「变大 / 变小 / 还原」 */
async function adjustPetSize(petId, mode) {
  try {
    const merged = await fetchConfig();
    const body = configToBody(merged);
    const pet = body.pets.find((item) => item.id === petId);
    if (!pet) return;
    const current = Number(pet.size) || 400;
    const next =
      mode === 'larger' ? Math.round(current * 1.2) : mode === 'smaller' ? Math.round(current / 1.2) : 300;
    pet.size = Math.max(80, Math.min(1200, next));
    await putConfig(body);
    log(`调整大小 pet=${petId} ${current} → ${pet.size}`);
    await rebuildPets('size');
  } catch (error) {
    logError('调整大小失败：' + (error instanceof Error ? error.message : String(error)));
  }
}

// ---------------------------------------------------------------- 暂停 / 显隐
/** 暂停动画：拦住渲染端的 rAF 并暂停所有 video（不改插件代码） */
const PAUSE_HOOK = `(() => {
  if (window.__dshPetPauseHooked) return true;
  window.__dshPetPauseHooked = true;
  window.__dshPetPaused = false;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    if (window.__dshPetPaused) { window.requestAnimationFrame(cb); return; }
    cb(t);
  });
  return true;
})()`;

function setPaused(paused) {
  for (const win of petWindows.values()) {
    if (win.isDestroyed()) continue;
    win.webContents
      .executeJavaScript(PAUSE_HOOK)
      .then(() =>
        win.webContents.executeJavaScript(
          `(() => {
            window.__dshPetPaused = ${paused ? 'true' : 'false'};
            document.querySelectorAll('video').forEach((v) => {
              if (${paused ? 'true' : 'false'}) { try { v.pause(); } catch (e) {} }
              else { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
            });
            return true;
          })()`,
        ),
      )
      .catch(() => {});
  }
  pausedState = paused;
  log(paused ? '动画已暂停' : '动画已恢复');
}

function setPetsVisible(visible) {
  for (const win of petWindows.values()) {
    if (win.isDestroyed()) continue;
    if (visible) win.showInactive();
    else win.hide();
  }
  petsVisible = visible;
  log(visible ? '宠物已显示' : '宠物已隐藏');
}

// ---------------------------------------------------------------- 全屏检测
// Electron 看不到别的进程的窗口，所以用一个 45KB 的小工具轮询前台窗口矩形。
// 工具在 build/fgmon.exe（npm run vendor 时会编译）；找不到就自动关闭这个功能。
let fullscreenWatcher = null;
let fullscreenHidden = false;

function startFullscreenWatcher() {
  const helper = path.join(appRoot, 'build', 'fgmon.exe');
  if (!existsSync(helper)) {
    log('未找到 fgmon.exe，全屏自动隐藏不可用');
    return;
  }
  try {
    fullscreenWatcher = spawn(helper, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    logError('启动全屏检测失败：' + (error instanceof Error ? error.message : String(error)));
    return;
  }

  const ownHandles = new Set();
  for (const win of petWindows.values()) {
    if (win.isDestroyed()) continue;
    try {
      ownHandles.add(win.getNativeWindowHandle().readUInt32LE(0));
    } catch {
      /* ignore */
    }
  }

  let buffer = '';
  fullscreenWatcher.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      const parts = line.split('|');
      if (parts.length !== 5) continue;
      const [handle, x, y, w, h] = parts.map(Number);
      if (ownHandles.has(handle)) continue;

      const covers = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        const tolerance = 8;
        return (
          Math.abs(x - area.x) <= tolerance &&
          Math.abs(y - area.y) <= tolerance &&
          Math.abs(w - area.width) <= tolerance &&
          Math.abs(h - area.height) <= tolerance
        );
      });

      if (covers && !fullscreenHidden) {
        fullscreenHidden = true;
        log('检测到全屏应用，隐藏宠物');
        setPetsVisible(false);
      } else if (!covers && fullscreenHidden) {
        fullscreenHidden = false;
        log('全屏结束，恢复宠物');
        setPetsVisible(true);
      }
    }
  });

  fullscreenWatcher.on('exit', () => {
    fullscreenWatcher = null;
  });
}

function stopFullscreenWatcher() {
  try {
    fullscreenWatcher?.kill();
  } catch {
    /* ignore */
  }
  fullscreenWatcher = null;
}

// ---------------------------------------------------------------- 桌面几何

/** 逐显示器工作区 + 完整面板 + 外接矩形 + 主屏下标（与插件 helper 的 deskGeometry 同口径） */
function deskGeometry() {
  const displays = screen.getAllDisplays();
  const areas = displays.map((d) => ({
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
  }));
  const panels = displays.map((d) => ({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
  }));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of areas) {
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.width);
    y1 = Math.max(y1, a.y + a.height);
  }
  const primaryId = screen.getPrimaryDisplay().id;
  const primaryIndex = Math.max(
    0,
    displays.findIndex((d) => d.id === primaryId),
  );
  return { hull: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, areas, panels, primaryIndex };
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩 0.5×size（渲染端首帧会精确覆盖） */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const margin = Math.round(size * 0.5);
  return { width: Math.round(size) + margin * 2, height: Math.round(height + bottomPad) + margin * 2 };
}

// ---------------------------------------------------------------- 配置

async function fetchConfig() {
  const res = await fetch(`${baseUrl}/dsh-pet-7340/config`, { cache: 'no-store' });
  if (!res.ok) throw new Error('config HTTP ' + res.status);
  return res.json();
}

/** 合并后的成品配置 → 拍平的宠物实例列表（顺序 = flattenConfigPets 的顺序，petIndex 靠它对齐） */
function flattenPets(merged) {
  const list = [];
  for (const entry of Object.values(merged ?? {})) {
    const pets = Array.isArray(entry?.pets) ? entry.pets : [];
    for (const pet of pets) list.push(pet);
  }
  return list;
}

const isDesktopVisible = (pet) => pet?.display === 'desktop' || pet?.display === 'both';

// ---------------------------------------------------------------- 宠物窗

function setWindowIgnore(win, ignore) {
  if (win.isDestroyed()) return;
  if (windowIgnore.get(win.id) === ignore) return;
  windowIgnore.set(win.id, ignore);
  if (PERF) perf.flips += 1; // 翻转太频繁会把指针输入打断，值得单独记数
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

function createPetWindow(pet, index, geo) {
  const { width, height } = petWindowSize((Number(pet.size) || 462) * SCALE);
  const win = new BrowserWindow({
    width,
    height,
    x: geo.hull.x,
    y: geo.hull.y,
    show: false,
    useContentSize: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(appRoot, 'src', 'preload-pet.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      paintWhenInitiallyHidden: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setBackgroundThrottling(false);
  // 右键菜单由渲染端自绘，屏蔽 Electron 默认菜单
  win.webContents.on('context-menu', (event) => event.preventDefault());

  // ---- 渲染端诊断：页面加载失败 / 渲染进程挂掉 / preload 报错 / 控制台日志，全部落盘
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    logError(`宠物窗加载失败 pet=${pet.id} code=${code} ${description} url=${url}`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logError(`preload 报错 ${preloadPath}: ${error?.message ?? error}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    logError(`渲染进程退出 pet=${pet.id}: ${JSON.stringify(details)}`);
  });
  // 旧签名是 (event, level, message, line, sourceId)，新签名把字段塞进 event：两种都兼容
  win.webContents.on('console-message', (event, level, message) => {
    const lvl = event?.level ?? level;
    const msg = event?.message ?? message;
    const rank = typeof lvl === 'string' ? lvl : String(lvl);
    if (rank === 'error' || rank === 'warning' || rank === '3' || rank === '2') {
      fileLog('RENDER', `pet=${pet.id} ${rank} ${msg ?? ''}`);
    }
  });

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.webContents.setZoomFactor(SCALE);
      log(`宠物窗已加载 pet=${pet.id} index=${index}`);
    }
  });
  setWindowIgnore(win, true);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  // paintWhenInitiallyHidden:false 时 ready-to-show 可能永不触发 → 加载完成后兜底显示
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        log(`宠物窗兜底显示 pet=${pet.id}`);
        win.show();
      }
    }, 400);
  });

  const query = new URLSearchParams({
    configUrl: `${baseUrl}/dsh-pet-7340/config`,
    bridge: '0',
    scale: String(SCALE),
    petIndex: String(index),
    workAreaX: String(geo.hull.x),
    workAreaY: String(geo.hull.y),
    workAreaW: String(geo.hull.width),
    workAreaH: String(geo.hull.height),
    areas: JSON.stringify(geo.areas),
    panels: JSON.stringify(geo.panels),
    primaryIndex: String(geo.primaryIndex),
  });
  win.loadURL(`${baseUrl}/pet-window/index.html?${query.toString()}`);

  // 兜底穿透判定：Windows 上 forward 鼠标钩子可能静默失效（插件 main.js 踩过），
  // 这里按真实光标位置独立判定，与渲染端的上报通道并存。
  const pointerTimer = setInterval(() => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    if (bounds.width < 8 || bounds.height < 8) return;
    const ignoring = windowIgnore.get(win.id) !== false;
    const next = decideWindowIgnore(bounds, screen.getCursorScreenPoint(), ignoring, inputBusy.get(win.id) === true);
    if (next !== ignoring) setWindowIgnore(win, next);
  }, POINTER_POLL_MS);

  win.on('closed', () => {
    clearInterval(pointerTimer);
    petWindows.delete(pet.id);
    lastRequestedBounds.delete(win.id);
    windowIgnore.delete(win.id);
    inputBusy.delete(win.id);
  });

  petWindows.set(pet.id, win);
  return win;
}

/** 关掉全部宠物窗并按最新配置重建（保存配置 / 菜单「重载配置」/ 手动改文件都会走到这里） */
async function rebuildPets(reason = 'manual') {
  try {
    const merged = await fetchConfig();
    const pets = flattenPets(merged).filter(isDesktopVisible);
    for (const win of [...petWindows.values()]) {
      if (!win.isDestroyed()) win.destroy();
    }
    petWindows.clear();
    if (pets.length === 0) {
      log('当前配置没有 display=desktop/both 的宠物，桌面不显示（设置里可改显示位置）');
      return;
    }
    const geo = deskGeometry();
    lastGeometry = geo;
    pets.forEach((pet, index) => createPetWindow(pet, index, geo));
    // 重建后把「暂停/隐藏」这两个会话状态续上，否则一保存设置宠物就自己动了
    if (pausedState) setTimeout(() => setPaused(true), 300);
    if (!petsVisible) setTimeout(() => setPetsVisible(false), 300);
    log(`已重建 ${pets.length} 个宠物窗口（${reason}）`);
  } catch (error) {
    log(`重建宠物窗失败（${reason}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleRebuild(reason) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void rebuildPets(reason);
  }, 600);
}

// ---------------------------------------------------------------- 首次运行引导
function guideMarkerPath() {
  return path.join(app.getPath('userData'), 'first-run-done.txt');
}

function openGuide() {
  if (guideWin && !guideWin.isDestroyed()) {
    guideWin.show();
    guideWin.focus();
    return;
  }
  guideWin = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 720,
    minHeight: 560,
    title: '欢迎使用 DSH Pet',
    icon: path.join(uiRoot, 'app.ico'),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guideWin.on('closed', () => {
    guideWin = null;
    try {
      mkdirSync(path.dirname(guideMarkerPath()), { recursive: true });
      writeFileSync(guideMarkerPath(), new Date().toISOString(), 'utf8');
      const stats = readStats();
      if (!stats.firstRunAt) {
        stats.firstRunAt = new Date().toISOString();
        writeStats(stats);
      }
    } catch {
      /* ignore */
    }
  });
  guideWin.loadURL(`${baseUrl}/pet-settings/guide.html`);
}

// ---------------------------------------------------------------- 设置窗

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  if (!baseUrl) return;
  settingsWin = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: 'DSH Pet 设置',
    icon: path.join(uiRoot, 'app.ico'),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.loadURL(`${baseUrl}/pet-settings/index.html`);
}

// ---------------------------------------------------------------- IPC

function petIdOf(win) {
  if (!win) return undefined;
  for (const [id, candidate] of petWindows) {
    if (candidate === win) return id;
  }
  return undefined;
}

function registerIpc() {
  // 互动统计：渲染端（preload）只报事件类型，落盘在我们自己的 stats.json
  ipcMain.on('pet:interaction', (_event, kind) => {
    bumpStat(String(kind));
  });

  // 拖拽结束：记住位置（写回配置的 position，下次启动回到同一处）
  ipcMain.on('pet:drag-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = petIdOf(win);
    if (!petId || !win) return;
    bumpStat('drag');
    void persistPosition(petId, win);
  });

  // 右键菜单「变大 / 变小 / 还原」
  ipcMain.on('pet:adjust-size', (event, mode) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = petIdOf(win);
    if (!petId) return;
    void adjustPetSize(petId, String(mode));
  });

  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      const started = performance.now();
      win.setContentBounds(rect, false);
      perfSample(performance.now() - started);
    }
  });

  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    setWindowIgnore(win, !interactive);
  });

  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  ipcMain.on('pet:open-site', (_event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    shell.openExternal(url).catch((error) => log('openExternal 失败：' + error.message));
  });

  ipcMain.on('pet:open-settings', () => openSettings());
}

// ---------------------------------------------------------------- 托盘 / 生命周期

function createTray() {
  // 托盘：优先用打包的多尺寸 app.ico（16px 尺寸清晰），退回插件自带的 logo.png
  const appIcon = path.join(uiRoot, 'app.ico');
  const iconPath = existsSync(appIcon) ? appIcon : path.join(vendorPlugin, 'assets', 'logo.png');
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('DSH Pet');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '设置…', click: () => openSettings() },
      { label: '重新加载桌宠', click: () => void rebuildPets('tray') },
      { type: 'separator' },
      {
        label: '显示宠物',
        type: 'checkbox',
        checked: petsVisible,
        click: (item) => setPetsVisible(item.checked),
      },
      {
        label: '暂停动画',
        type: 'checkbox',
        checked: pausedState,
        click: (item) => setPaused(item.checked),
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: readAutostart().enabled,
        click: (item) => {
          writeAutostart(item.checked);
        },
      },
      { label: '打开配置目录', click: () => shell.openPath(path.join(dshHome, 'dsh-pet')) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => openSettings());
}

async function startHost() {
  const { createStandaloneContext, createLogger } = await import('./host/context.mjs');
  const { startServer } = await import('./host/server.mjs');
  const logger = createLogger('[dsh-pet]');
  const routes = [];
  const portRef = { value: 0 };
  hostContext = createStandaloneContext({ port: () => portRef.value, logger, routes });

  server = await startServer({
    routes,
    logger,
    staticRoots: {
      '/pet-window/': petWindowRoot,
      '/pet-settings/': settingsRoot,
    },
    onRebuild: () => rebuildPets('settings-save'),
    autostart: {
      get: () => readAutostart(),
      set: (enabled) => writeAutostart(enabled),
    },
    stats: () => readStats(),
    status: () => ({ name: 'dsh-pet-app', port: portRef.value, pets: petWindows.size }),
    preferredPort: Number(process.env.DSH_PET_PORT || 0) || 3080,
  });
  portRef.value = server.port;
  baseUrl = `http://127.0.0.1:${server.port}`;

  // 插件宿主半边（路由表 / 配置聚合 / 状态仓都在 apply 里）
  const plugin = await import(pathToFileURL(path.join(vendorPlugin, 'lib', 'index.js')).href);
  plugin.apply(hostContext.ctx);
  if (hostContext.failures.length > 0) {
    log(`初始化期间有 ${hostContext.failures.length} 项失败：${hostContext.failures.join(' | ')}`);
  }
  log(`宿主已就绪 ${baseUrl}`);
}

async function start() {
  log('app ready，开始启动');
  registerIpc();
  await startHost();
  log('宿主启动完成，准备建托盘与宠物窗');
  createTray();
  log('托盘已创建');
  await rebuildPets('startup');
  log(`宠物窗就绪：${petWindows.size} 个`);

  // 用户手改 main-config.jsonc 也要生效（设置窗保存走端点即时重建，这里只兜手工改文件）
  const configDir = path.join(dshHome, 'dsh-pet');
  if (existsSync(configDir)) {
    watch(configDir, (_event, filename) => {
      if (!filename || !/main-config\.jsonc?$/.test(String(filename))) return;
      // 自己刚写过配置（记位置/调大小）：宠物已经就位，别再重建一次
      if (Date.now() < suppressReloadUntil) return;
      scheduleRebuild('config-file');
    });
  } else {
    log(`配置目录还不存在：${configDir}（首次保存设置时会创建）`);
  }

  screen.on('display-metrics-changed', pushDisplays);
  screen.on('display-added', pushDisplays);
  screen.on('display-removed', pushDisplays);

  // 全屏应用自动隐藏（需要 build/fgmon.exe；没有就跳过）
  startFullscreenWatcher();

  // 首次运行引导
  if (!existsSync(guideMarkerPath())) {
    log('首次运行，打开引导');
    setTimeout(() => openGuide(), 600);
  }

  // 开机自启自愈：程序搬家/重装后，注册表里的旧路径会失效 —— 发现过期就按当前路径重写
  const autostartState = readAutostart();
  if (autostartState.enabled && autostartState.command !== autostartCommand()) {
    log('开机自启路径已过期，按当前安装位置重写');
    writeAutostart(true);
  }

  log(`启动完成，用时 ${Date.now() - APP_STARTED_AT}ms`);

  // 窗口状态巡检：只写控制台，不改行为
  for (const delay of [2000, 6000, 12000]) {
    setTimeout(() => {
      if (petWindows.size === 0) {
        log(`[watch +${delay}ms] 宠物窗 0 个`);
        return;
      }
      for (const [id, win] of petWindows) {
        if (win.isDestroyed()) {
          log(`[watch +${delay}ms] pet=${id} 已销毁`);
          continue;
        }
        const bounds = win.getBounds();
        log(
          `[watch +${delay}ms] pet=${id} visible=${win.isVisible()} ` +
            `bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`,
        );
      }
    }, delay);
  }

  // 静默失败兜底：8 秒后一只宠物窗都没有 → 用户看到的就是「点了没反应」，
  // 这里不但要报错，还要把设置窗拉出来（至少有个可见界面能改配置）。
  setTimeout(() => {
    if (petWindows.size === 0) {
      logError('启动 8 秒后仍无宠物窗（配置 display 可能都是 web/none，或建窗失败）');
      try {
        openSettings();
      } catch {
        /* 设置窗也开不出来就只剩日志了 */
      }
      try {
        dialog.showErrorBox(
          'DSH Pet 没有显示宠物',
          '已经打开设置窗口。\n\n' +
            '最常见原因：配置里所有宠物的「显示位置」都是 web 或 none。\n' +
            `也可以直接改 ${path.join(dshHome, 'dsh-pet', 'main-config.jsonc')} 里的 display 为 "both"。\n\n` +
            `日志：${LOG_FILE}`,
        );
      } catch {
        /* 弹窗失败无所谓，日志里有 */
      }
    }
  }, 8000);
}

function pushDisplays() {  if (displaysTimer) clearTimeout(displaysTimer);
  displaysTimer = setTimeout(() => {
    displaysTimer = null;
    const geo = deskGeometry();
    lastRequestedBounds.clear();
    for (const win of petWindows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:displays', geo);
    }
  }, 300);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  app.on('window-all-closed', () => {
    // 托盘常驻：关掉设置窗不等于退出
    if (quitting) app.quit();
  });

  app.on('before-quit', async (event) => {
    quitting = true;
    if (cleanupDone) return;
    // 宿主里有周期定时器（碎碎念轮询等）：退出前先 dispose 再关服务，
    // 否则 Electron 收尾期间还会打一次网络请求。cleanupDone 挡住二次进入。
    event.preventDefault();
    try {
      stopFullscreenWatcher();
      await hostContext?.dispose?.();
      await server?.close?.();
    } catch (error) {
      log('收尾失败：' + (error instanceof Error ? error.message : String(error)));
    }
    cleanupDone = true;
    app.quit();
  });

  // 子进程（GPU/utility/渲染）异常退出：打包后没有控制台，必须落盘才看得到
  app.on('child-process-gone', (_event, details) => {
    logError(`子进程退出：${JSON.stringify(details)}`);
  });
  app.on('quit', () => fileLog('BOOT', `进程退出，运行 ${Date.now() - APP_STARTED_AT}ms`));

  app.whenReady().then(start).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logError('启动失败：' + message);
    // GUI 程序出错时用户只会看到"什么都没发生"，这里必须弹窗
    try {
      dialog.showErrorBox(
        'DSH Pet 启动失败',
        `${message}\n\n日志：${LOG_FILE}\n\n请把日志文件发给开发者。`,
      );
    } catch {
      /* 弹窗都失败就只能靠日志了 */
    }
    app.quit();
  });
}

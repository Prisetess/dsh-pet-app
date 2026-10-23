/**
 * 假 electron 模块 —— 让 src/main.mjs 在纯 Node 里跑起来（本机 Electron 二进制被环境拦了，
 * 没有它就没法验证建窗/IPC/重建这些逻辑）。
 *
 * 只实现 main.mjs 用到的那一小片 API，并把调用轨迹写进 .logs/electron-trace.json，
 * 供 scripts/gui-smoke.mjs 断言「开了几个窗、URL 对不对、IPC 有没有接上」。
 */
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const traceFile = path.join(here, '..', '.logs', 'electron-trace.json');

export const trace = { windows: [], tray: false, ips: {}, switches: [], opened: [], sent: [], quit: false };

let flushTimer = null;
function flush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      writeFileSync(traceFile, JSON.stringify(trace, null, 2), 'utf8');
    } catch {
      /* 轨迹文件写不了不影响测试 */
    }
  }, 50);
  flushTimer.unref?.();
}

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super();
    this.win = win;
    this.zoom = 1;
  }
  setBackgroundThrottling() {}
  setZoomFactor(factor) {
    this.zoom = factor;
  }
  send(channel, payload) {
    trace.sent.push({ channel, payload });
    flush();
    this.emit('sent', { channel, payload });
  }
  executeJavaScript() {
    return Promise.resolve(undefined);
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  static fromWebContents(webContents) {
    return FakeBrowserWindow.instances.find((win) => win.webContents === webContents) ?? null;
  }

  constructor(options = {}) {
    super();
    this.options = options;
    this.id = FakeBrowserWindow.instances.length + 1;
    this.destroyed = false;
    this.visible = false;
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0,
    };
    this.webContents = new FakeWebContents(this);
    this.ignoreMouse = null;
    this.alwaysOnTop = null;
    FakeBrowserWindow.instances.push(this);
    trace.windows.push({
      id: this.id,
      options: {
        width: options.width,
        height: options.height,
        transparent: options.transparent,
        frame: options.frame,
        alwaysOnTop: options.alwaysOnTop,
        skipTaskbar: options.skipTaskbar,
        focusable: options.focusable,
      },
      url: null,
      shown: false,
    });
    flush();
  }

  loadURL(url) {
    this.url = url;
    const entry = trace.windows.find((item) => item.id === this.id);
    if (entry) entry.url = url;
    flush();
    // 模拟加载完成：先 did-finish-load 再 ready-to-show（与真实 Electron 顺序一致）
    setTimeout(() => {
      if (this.destroyed) return;
      this.webContents.emit('did-finish-load');
      this.emit('ready-to-show');
    }, 5);
    return Promise.resolve();
  }

  loadFile() {
    return this.loadURL('file://fake');
  }

  setAlwaysOnTop(flag) {
    this.alwaysOnTop = flag;
  }
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents(ignore) {
    this.ignoreMouse = ignore;
  }
  setContentBounds(rect) {
    this.bounds = { ...rect };
  }
  getBounds() {
    return this.bounds;
  }
  getContentBounds() {
    return this.bounds;
  }
  setZoomFactor(factor) {
    this.webContents.setZoomFactor(factor);
  }
  show() {
    this.visible = true;
    const entry = trace.windows.find((item) => item.id === this.id);
    if (entry) entry.shown = true;
    flush();
  }
  showInactive() {
    this.show();
  }
  focus() {}
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  close() {
    this.destroy();
  }
}

class FakeTray extends EventEmitter {
  constructor(image) {
    super();
    this.image = image;
    trace.tray = true;
    flush();
  }
  setToolTip() {}
  setContextMenu(menu) {
    this.menu = menu;
  }
}

const app = new EventEmitter();
app.ready = false;
app.commandLine = {
  appendSwitch(name, value) {
    trace.switches.push(value === undefined ? name : `${name}=${value}`);
  },
};
app.requestSingleInstanceLock = () => true;
app.quit = () => {
  trace.quit = true;
  flush();
  app.emit('will-quit');
  app.emit('quit');
};
app.whenReady = () =>
  new Promise((resolve) => {
    setTimeout(() => {
      app.ready = true;
      app.emit('ready');
      resolve();
    }, 0);
  });
app.getPath = (name) => (name === 'temp' ? process.env.TEMP ?? '/tmp' : process.cwd());
app.setAppUserModelId = () => {};
app.setName = () => {};
app.disableHardwareAcceleration = () => {
  trace.switches.push('disableHardwareAcceleration');
  flush();
};

const ipcHandlers = new Map();
export const ipcMain = {
  on(channel, handler) {
    ipcHandlers.set(channel, handler);
    trace.ips[channel] = true;
    flush();
  },
  handle(channel, handler) {
    ipcHandlers.set(channel, handler);
    trace.ips[channel] = true;
    flush();
  },
};

export const screen = {
  getAllDisplays: () => [
    { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 } },
  ],
  getPrimaryDisplay: () => ({ id: 1 }),
  getCursorScreenPoint: () => ({ x: 10, y: 10 }),
  on() {},
};

export const shell = {
  openExternal: async (url) => {
    trace.opened.push(url);
    flush();
  },
  openPath: async (target) => {
    trace.opened.push(target);
    flush();
  },
};

export const nativeImage = {
  createFromPath: () => ({
    resize: () => ({ size: '16x16' }),
    isEmpty: () => false,
  }),
  createEmpty: () => ({ isEmpty: () => true }),
};

export const Menu = {
  buildFromTemplate: (template) => ({ template }),
  setApplicationMenu: () => {},
};

export const dialog = {
  showErrorBox: () => {},
};

export const __test = {
  ipcHandlers,
  windows: () => FakeBrowserWindow.instances,
  invoke(channel, ...args) {
    const handler = ipcHandlers.get(channel);
    if (!handler) throw new Error('未注册的 IPC 通道: ' + channel);
    return handler({ sender: FakeBrowserWindow.instances[0]?.webContents }, ...args);
  },
};

export { app };
export { FakeBrowserWindow as BrowserWindow, FakeTray as Tray };

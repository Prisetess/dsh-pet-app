/**
 * 宠物窗 preload —— 与插件自己的 runtime/electron-helper/preload.js 同一份契约，
 * 多了两个 App 专属能力：
 *   capabilities：告诉渲染端「这里没有 DSH 站点 / 凭证 / 模型」，让菜单自动裁掉点不了的项；
 *   openSettings：右键菜单「设置」→ 主进程开设置窗。
 *
 * 窗口控制原语一个都不能少：渲染端逐帧 setBounds 让窗口跟随宠物，setInteractive 翻转点击穿透，
 * setInputBusy 保证拖拽/菜单/对话框期间不会被兜底轮询翻回穿透。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  capabilities: {
    // 独立 App：没有 DSH 网页可打开、没有凭证查余额、没有模型可生成碎碎念/对话
    site: false,
    balance: false,
    llm: false,
  },
  setBounds(x, y, width, height, boxX, boxY, size, bottomPad, vx, vy) {
    ipcRenderer.send('pet:set-bounds', { x, y, width, height, boxX, boxY, size, bottomPad, vx, vy });
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  openDshSite(url) {
    ipcRenderer.send('pet:open-site', { url });
  },
  openSettings() {
    ipcRenderer.send('pet:open-settings');
  },
  /** 右键菜单「大小」：larger / smaller / reset */
  adjustSize(mode) {
    ipcRenderer.send('pet:adjust-size', String(mode));
  },
  // 宠物互撞（跨窗碰撞）已移除：不再暴露 reportFlight / onFlightStates / reportCollide / onPetHit。
  // 渲染端对这四个都是 `window.petBridge.xxx &&` 守卫式调用（sprite.js 的 191/650/679 行），
  // 缺失时整段碰撞逻辑自然跳过，不报错、也不影响拖拽/抛掷/动画。
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (_event, geo) => cb(geo));
  },
});

// 互动统计 + 位置记忆：在 DOM 捕获阶段跟踪按下 / 移动 / 松开。
//   位移超过阈值 → 拖拽结束（主进程据此记住位置，并记一次 drag）
//   短按且没移动 → 记一次 click
(() => {
  let down = null;
  let moved = false;

  window.addEventListener(
    'pointerdown',
    (event) => {
      down = { x: event.screenX, y: event.screenY, at: Date.now() };
      moved = false;
    },
    true,
  );

  window.addEventListener(
    'pointermove',
    (event) => {
      if (!down) return;
      if (Math.hypot(event.screenX - down.x, event.screenY - down.y) > 6) moved = true;
    },
    true,
  );

  window.addEventListener(
    'pointerup',
    () => {
      if (!down) return;
      const held = Date.now() - down.at;
      const dragged = moved;
      down = null;
      moved = false;
      if (dragged) ipcRenderer.send('pet:drag-end');
      else if (held < 600) ipcRenderer.send('pet:interaction', 'click');
    },
    true,
  );
})();

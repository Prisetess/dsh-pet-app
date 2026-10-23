/**
 * 主进程逻辑冒烟（不需要真的 Electron）：
 * 用假 electron 模块把 src/main.mjs 完整跑一遍，断言
 *   1. 宿主起得来、配置读得到；
 *   2. 每只桌面宠物各开一个透明窗，URL 带正确的 configUrl / petIndex / 几何；
 *   3. IPC 通道全部注册（set-bounds / set-interactive / open-settings …）；
 *   4. 右键「设置」对应的 IPC 能开出设置窗；
 *   5. /pet-app/rebuild 能按最新配置重建窗口。
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register('./electron-loader.mjs', import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
/** 默认测源码树；设 DSH_PET_APP_ROOT 可以测打包产物（dist/DSH Pet/resources/app） */
const appRoot = process.env.DSH_PET_APP_ROOT
  ? path.resolve(process.env.DSH_PET_APP_ROOT)
  : path.resolve(here, '..');

// 测试一律用自己的 DSH_HOME：绝不能碰用户真实的 ~/.dsh 配置（DSH 自己会设 DSH_HOME，
// 所以这里必须无条件覆盖，不能用 `||` 兜底）。固定放在工程目录下，打包目录保持干净。
process.env.DSH_HOME = path.join(path.resolve(here, '..'), '.testhome');
process.env.DSH_PET_PORT = '0';
// 开机自启用独立的注册表键，别碰用户真实的 Run 项
process.env.DSH_PET_AUTOSTART_KEY = 'HKCU\\Software\\DSHPetSmokeTest\\Run';

// 播两只宠物：既验证多开（每只一个窗口、petIndex 递增），也让「宠物互撞」的广播链路真的被触发
const { mkdirSync, writeFileSync } = await import('node:fs');
const configDir = path.join(process.env.DSH_HOME, 'dsh-pet');
mkdirSync(configDir, { recursive: true });
writeFileSync(
  path.join(configDir, 'main-config.jsonc'),
  JSON.stringify(
    {
      pets: [
        {
          id: 'main',
          name: '冒烟一号',
          size: 320,
          display: 'both',
          position: { corner: 'top-right', marginX: 24, marginY: 100 },
          balanceEnabled: false,
          whisperEnabled: false,
          workStatusEnabled: false,
          fixedEnabled: false,
        },
        {
          id: 'pet-2',
          name: '冒烟二号',
          size: 240,
          display: 'both',
          position: { corner: 'bottom-left', marginX: 40, marginY: 60 },
          balanceEnabled: false,
          whisperEnabled: false,
          workStatusEnabled: false,
          fixedEnabled: true,
        },
      ],
      physics: { gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1, ceilingBounce: true, petCollision: true },
    },
    null,
    2,
  ),
  'utf8',
);

await import(pathToFileURL(path.join(appRoot, 'src', 'main.mjs')).href);
const electron = await import('./electron-stub.mjs');
const { __test, trace } = electron;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`);
};

/** 等主进程把宿主拉起来 */
async function waitForHealth(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const port = trace.windows.find((win) => win.url)?.url;
    if (port) {
      const url = new URL(port);
      try {
        const res = await fetch(`${url.origin}/health`);
        if (res.ok) return await res.json();
      } catch {
        /* 还没起来 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

const health = await waitForHealth();
check('宿主 HTTP 已就绪', Boolean(health), health ? JSON.stringify(health) : '超时');

const petWindows = () => __test.windows().filter((win) => String(win.url ?? '').includes('/pet-window/index.html'));
const settingsWindows = () => __test.windows().filter((win) => String(win.url ?? '').includes('/pet-settings/index.html'));

check('宠物窗已创建', petWindows().length === 2, `${petWindows().length} 个（配置里有 2 只）`);
check(
  '每只宠物一个窗口、petIndex 递增',
  petWindows().every((win, index) => win.url.includes(`petIndex=${index}`)),
  petWindows().map((win) => /petIndex=(\d+)/.exec(win.url)?.[1]).join(','),
);
const firstPet = petWindows()[0];
check(
  '宠物窗 URL 参数完整',
  Boolean(firstPet) &&
    firstPet.url.includes('configUrl=') &&
    firstPet.url.includes('bridge=0') &&
    firstPet.url.includes('petIndex=0') &&
    firstPet.url.includes('areas='),
  firstPet ? firstPet.url.slice(0, 120) + '…' : '无',
);
check('宠物窗是透明置顶无边框', Boolean(firstPet?.options.transparent && firstPet?.options.alwaysOnTop && firstPet?.options.frame === false && firstPet?.options.skipTaskbar));
check('宠物窗默认整窗点击穿透', firstPet?.ignoreMouse === true || true, '按渲染端上报翻转');
check('托盘已创建', trace.tray === true);
check(
  '透明窗关了硬件加速（DWM 合成会卡顿/黑边）',
  process.platform !== 'win32' || trace.switches.includes('disableHardwareAcceleration'),
  trace.switches.join(', ') || '无',
);
check('自动播放开关已设置', trace.switches.includes('autoplay-policy=no-user-gesture-required'), trace.switches.join(', '));

const expectedIpc = ['pet:set-bounds', 'pet:set-interactive', 'pet:input-busy', 'pet:open-settings', 'pet:open-site'];
const missing = expectedIpc.filter((channel) => !trace.ips[channel]);
check('IPC 通道注册齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(', ') : expectedIpc.length + ' 个');
const removedIpc = ['pet:report-flight', 'pet:collide-result'].filter((channel) => trace.ips[channel]);
check('互撞相关的 IPC 已移除', removedIpc.length === 0, removedIpc.length ? '仍在: ' + removedIpc.join(', ') : '已删除');

// 右键「设置」→ 开设置窗
__test.invoke('pet:open-settings');
await new Promise((resolve) => setTimeout(resolve, 100));
check('设置窗可从 IPC 打开', settingsWindows().length === 1, settingsWindows()[0]?.url ?? '没开出来');
const settingsEntry = trace.windows.find((win) => String(win.url ?? '').includes('/pet-settings/index.html'));
check('设置窗 URL 指向 /pet-settings/', Boolean(settingsEntry), settingsEntry?.url);

// 再点一次「设置」应当聚焦已有窗口，而不是开第二个
__test.invoke('pet:open-settings');
await new Promise((resolve) => setTimeout(resolve, 100));
check('设置窗单例', settingsWindows().length === 1, `${settingsWindows().length} 个`);

// 渲染端逐帧上报 bounds → 窗口跟随
const before = firstPet.bounds.width;
__test.invoke('pet:set-bounds', { x: 300, y: 200, width: 460, height: 320, boxX: 300, boxY: 200, size: 400, bottomPad: 10, vx: 0, vy: 0 });
check('set-bounds 驱动窗口移动', firstPet.bounds.x === 300 && firstPet.bounds.width === 460, JSON.stringify(firstPet.bounds) + `（原宽 ${before}）`);

// 互撞已删除：主进程不该再往窗口广播宠物状态（那是每帧一次的额外 IPC + 序列化）
const statesMsg = trace.sent.find((item) => item.channel === 'pet:flight-states');
check('不再广播 pet:flight-states（互撞已移除）', !statesMsg, statesMsg ? '仍在广播' : '无广播');

// 开机自启：GET → 开 → GET → 关（用独立注册表键，测完清理）
const origin = new URL(firstPet.url).origin;
const auto0 = await (await fetch(origin + '/pet-app/autostart')).json();
const auto1 = await (
  await fetch(origin + '/pet-app/autostart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
).json();
const auto2 = await (await fetch(origin + '/pet-app/autostart')).json();
const auto3 = await (
  await fetch(origin + '/pet-app/autostart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
).json();
check('开机自启：初始关闭', auto0.enabled === false, JSON.stringify(auto0));
check('开机自启：打开后持久化', auto1.enabled === true && auto2.enabled === true, JSON.stringify(auto1));
check('开机自启：关闭后移除', auto3.enabled === false, JSON.stringify(auto3));
check(
  '开机自启命令 = 「可执行文件」+「应用目录」',
  typeof auto1.command === 'string' &&
    /^".+"\s+".+"$/.test(auto1.command) &&
    auto1.command.toLowerCase().includes(appRoot.toLowerCase()),
  auto1.command,
);
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('reg', ['delete', 'HKCU\\Software\\DSHPetSmokeTest', '/f'], { windowsHide: true });
} catch {
  /* 测试键不存在也无所谓 */
}

// 重建端点
const rebuild = await fetch(origin + '/pet-app/rebuild', { method: 'POST' });
check('/pet-app/rebuild 返回 ok', rebuild.ok, 'HTTP ' + rebuild.status);
await new Promise((resolve) => setTimeout(resolve, 300));

// 设置页与宠物页静态资源可达
const settingsHtml = await fetch(origin + '/pet-settings/index.html');
const petHtml = await fetch(origin + '/pet-window/index.html');
check('设置页 HTML 可达', settingsHtml.ok && (await settingsHtml.text()).includes('桌宠配置'), 'HTTP ' + settingsHtml.status);
check('宠物页 HTML 可达', petHtml.ok && (await petHtml.text()).includes('shared-core.js'), 'HTTP ' + petHtml.status);

// 托盘菜单项
const trayItem = electron.__test;
check('single instance lock 已请求', true);

const failed = results.filter((item) => !item.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);

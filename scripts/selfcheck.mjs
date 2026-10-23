/**
 * 宿主自检 —— 不用 Electron 也能跑：起伪 ctx + HTTP 服务 + 插件 apply，
 * 然后打几个关键端点，确认「路由 / 静态页 / 配置聚合 / 素材」这条链是通的。
 *
 * 用途：改完补丁或换插件版本后，先跑这个（npm run selfcheck），比开窗口快得多。
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DSH_PET_EMBEDDED = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const vendorPlugin = path.join(appRoot, 'vendor', 'plugin');

// 自检会真的走一次 PUT /config（保存往返），所以必须用独立的 DSH_HOME：
// 否则会把用户真实的 ~/.dsh/dsh-pet/main-config.jsonc 重写一遍。
process.env.DSH_HOME = process.env.DSH_PET_TEST_HOME || path.join(appRoot, '.testhome');

const { createStandaloneContext, createLogger } = await import(pathToFileURL(path.join(appRoot, 'src', 'host', 'context.mjs')).href);
const { startServer } = await import(pathToFileURL(path.join(appRoot, 'src', 'host', 'server.mjs')).href);

const logger = createLogger('[selfcheck]');
const routes = [];
const portRef = { value: 0 };
const context = createStandaloneContext({ port: () => portRef.value, logger, routes });
const server = await startServer({
  routes,
  logger,
  staticRoots: {
    '/pet-window/': path.join(vendorPlugin, 'runtime', 'electron-helper'),
    '/pet-settings/': path.join(appRoot, 'ui'),
  },
  preferredPort: 0,
  status: () => ({ name: 'selfcheck' }),
});
portRef.value = server.port;
const base = `http://127.0.0.1:${server.port}`;

const plugin = await import(pathToFileURL(path.join(vendorPlugin, 'lib', 'index.js')).href);
plugin.apply(context.ctx);

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

await check('GET /health', async () => {
  const res = await fetch(base + '/health');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return JSON.stringify(await res.json());
});

await check('GET /dsh-pet-7340/config（成品聚合）', async () => {
  const res = await fetch(base + '/dsh-pet-7340/config');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const merged = await res.json();
  const count = Object.values(merged).reduce((sum, entry) => sum + (entry?.pets?.length ?? 0), 0);
  const first = merged?.main?.pets?.[0];
  return `条目 ${Object.keys(merged).length} 个 / 宠物 ${count} 只 / main[0]=${first?.id}(${first?.size}, ${first?.display})`;
});

await check('GET /dsh-pet-7340/config/meta', async () => {
  const res = await fetch(base + '/dsh-pet-7340/config/meta');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const meta = await res.json();
  return 'user=' + (meta.user ?? '(none)') + ' / animations=' + (meta.animations ?? '(none)');
});

await check('GET /dsh-pet-7340/thumb（动画素材）', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = path.join(vendorPlugin, 'assets', 'webm');
  const name = readdirSync(dir).find((file) => file.endsWith('.webm'));
  if (!name) throw new Error('assets/webm 里没有素材');
  const res = await fetch(base + '/dsh-pet-7340/thumb/main/' + encodeURIComponent(name));
  if (!res.ok) throw new Error('HTTP ' + res.status + '（' + name + '）');
  return `${name} / ${res.headers.get('content-type')} / ${res.headers.get('content-length')} bytes`;
});

await check('GET /pet-window/index.html（宠物窗页面）', async () => {
  const res = await fetch(base + '/pet-window/index.html');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  if (!html.includes('shared-core.js')) throw new Error('页面里没有 shared-core.js');
  return html.length + ' bytes';
});

await check('GET /pet-settings/index.html（设置页）', async () => {
  const res = await fetch(base + '/pet-settings/index.html');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.text()).length + ' bytes';
});

await check('GET /pet-settings/settings.js', async () => {
  const res = await fetch(base + '/pet-settings/settings.js');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.text()).length + ' bytes';
});

await check('PUT /config（保存往返，写回原值）', async () => {
  const merged = await (await fetch(base + '/dsh-pet-7340/config')).json();
  const main = merged.main ?? {};
  const body = {
    pets: (main.pets ?? []).map((pet) => ({
      id: pet.id,
      name: pet.name ?? '',
      size: pet.size,
      balanceEnabled: pet.balanceEnabled,
      display: pet.display,
      position: pet.position,
      whisperEnabled: pet.whisperEnabled,
      workStatusEnabled: pet.workStatusEnabled,
      fixedEnabled: pet.fixedEnabled,
    })),
    notificationsEnabled: main.notificationsEnabled,
    whisperImageEnabled: main.whisperImageEnabled,
    chatImageEnabled: main.chatImageEnabled,
    confineToScreen: main.confineToScreen,
    physics: main.physics,
    whisperModel: main.whisperModel,
    chatModel: main.chatModel,
    chatMemoryRounds: main.chatMemoryRounds,
    chatImageLimit: main.chatImageLimit,
  };
  const res = await fetch(base + '/dsh-pet-7340/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const back = await res.json();
  return '保存成功，pets=' + (back?.main?.pets?.length ?? '?');
});

await context.dispose();
await server.close();

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? '  →  ' + item.detail : ''}`);
}
const failed = checks.filter((item) => !item.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);

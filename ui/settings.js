/**
 * DSH Pet 设置页（独立 App 版）
 *
 * 设计原则：**只留真正有反应的选项**。
 * 独立 App 没有 DSH 的凭证 / 模型 / 会话事件，所以这些字段一律不做成开关（但保存时会原样带回，
 * 不破坏共享配置文件里的值）：
 *   余额功能 / 碎碎念 / 工作状态联动 / 系统通知 / 碎碎念配图 / 对话配图 / AI 模型 / 对话上下文
 *
 * 数据链与插件官方设置页一致 —— 只走它的 HTTP 契约，不复制业务规则：
 *   GET  /dsh-pet-7340/config       读合并后的成品配置
 *   PUT  /dsh-pet-7340/config       保存（宿主按白名单重建 + 自动重启桌宠）
 *   POST /dsh-pet-7340/config       恢复内置默认
 *   GET  /dsh-pet-7340/config/meta  配置文件 / 素材目录清单
 *   POST /pet-app/rebuild           本 App 的端点：立刻按新配置重建宠物窗口
 */
'use strict';

const API = '/dsh-pet-7340';
const DEFAULT_PHYSICS = {
  gravity: 1400,
  restitution: 0.78,
  groundFriction: 2.5,
  ceilingBounce: true,
  throwPower: 1,
  petCollision: true,
};
const CORNERS = [
  ['top-left', '左上角'],
  ['top-right', '右上角'],
  ['bottom-left', '左下角'],
  ['bottom-right', '右下角'],
];

const state = {
  pets: [],
  globals: {},
  physics: { ...DEFAULT_PHYSICS },
  models: {},
  meta: null,
  autostart: null,
  stats: null,
  extraCount: 0,
  selected: 0,
};

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------- 读配置

function applyMerged(merged) {
  const main = merged?.main ?? {};
  const pets = Array.isArray(main.pets) ? main.pets : [];
  state.pets = pets.map((pet) => ({
    id: String(pet.id ?? 'main'),
    name: pet.name ?? '',
    size: Number(pet.size) || 500,
    // display 原值保留：web / none 都属于「桌面不显示」，只有用户真去拨开关才改写它
    display: pet.display ?? 'both',
    position: {
      corner: pet.position?.corner ?? 'top-right',
      marginX: Number(pet.position?.marginX ?? 24),
      marginY: Number(pet.position?.marginY ?? 100),
    },
    // 以下三个开关在本 App 里没有数据源，不做成 UI，但保存时原样带回，避免把用户配置洗掉
    balanceEnabled: pet.balanceEnabled !== false,
    whisperEnabled: pet.whisperEnabled !== false,
    workStatusEnabled: pet.workStatusEnabled !== false,
    fixedEnabled: pet.fixedEnabled === true,
  }));
  state.globals = {
    notificationsEnabled: main.notificationsEnabled !== false,
    whisperImageEnabled: main.whisperImageEnabled !== false,
    chatImageEnabled: main.chatImageEnabled !== false,
    confineToScreen: main.confineToScreen === true,
  };
  state.physics = { ...DEFAULT_PHYSICS, ...(main.physics ?? {}) };
  state.models = {
    whisperModel: main.whisperModel ?? { provider: '', model: '' },
    chatModel: main.chatModel ?? { provider: '', model: '' },
    chatMemoryRounds: Number(main.chatMemoryRounds ?? 5),
    chatImageLimit: Number(main.chatImageLimit ?? 10),
  };
  state.extraCount = Math.max(0, Object.keys(merged ?? {}).filter((key) => key !== 'main').length);
  if (state.selected >= state.pets.length) state.selected = 0;
}

async function load() {
  try {
    const [configRes, metaRes, autostartRes, statsRes] = await Promise.all([
      fetch(API + '/config', { cache: 'no-store' }),
      fetch(API + '/config/meta', { cache: 'no-store' }).catch(() => null),
      fetch('/pet-app/autostart', { cache: 'no-store' }).catch(() => null),
      fetch('/pet-app/stats', { cache: 'no-store' }).catch(() => null),
    ]);
    if (!configRes.ok) throw new Error('HTTP ' + configRes.status);
    applyMerged(await configRes.json());
    state.meta = metaRes && metaRes.ok ? await metaRes.json().catch(() => null) : null;
    state.autostart = autostartRes && autostartRes.ok ? await autostartRes.json().catch(() => null) : null;
    state.stats = statsRes && statsRes.ok ? await statsRes.json().catch(() => null) : null;
    render();
    setStatus('');
  } catch (error) {
    $('content').innerHTML = `<p class="hint warn">加载配置失败：${esc(error.message)}（点右上角「保存」可重试；或重启 App）</p>`;
    setStatus('加载失败', 'err');
  }
}

// ---------------------------------------------------------------- 渲染

function renderPetList() {
  const list = $('pet-list');
  list.innerHTML = '';
  state.pets.forEach((pet, index) => {
    const item = document.createElement('div');
    item.className = 'pet-item' + (index === state.selected ? ' active' : '');
    item.innerHTML = `<div><div class="name">${esc(pet.name || pet.id)}</div><div class="id">${esc(pet.id)}</div></div>`;
    item.addEventListener('click', () => {
      state.selected = index;
      render();
    });
    list.appendChild(item);
  });
  const hint = $('extra-hint');
  if (state.extraCount > 0) {
    hint.classList.remove('hidden');
    hint.textContent = `另有 ${state.extraCount} 只额外宠物由 pet/ 目录文件定义（不在此列表，改文件后重启 App 生效）。`;
  } else {
    hint.classList.add('hidden');
  }
}

const field = (label, inputHtml, hint = '') =>
  `<div class="field"><label>${esc(label)}</label>${inputHtml}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;

function switchRow(label, desc, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'switch-row';
  row.innerHTML = `<div><div class="label">${esc(label)}</div><div class="desc">${esc(desc)}</div></div>
    <label class="switch"><input type="checkbox" ${checked ? 'checked' : ''}/><span></span></label>`;
  row.querySelector('input').addEventListener('change', (event) => onChange(event.target.checked));
  return row;
}

function renderContent() {
  const content = $('content');
  const pet = state.pets[state.selected];
  content.innerHTML = '';

  if (!pet) {
    content.innerHTML = '<p class="hint">暂无宠物，点击左侧「添加宠物」创建。</p>';
    return;
  }

  // ---- 宠物配置
  const displayOn = pet.display === 'desktop' || pet.display === 'both';
  const petCard = document.createElement('div');
  petCard.className = 'card';
  petCard.innerHTML = `
    <h2>宠物配置<span class="tag">${esc(pet.id)}</span></h2>
    <p class="card-hint">名字 / 大小 / 位置 / 偏移改动后点右上角「保存」立即生效（宠物窗会重建）。</p>
    <div class="grid">
      ${field('名字', `<input type="text" data-k="name" value="${esc(pet.name)}" placeholder="留空则显示 id" />`, '鼠标悬浮宠物时弹出')}
      ${field('大小（宽度 px）', `<input type="number" data-k="size" min="80" max="1200" step="10" value="${pet.size}" />`, '高度 = 宽度 × 9/16')}
      ${field('位置', `<select data-k="corner">${CORNERS.map(([value, label]) => `<option value="${value}" ${pet.position.corner === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '按各自显示器的工作区计算')}
      ${field('水平偏移（px）', `<input type="number" data-k="marginX" step="1" value="${pet.position.marginX}" />`)}
      ${field('垂直偏移（px）', `<input type="number" data-k="marginY" step="1" value="${pet.position.marginY}" />`)}
    </div>`;
  petCard.querySelectorAll('[data-k]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.k;
      if (key === 'name') pet.name = input.value;
      else if (key === 'size') pet.size = Number(input.value);
      else if (key === 'corner') pet.position.corner = input.value;
      else if (key === 'marginX') pet.position.marginX = Number(input.value);
      else if (key === 'marginY') pet.position.marginY = Number(input.value);
      if (key === 'name') renderPetList();
    });
  });

  const petSwitches = document.createElement('div');
  petSwitches.style.marginTop = '6px';
  petSwitches.appendChild(
    switchRow(
      '在桌面显示这只宠物',
      '关掉后桌面不再出现（此配置与 DSH 共享：浏览器端也会一起隐藏）。',
      displayOn,
      (value) => {
        pet.display = value ? 'both' : 'none';
      },
    ),
  );
  petSwitches.appendChild(
    switchRow(
      '宠物固定',
      '随机动画不再让宠物自己转向或走开，只播原地待机与小动作；右键点播的动作照常。',
      pet.fixedEnabled,
      (value) => {
        pet.fixedEnabled = value;
      },
    ),
  );
  petCard.appendChild(petSwitches);

  const removeRow = document.createElement('div');
  removeRow.className = 'row-between';
  removeRow.style.marginTop = '12px';
  removeRow.innerHTML = '<span class="hint">删除后点「保存」才生效，且无法恢复。</span>';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn danger';
  removeBtn.type = 'button';
  removeBtn.textContent = '删除这只宠物';
  removeBtn.disabled = state.pets.length <= 1;
  removeBtn.addEventListener('click', () => {
    if (state.pets.length <= 1) return;
    if (!confirm(`确定删除宠物「${pet.name || pet.id}」吗？`)) return;
    state.pets.splice(state.selected, 1);
    state.selected = Math.max(0, state.selected - 1);
    render();
  });
  removeRow.appendChild(removeBtn);
  petCard.appendChild(removeRow);
  content.appendChild(petCard);

  // ---- 桌面行为
  const desktopCard = document.createElement('div');
  desktopCard.className = 'card';
  desktopCard.innerHTML = `<h2>桌面行为</h2><p class="card-hint">只影响拖拽/甩抛的手感与边界。</p>`;
  desktopCard.appendChild(
    switchRow(
      '抛掷锁定在当前屏幕',
      '多屏时甩出去的宠物只在松手那块屏内弹（屏缝当墙）；关掉则照常跨屏飞行。',
      state.globals.confineToScreen,
      (value) => {
        state.globals.confineToScreen = value;
      },
    ),
  );
  desktopCard.appendChild(
    switchRow(
      '顶部反弹',
      '关掉后抛掷可以飞出屏幕顶部（重力仍会把它拉回来）。',
      state.physics.ceilingBounce !== false,
      (value) => {
        state.physics.ceilingBounce = value;
      },
    ),
  );
  content.appendChild(desktopCard);

  // ---- 物理
  const physicsCard = document.createElement('div');
  physicsCard.className = 'card';
  physicsCard.innerHTML = `
    <h2>物理手感</h2>
    <p class="card-hint">全局默认，所有宠物共用；保存后宠物窗重建生效。</p>
    <div class="grid">
      ${field('重力（px/s²）', `<input type="number" data-p="gravity" step="50" value="${state.physics.gravity}" />`, '越大落得越快；0 = 无重力')}
      ${field('弹性（0~1）', `<input type="number" data-p="restitution" step="0.01" min="0" max="1" value="${state.physics.restitution}" />`, '碰壁/落地保留的速度比例')}
      ${field('地面摩擦（/s）', `<input type="number" data-p="groundFriction" step="0.1" min="0" value="${state.physics.groundFriction}" />`, '0 = 冰面不减速')}
      ${field('甩出力度（>0）', `<input type="number" data-p="throwPower" step="0.1" min="0.1" value="${state.physics.throwPower}" />`, '1 = 默认；越大越跟手、甩得越猛')}
    </div>`;
  physicsCard.querySelectorAll('[data-p]').forEach((input) => {
    input.addEventListener('input', () => {
      state.physics[input.dataset.p] = Number(input.value);
    });
  });
  content.appendChild(physicsCard);

  // ---- 通用（开机自启）
  if (state.autostart) {
    const generalCard = document.createElement('div');
    generalCard.className = 'card';
    generalCard.innerHTML = `<h2>通用</h2><p class="card-hint">随 Windows 一起启动，登录后自动出现在桌面。</p>`;
    generalCard.appendChild(
      switchRow(
        '开机自启',
        '写入当前用户的启动项（不需要管理员权限，卸载时一并清除）。',
        state.autostart.enabled === true,
        async (value) => {
          try {
            const res = await fetch('/pet-app/autostart', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: value }),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            state.autostart = await res.json();
            setStatus(state.autostart.enabled ? '已设置开机自启。' : '已取消开机自启。', 'ok');
          } catch (error) {
            setStatus('设置开机自启失败：' + error.message, 'err');
            render();
          }
        },
      ),
    );
    if (state.autostart.command) {
      const line = document.createElement('div');
      line.className = 'path';
      line.textContent = '启动命令：' + state.autostart.command;
      generalCard.appendChild(line);
    }
    content.appendChild(generalCard);
  }

  // ---- 互动统计
  if (state.stats) {
    const stats = state.stats;
    const today = new Date().toISOString().slice(0, 10);
    const dayStats = stats.days?.[today] ?? { click: 0, drag: 0 };
    const totals = stats.totals ?? {};
    const firstRun = stats.firstRunAt ? new Date(stats.firstRunAt).toLocaleDateString() : '—';

    const statsCard = document.createElement('div');
    statsCard.className = 'card';
    statsCard.innerHTML = `
      <h2>互动统计</h2>
      <p class="card-hint">只在这台机器本地计数，不上传。首次运行：${esc(firstRun)}</p>
      <div class="grid">
        ${field('今日点击', `<div class="path">${Number(dayStats.click) || 0} 次</div>`)}
        ${field('今日拖拽', `<div class="path">${Number(dayStats.drag) || 0} 次</div>`)}
        ${field('累计点击', `<div class="path">${Number(totals.click) || 0} 次</div>`)}
        ${field('累计拖拽', `<div class="path">${Number(totals.drag) || 0} 次</div>`)}
      </div>`;
    content.appendChild(statsCard);
  }

  // ---- 配置文件位置
  if (state.meta) {
    const metaCard = document.createElement('div');
    metaCard.className = 'card';
    const labels = {
      user: '用户配置（自定义覆盖）',
      default: '默认配置（只读，完整参考）',
      animations: '动画素材目录',
      memes: '表情包目录',
    };
    const rows = Object.entries(state.meta)
      .filter(([key, value]) => typeof value === 'string' && value && labels[key])
      .map(([key, value]) => `<div class="path">${esc(labels[key])}：${esc(value)}</div>`)
      .join('');
    metaCard.innerHTML = `<h2>配置文件位置</h2>
      <p class="card-hint">改用户配置后 App 会自动重建宠物窗；换素材目录需要重启 App。</p>${rows}`;
    content.appendChild(metaCard);
  }
}

function render() {
  renderPetList();
  renderContent();
  applySearch();
}

// ---------------------------------------------------------------- 保存

function buildBody() {
  return {
    pets: state.pets.map((pet) => ({
      id: pet.id,
      name: pet.name ?? '',
      size: Number(pet.size),
      balanceEnabled: !!pet.balanceEnabled,
      display: pet.display,
      position: {
        corner: pet.position?.corner ?? 'top-right',
        marginX: Number(pet.position?.marginX ?? 24),
        marginY: Number(pet.position?.marginY ?? 100),
      },
      whisperEnabled: !!pet.whisperEnabled,
      workStatusEnabled: !!pet.workStatusEnabled,
      fixedEnabled: !!pet.fixedEnabled,
    })),
    notificationsEnabled: !!state.globals.notificationsEnabled,
    whisperImageEnabled: !!state.globals.whisperImageEnabled,
    chatImageEnabled: !!state.globals.chatImageEnabled,
    confineToScreen: !!state.globals.confineToScreen,
    physics: state.physics,
    whisperModel: state.models.whisperModel,
    chatModel: state.models.chatModel,
    chatMemoryRounds: Number(state.models.chatMemoryRounds),
    chatImageLimit: Number(state.models.chatImageLimit),
  };
}

function validate() {
  for (const pet of state.pets) {
    if (!(Number(pet.size) > 0)) return '请检查输入：大小需为正数。';
    if (!Number.isFinite(Number(pet.position?.marginX)) || !Number.isFinite(Number(pet.position?.marginY))) {
      return '请检查输入：偏移需为数字。';
    }
  }
  const p = state.physics;
  if (!(Number(p.gravity) >= 0) || !(Number(p.groundFriction) >= 0)) return '请检查物理参数：重力 / 地面摩擦需 ≥ 0。';
  if (!(Number(p.restitution) >= 0 && Number(p.restitution) <= 1)) return '请检查物理参数：弹性需在 0~1。';
  if (!(Number(p.throwPower) > 0)) return '请检查物理参数：甩出力度需 > 0。';
  return null;
}

async function save() {
  const invalid = validate();
  if (invalid) {
    setStatus(invalid, 'err');
    return;
  }
  const button = $('save');
  button.disabled = true;
  setStatus('保存中…');
  try {
    let res = await fetch(API + '/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildBody()),
    });
    // 409 = 宿主发现用户配置损坏，先不写盘：确认后才带 force=1 按白名单重建
    if (res.status === 409) {
      const info = await res.json().catch(() => null);
      const ok = confirm(
        `用户配置文件解析不了（已损坏）：\n${info?.userFile ?? info?.user ?? ''}\n\n继续保存会按白名单重建该文件，` +
          '里面现有的自定义字段（animations / physics / memes 等）会全部丢失。\n\n取消 = 不动文件；确认 = 强行保存。',
      );
      if (!ok) {
        setStatus('已取消保存');
        return;
      }
      res = await fetch(API + '/config?force=1', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyMerged(await res.json());
    render();
    // 宿主保存后自己也会重解析桌宠；这里再显式叫一次 App 重建，保证窗口数量/尺寸立刻对齐
    await fetch('/pet-app/rebuild', { method: 'POST' }).catch(() => {});
    setStatus('已保存，桌宠即时生效。', 'ok');
  } catch (error) {
    setStatus('保存失败：' + error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function restoreDefault() {
  const ok = confirm('会用内置默认配置（完整字段 + 注释）覆盖用户配置，当前改动会丢失。继续？');
  if (!ok) return;
  setStatus('恢复中…');
  try {
    const res = await fetch(API + '/config', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyMerged(await res.json());
    render();
    await fetch('/pet-app/rebuild', { method: 'POST' }).catch(() => {});
    setStatus('已恢复内置默认配置。', 'ok');
  } catch (error) {
    setStatus('恢复失败：' + error.message, 'err');
  }
}

function addPet() {
  const template = state.pets[0];
  if (!template) return;
  let n = 2;
  while (state.pets.some((pet) => pet.id === 'pet-' + n)) n += 1;
  const clone = JSON.parse(JSON.stringify(template));
  clone.id = 'pet-' + n;
  clone.name = '';
  state.pets.push(clone);
  state.selected = state.pets.length - 1;
  render();
}

// ---------------------------------------------------------------- 启动

// 搜索：按卡片文本过滤（卡片每次 render 都重建，所以渲染后要重新应用一次）
function applySearch() {
  const input = $('search');
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  document.querySelectorAll('#content .card').forEach((card) => {
    if (!q) {
      card.classList.remove('hidden');
      return;
    }
    card.classList.toggle('hidden', !card.textContent.toLowerCase().includes(q));
  });
}

$('search').addEventListener('input', () => applySearch());
$('save').addEventListener('click', () => void save());
$('sync').addEventListener('click', () => void restoreDefault());
$('add').addEventListener('click', addPet);
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
  if (event.key === 'Escape') window.close();
});
void load();

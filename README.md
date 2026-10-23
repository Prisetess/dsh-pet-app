# DSH Pet（独立 Windows 桌宠 App）

<p align="center">
  <img src="docs/hero.png" width="360" alt="DSH Pet 桌宠" />
</p>

把 `dsh-pet` 桌宠从 DSH 插件变成**不打开 DSH 也能双击运行**的 Windows 软件：

- 透明置顶桌宠窗口，拖拽 / 甩抛 / 物理弹跳 / 多开 / 右键动作点播全部保留；
- **右键宠物 →「设置」**打开独立设置窗口（也可以在托盘菜单打开）；
- 托盘常驻：关掉设置窗不退出，宠物一直在；
- 保存配置后**立即重建宠物窗**（改大小 / 位置 / 显示与否 / 数量都即时生效）。

> 作者：等鱼的心跳 · 许可证：MIT（见 `LICENSE`，第三方组件见 `THIRD-PARTY.md`）

---

## 功能一览（当前版本）

**图标**
- 桌面/开始菜单快捷方式、安装包 exe、卸载器、托盘、设置窗/引导窗全部使用同一张图（`ui/guide.png` 原图）
- 由 `scripts/build-icon.ps1` 生成 `build/app.ico`（16/24/32/48/64/128/256 七种尺寸，32bpp DIB），
  `npm run vendor` 会同步到 `ui/app.ico` 供运行时托盘使用
- 注意：不能只塞 PNG 条目 —— System.Drawing 与 csc 解不了，图标会变成灰块或噪点

**启动与常驻**
- 双击桌面快捷方式 / `DSH Pet.exe` 启动；托盘常驻，关窗不退出
- **开机自启**：托盘勾选或设置页「通用」开关（写当前用户 `Run` 键，免管理员，卸载时清除）
- **首次运行引导**：第一次启动弹出欢迎页（含插画），说明右键菜单 / 托盘 / 全屏隐藏等用法

**桌面交互**
- 拖动、甩抛、物理弹跳、屏幕边缘反弹（Windows 上关闭硬件加速以避免拖拽卡顿）
- **记住位置**：拖到哪，松手后写回配置，下次启动回到同一处
- 右键菜单：动作点播 / **大小（变大·变小·还原默认）** / 设置 / 回到初始位置 / 重载配置
- **全屏自动隐藏**：检测到前台全屏应用时自动收起，退出后恢复
  （依赖 `build/fgmon.exe`，缺它则该功能自动关闭）

**面板**
- 托盘：显示宠物 / 暂停动画 / 开机自启 / 设置 / 重新加载 / 打开配置目录 / 退出
- **暂停动画**：冻结 rAF 循环并暂停视频，不改插件代码
- 设置页：宠物配置、桌面行为、物理手感、通用（开机自启）、**互动统计**、配置文件位置
- **设置搜索**：右上角搜索框按卡片内容过滤

**统计**：点击 / 拖拽次数，按天 + 累计，存 `%APPDATA%\DSH Pet\stats.json`，只本地不上传

**日志**：默认**不生成日志文件**（只写控制台）。排查时可设 `DSH_PET_LOG_FILE=<path>` 打开

**按需求跳过**：边缘收纳、多显示器指定、每只宠物独立物理、菜单里的重置位置/重载素材/静音、自动更新、换装市场、多语言

---

## 快速开始

**方式一：双击（推荐）**

```
<工程目录>\DSH Pet.lnk     ← 双击这个
<工程目录>\启动.bat         ← 等价入口（命令行/排查用）
```

（`DSH Pet.lnk` / `启动.bat` 是 `npm run deploy` 生成的本地快捷方式，不入库。）

快捷方式指向 `%USERPROFILE%\.dsh\electron\electron.exe`，参数是本工程目录——**和 `npm run start` 完全同一条启动路径**，
但不需要终端、不需要 npm、不需要 Node。想放桌面就把 `DSH Pet.lnk` 复制过去。

**方式二：命令行**

```powershell
cd <工程目录>
npm run start        # = prepare（复制+打补丁）→ 用本机 Electron 启动
```

**方式三：从零构建（干净 clone）**

```powershell
git clone <repo> && cd dsh-pet-app
npm run vendor       # 拉取 dsh-pet@0.3.6（本机没装插件时自动 npm pack）并打补丁
npm run start        # 开发运行
npm run installer    # 产出 dist\DSH-Pet-Setup-0.1.0.exe
```

前置条件：

| 依赖 | 说明 |
|---|---|
| `dsh-pet` 插件 | 默认从 `~/.dsh/profiles/desktop/node_modules/dsh-pet` 取；没有就用 `npm pack dsh-pet@0.3.6` 自动下载；也可用 `DSH_PET_PLUGIN_ROOT` 指定 |
| Electron 运行时 | 优先 `DSH_PET_ELECTRON_EXE`，其次 `~/.dsh/electron/electron.exe`（DSH 装过就有），最后 `node_modules/electron` |
| Node.js | ≥ 20 |
| .NET Framework | 只用系统自带的 `csc.exe`（Win10/11 内置），用来编译安装器/启动器/图标 |

> ⚠️ 实测结论：**不要把 `electron.exe` 改名**（例如改成 `DSH Pet.exe`）。改名后的副本在本机会被
> SmartScreen/策略静默拦在 Electron 原生层——进程秒退、连主进程日志都不写。所以快捷方式/启动器
> 一律保留原版文件名。


自检（不开窗口，几秒）：

```powershell
npm run selfcheck    # 宿主路由 / 配置聚合 / 素材 / 两个页面 / 保存往返
npm run smoke        # 用假 electron 跑主进程：建窗 / IPC / 设置窗单例 / 重建
```

---

## 目录结构

```
src/main.mjs            主进程：宿主 + 宠物窗 + 设置窗 + 托盘 + IPC
src/host/context.mjs    伪 Cordis ctx（与插件 src/standalone/context.ts 同口径）
src/host/server.mjs     单端口 HTTP：插件路由 + 两个页面 + /pet-app/rebuild
src/preload-pet.cjs     宠物窗 preload（插件 preload 契约 + capabilities + openSettings）
ui/                     内置设置页（原生 JS，默认生效）
ui-react/               官方 React 设置页（A 方案，构建产物生效）
scripts/prepare.mjs     复制插件到 vendor/ + 打补丁 + 写依赖桩
scripts/selfcheck.mjs   宿主自检
scripts/gui-smoke.mjs   主进程逻辑冒烟（假 electron）
vendor/plugin/          复制进来的插件（补丁版，勿手改，重跑 prepare 会覆盖）
```

---

## 三个关键设计

### 0. Windows 上必须关硬件加速（否则拖拽会卡）

`src/main.mjs` 开头有：

```js
if (process.platform === 'win32') app.disableHardwareAcceleration();
```

透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下有已知缺陷：拖拽移动时四周出现黑边、
大透明窗盖住小透明窗时内容丢失、跟随明显掉帧。插件自己的 helper 也是这么做的，本 App 一开始漏了这行，
表现就是「拖动并扔出去时宠物卡卡的」。代价是设置窗也走软件渲染 —— 它只是表单页，无感。

### 1. 宠物窗在主进程里开，不再 spawn 第二个 Electron

DSH 里的做法是「宿主 spawn helper 子进程开透明窗」。打包成 exe 后 `exe helper.js` 那条路走不通
（打包版只加载内置 app.asar），所以这里由 App 主进程直接建窗，加载插件自己的
`runtime/electron-helper/` 渲染端（纯 DOM + `window.PetShared`，不依赖 DSH 前端）。
为此给插件的 `lib/index.js` 打了一行守卫：`DSH_PET_EMBEDDED=1` 时 `startHelper()` 直接返回。

### 2. 页面和接口同源

插件设置页里全是相对路径 fetch（`/dsh-pet-7340/config` 等），所以宠物页、设置页、插件路由
全部由**同一个端口**提供。页面同源 → 不改插件一行代码，也没有 CORS。

### 3. 右键菜单的「设置」只加了三处

| 文件 | 改动 |
|---|---|
| `runtime/electron-helper/sprite.js` | 菜单加「设置」项；`open-site`/`show-balance`/`whisper`/`chat` 按 `petBridge.capabilities` 裁剪 |
| `src/preload-pet.cjs` | 暴露 `openSettings()` 与 `capabilities` |
| `src/main.mjs` | `ipcMain.on('pet:open-settings')` → 建设置窗（单例） |

裁剪那几项是因为独立模式没有 DSH 站点、没有凭证、没有模型 —— 留着只会点了报错。
补丁是**幂等**的：已打过会跳过；锚点对不上（插件升级改了结构）会立刻报错而不是默默漏掉。

---

## 设置窗口的两种形态

### 默认：内置页 `ui/`（原生 JS，立刻可用）

**只保留真正有反应的选项**（独立 App 里点不动的字段一律不做成 UI，但保存时原样带回，
不会把共享配置里的值洗掉）：

- 宠物列表（增删、切换）、名字 / 大小 / 位置（角落）/ 水平与垂直偏移；
- 「在桌面显示这只宠物」开关（等价 display = both / none）；
- 「宠物固定」（随机动画不再转身走开，右键点播照常）；
- 桌面行为：抛掷锁定当前屏 / 顶部反弹；
- 物理手感：重力 / 弹性 / 地面摩擦 / 甩出力度；
- 配置文件位置（用户配置、默认配置、动画与表情包目录）；
- 「保存」= `PUT /config`，「恢复默认」= `POST /config`，损坏文件按 409 → 确认 → `?force=1` 重试；
- 保存成功后额外 `POST /pet-app/rebuild`，宠物窗立即按新配置重建。

被移除的项及原因：

| 移除的项 | 原因 |
|---|---|
| 余额功能 | 没有 DSH 凭证，宿主回 `unsupported` |
| 碎碎念 / 碎碎念配图 | 没有模型后端，宿主回 `provider-missing` |
| 工作状态联动 | 没有 DSH 会话事件，永远空闲 |
| 系统通知 / 对话配图 | 通知与对话都在浏览器半侧，独立 App 没有 |
| AI 模型 / 对话上下文 | 同上，只展示不生效反而误导 |
| 显示位置四选一 | 独立 App 没有浏览器端，`web`/`none` 都是「不显示」→ 收成一个开关 |
| 宠物互撞 | 已整体移除：主进程不再广播宠物状态（每帧一次 IPC + 序列化），preload 也不再暴露 `reportFlight/reportCollide/onFlightStates/onPetHit`；渲染端是守卫式调用，缺失时整段碰撞逻辑自然跳过，不影响拖拽/抛掷/动画 |

### A 方案：官方 React 页 `ui-react/`（需联网装依赖后启用）

`ui-react/entry.ts` 直接 import 插件的 `makePetConfigSection` + `zh` + `petBridge`，
把官方设置页原样挂进独立窗口（数据链与 DSH 内完全一致）。

**当前未构建的原因**：本机离线，缺 `esbuild` 与**匹配的 `react`/`react-dom` 18**
（本机只有 react@18.3.1 + react-dom@19.2.8，19 的 react-dom 会读 React 19 的内部对象，
配 18 会直接崩）。装好依赖后：

```powershell
npm i -D esbuild react@18 react-dom@18
npm run build:ui-react          # → ui-react/dist/
# 重启 App：main.mjs 检测到 ui-react/dist/index.html 会优先用它
```

两套页面共用同一批接口，切换不需要改宿主代码。

---

## 打包成 exe

### 离线便携版（现在就可用，不需要联网）

```powershell
npm run package     # 复制 Electron 运行时 + 应用代码 → dist/DSH Pet/
npm run launcher    # 用 Windows 自带的 csc 编译 45KB 启动器 → dist/DSH Pet/DSH Pet.exe
npm run sign        # 给启动器签名（可选，避免 SmartScreen「未知发布者」）
```

产出 `dist/DSH Pet/`：

```
DSH Pet.exe      45 KB    ← 双击这个（我们自己编译的启动器，已签名）
electron.exe     215 MB   ← 原版 Electron，不改名、不动它
resources/app/   62 MB    ← 我们的代码 + 插件 + 素材
启动.bat / 诊断.bat        ← 备用入口 / 排查入口
```

**为什么用启动器而不是直接改名 `electron.exe`**：

> 实测把 `electron.exe` 改名成 `DSH Pet.exe` 后，进程会被 SmartScreen / 安全软件的
> 「伪装二进制」启发式**静默拦在原生层**——秒退、连主进程日志都不写，现象就是「点了没反应」。
> 启动器是独立的 45KB 原生 exe（内部名 `DSH Pet.exe`、GUI 子系统、无黑窗），它只做一件事：
> `Process.Start("electron.exe", "resources\app")`，并且先删掉 `ELECTRON_RUN_AS_NODE`
> （这个变量会让 Electron 退化成纯 Node、不开窗直接退出）。

体积：约 410 MB（Electron 348 MB + 应用 62 MB）。整个文件夹可随便挪，
但**不能只拷 `DSH Pet.exe`**（旁边的 dll / resources / electron.exe 都是必须的）。

### SmartScreen 拦截怎么办

`npm run sign` 会建一张**自签名代码签名证书**（离线，写入当前用户的 受信任根 + 受信任发布者），
然后签 `DSH Pet.exe`。签完 `Get-AuthenticodeSignature` 为 `Valid`，发布者显示成
`CN=DSH Pet (local build)`；自签名只在本机受信任，换机器仍会拦（对外分发只能买 EV 证书）。

仍被拦：点「更多信息」→「仍要运行」；或直接双击 `启动.bat`。
彻底不想看到提示：安全中心 →「应用和浏览器控制」→「基于声誉的保护设置」→ 关掉「检查应用和文件」。

⚠️ 每次 `npm run launcher` 都会重新生成 `DSH Pet.exe`，**签名随之丢失**，记得再跑 `npm run sign`。

### 做成安装包（分发给别人的电脑，可自定义目录）

```powershell
npm run installer
```

产出 **`dist\DSH-Pet-Setup-0.1.0.exe`（约 200 MB，已签名）**，一个文件就是完整安装程序：

- 双击 → 向导里**选安装目录**（管理员运行时默认 `C:\Program Files\DSH Pet`，普通用户运行则退回
  `%LOCALAPPDATA%\Programs\DSH Pet`）
- 装完创建 **桌面快捷方式** + **开始菜单**（含「卸载 DSH Pet」），图标统一用 `ui/app.ico`
- 在「应用和功能」里有卸载项，`uninstall.exe` 可独立运行
- **自带 Electron 运行时**，目标机器不需要装 DSH、Node 或任何依赖
- 静默安装：`DSH-Pet-Setup.exe /S /D=D:\Apps\DSH Pet`

安装后约 410 MB（Electron 348 + 应用 64）。卸载时：**本 App 数据总是删除**；
宠物配置 `%USERPROFILE%\.dsh\dsh-pet` 会先询问（若检测到 DSH 插件也在用该目录，会提示会连带删除 DSH 的设置）。

#### 安装路径能力与限制（实测）

| 路径类型 | 结果 |
|---|---|
| `%LOCALAPPDATA%\Programs\DSH Pet Test`（默认风格、有空格） | ✅ 389 文件 / 启动 / 卸载 |
| `D:\测试安装\桌宠 应用`（中文 + 空格） | ✅ |
| `D:\Apps\DSH Pet (x64)`（空格 + 括号） | ✅ |
| `D:\Apps\DSH-Trailing\`（`/D=` 带结尾反斜杠） | ✅ |
| 根路径 92 字符（最长文件 177 字符） | ✅ 且能正常启动 |
| **根路径 192 字符（最长文件 277 字符）** | ❌ 超过 Windows 260 字符限制 |
| 目标目录里的 App **正在运行**时再次安装 | ❌ 文件被映射锁住（`.pak` 等），覆盖会报「访问被拒绝」 |
| 目录不可写（只读 ACL / 写保护盘） | ❌ 写入被拒 |
| 磁盘剩余 < 430 MB | ❌ 装不下 |

这些 ❌ 现在全部**前置拦截**（解压前校验）：

- **运行中**：枚举可执行文件位于目标目录下的进程；GUI 会弹「检测到 DSH Pet 正在运行，是否关闭并继续」，
  静默模式直接返回退出码 1（不会瞎覆盖）。这就是「对路径 `…\chrome_100_percent.pak` 的访问被拒绝」的根因。
- **不可写**：先写一个探针文件再删掉，失败时说明盘类型（光驱/可移动盘写保护/网络位置）和系统原文。
- **空间**：按解压后约 410 MB + 20 MB 余量预检。
- 失败一律返回退出码 1，且**本次新建的目录整体删除**（不会留半个安装）。

上面两种 ❌ 都做了**前置拦截**：安装器在解压前就校验，失败时返回退出码 1、
自定义错误提示，并且**不会留下半个安装**（本次新建的目录会整体删掉）。

#### 不写 %TEMP%（曾导致「对路径 …dsh-pet-payload-*.zip 的访问被拒绝」）

早期版本为了绕开 `ZipArchive` 的中央目录偏移限制，会把 197 MB 负载先拷到 `%TEMP%` 再解压。
在 TEMP 被组策略 / 杀软 / 受控文件夹访问限制的机器上，这一步直接失败。

现在改用 `SubStream`（把 exe 里的负载区间映射成一个"从 0 开始"的只读流）直接喂给 `ZipArchive`：
**安装过程完全不碰 %TEMP%**，也省掉一次 197 MB 的磁盘写入。日志也有兜底：
`%TEMP%` → `%LOCALAPPDATA%` → exe 同目录，依次尝试第一个可写的位置。

已知未覆盖：`C:\Program Files` 需要管理员（安装器不提权，请右键「以管理员身份运行」）；
UNC 网络路径、非 NTFS 盘、以及超过 260 字符的长路径（需要 .NET long path 支持，未实现）。

**实现方式**（离线，不用 electron-builder / NSIS）：

```
[ 安装器 exe ][ payload.zip ][ 8 字节 zip 长度 ][ "DSHPETP1" 魔数 ][ Authenticode 证书表 ]
```

安装器读自己的尾部字节解压。两个坑值得记：
1. **签名会在证书表前插入对齐填充**，所以不能用「文件末尾 - 8」定位，要靠 PE 的 SecurityDirectory
   找证书表偏移，再往回扫魔数；
2. `ZipArchive` 的中央目录偏移是**相对流起点**的，直接拿整个 exe 的流去解会报
   「中央目录条目数不对应」，必须先把负载区拷成独立临时 zip。

已验证：静默安装到自定义目录 → 389 个文件 / 410 MB → 启动成功（health `pets:1`）→
卸载后目录、快捷方式、注册表项全部清除。

### 联网时可选：electron-builder（要更小的单文件包）

本项目默认**不依赖** electron-builder（离线环境用 `csc` 自己拼装）。若你有网络且想要更小的产物：

```powershell
npm i -D electron electron-builder
npx electron-builder --win portable
```

需要在 `package.json` 里补 electron-builder 配置（把 `src/` `ui/` `ui-react/dist/` `vendor/plugin/` 打进 asar）。
预计产物约 110–130 MB（压缩率比自解压好）。

- **iexpress**（Windows 自带）：约 400 MB，每次启动解压到临时目录（10–20 秒），杀软容易拦；不推荐

素材瘦身：砍 `vendor/plugin/assets/webm`（106 个动画挑 20–30 个常用动作能到 10–20 MB），
再在 `assets/config.jsonc` 里同步动画池。

---

## 拖拽卡顿怎么查

先确认两件已修的：Windows 上必须关硬件加速（见上），互撞广播已移除（见设置页那张表）。

还卡的话，打开性能探针跑一次，它会每 5 秒打一行：

```powershell
$env:DSH_PET_PERF='1'; npm run start
```

```
[perf] 5s 内 298 帧 ｜ 帧间隔 p50=16.7ms p95=17.2ms ｜ setContentBounds p95=0.31ms max=2.10ms ｜ 穿透翻转 2 次
```

怎么读：

| 现象 | 结论 |
|---|---|
| 帧数明显低于 ~290、p95 间隔 > 25ms | 渲染端没跟上（显卡/解码/主进程抢 CPU），不是窗口跟随的问题 |
| `setContentBounds` p95 明显偏高（> 5ms） | OS 合成器慢，检查是否还有硬件加速 / 远程桌面 / 录屏软件 |
| 穿透翻转次数很高 | 输入被反复打断，看 `pointer-target` 的兜底判定 |
| 三个数都正常却仍感觉卡 | 基本可以确定是主进程里其它活儿（HTTP 供媒体文件）打断，下一步把宿主拆进 `utilityProcess` |

## 已知限制（独立模式的边界）

- **余额 / 碎碎念 / 对话 / 系统通知不可用**：依赖 DSH 的凭证、模型与会话事件；
  宿主会明确返回 `unsupported` / `provider-missing`，不会假装成功。菜单里对应的项已隐藏。
- **模型设置只读**：没有模型后端，设置页只展示配置里已存的值。
- **位置记忆只记「拖到哪」**：松手后写回配置，下次启动回到同一处；
  但设置页里改「显示位置」四选一会覆盖它（二者共用一个 `position` 字段）。
- **首次启动慢一点**：`vendor/` 要复制 60MB 素材（带版本戳，之后跳过）。

---

## 发布到 GitHub

仓库只放**源码与文档**，构建产物一律走 Releases。

| 内容 | 体积 | 是否入库 |
|---|---|---|
| `src/` `scripts/` `ui/` `README.md` 等源码 | 约 2 MB | ✅ |
| `vendor/plugin`（dsh-pet + 60MB 素材） | 62 MB | ❌ 由 `npm run vendor` 重建 |
| `build/`（安装器中间产物、payload.zip） | 813 MB | ❌ |
| `dist/`（成品 exe） | 610 MB | ❌ 放到 Releases |
| `ui/app.ico`（由 `build-icon.ps1` 生成） | 0.4 MB | ❌ 自动重建 |

### 首次发布

```powershell
cd D:\dsh\dsh-pet-app
git remote add origin https://github.com/Prisetess/dsh-pet-app.git
git push -u origin main
```

在 GitHub 上先建一个**空仓库**（不要勾选 README / .gitignore / License，否则会和我们提交的内容冲突），
仓库名建议 `dsh-pet-app`。

### Release（放安装包）

```powershell
npm run installer
# 生成 dist\DSH-Pet-Setup-0.1.0.exe（约 200 MB）
Get-FileHash dist\DSH-Pet-Setup-0.1.0.exe -Algorithm SHA256
```

在 GitHub 建 tag（如 `v0.1.0`）→ Release → 上传 exe → 正文里贴 SHA256。
**不要**把 exe 提交进仓库（单文件 100 MB 上限，且每次构建都产生新二进制）。

### 用户会遇到的拦截（务必写进 Release 说明）

- 安装时弹 UAC：发布者显示"未知"（自签名证书只在开发机受信任）；
- 首次运行 SmartScreen：点「更多信息 → 仍要运行」；
- 想彻底消除：买代码签名证书（EV 立即生效），或用 `scripts/trust-cert.ps1` 在本机信任。

### 许可证与素材

- 本仓库代码：MIT（`LICENSE`）
- dsh-pet 插件：MIT，原作者 PC2005-cloud —— 见 `THIRD-PARTY.md`（含我们对它的修改清单）
- `ui/guide.png` 插画：**不覆盖在 MIT 内**，发布前请确认你有权使用，否则替换成自己的图


---

## 插件升级怎么办

```powershell
npm run vendor     # 检测到新版本会重新复制 + 重新打补丁
```

若上游改了 `sprite.js` 的菜单结构，补丁脚本会**明确报错并指出哪个锚点没命中**，
不会留下一个「没有设置入口」的半成品。

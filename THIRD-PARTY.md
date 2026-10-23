# 第三方组件与素材

本项目是 `dsh-pet` 插件的**二次创作（独立 Windows 外壳）**：外壳代码是本仓库的，
桌宠的渲染、物理、动画全部来自原插件。

> **原作者：PC2005-cloud · 原仓库：https://github.com/PC2005-cloud/dsh-pet**

## 0. 授权范围（LICENSE 覆盖到哪里）

`LICENSE` 里的 MIT 许可**只**覆盖本仓库作者编写的代码与文档（`src/`、`scripts/`、`ui/`、`docs/`）。
不属于该许可的内容：

| 内容 | 授权 |
|---|---|
| `vendor/` 中的 dsh-pet **代码**（由 `npm run vendor` 生成，不入库） | MIT，版权归 dsh-pet 原作者 |
| `vendor/plugin/assets/` 中的**动画素材** | **允许开源使用，禁止商用**（原项目单独约定，不是 MIT） |
| Electron / Chromium / Node.js | 各自许可证 |
| `ui/guide.png`、`docs/hero.png` | 作者等鱼的心跳原创，随本仓库以 MIT 一同发布 |

## 1. dsh-pet（核心）

| 项 | 内容 |
|---|---|
| 包名 / 版本 | `dsh-pet@0.3.6` |
| 仓库 | **https://github.com/PC2005-cloud/dsh-pet** |
| 代码许可 | MIT（`vendor/plugin/LICENSE`） |
| 素材许可 | 允许开源使用，**禁止商用** |
| 二次创作约定 | 基于本项目的衍生作品，在**任何介绍、展示、分发**的地方须附原作者 GitHub 地址 |

**我们对它的修改**（全部在 `scripts/prepare.mjs` 里，可复现、可审计）：

1. `runtime/electron-helper/sprite.js`
   - 右键菜单增加「设置」「大小（变大/变小/还原）」；
   - 按平台能力裁剪「打开网站 / 查看余额 / 碎碎念 / 对话」（独立 App 没有 DSH 站点与模型）；
   - 增加对应的动作分发。
2. `lib/index.js`
   - 增加 `DSH_PET_EMBEDDED=1` 分支：宿主不再自己 spawn Electron helper，窗口由外壳主进程创建。

代码部分遵循 MIT：保留原许可证与版权声明，并在此列明改动。

### 我们对「二创约定」的履行情况

| 要求 | 我们的做法 |
|---|---|
| 介绍处附原作者地址 | `README.md` 顶部、本文件、`docs/RELEASE_NOTES-v0.1.0.md` |
| 展示处附原作者地址 | 首次运行引导窗底部、设置页底部（应用内可见） |
| 分发处附原作者地址 | 安装包内 `readme.txt`、`resources\app\vendor\plugin\LICENSE` |
| **禁止商用** | 本项目免费开源分发，不售卖、不放广告、不设付费下载 |

**素材**：`vendor/plugin/assets/` 下 106 个 `.webm` 动画（约 52 MB）。按原项目约定，
这些素材**允许随开源项目一起使用，但禁止商业用途**——如果你要拿本项目做商业发行，
必须先把素材替换成你有权商用的内容。

## 2. Electron / Chromium / Node.js

- Electron —— MIT，https://github.com/electron/electron
- Chromium —— BSD 3-Clause 及若干第三方许可
- Node.js —— MIT

本项目使用 Electron 43.3.0（由 dsh-pet 下载到 `~/.dsh/electron`，或打包时内置一份）。

## 3. ui/guide.png / docs/hero.png（引导插画）

由本项目作者**等鱼的心跳**原创，随仓库以 MIT 许可一同发布。
`docs/hero.png` 是 `ui/guide.png` 的 640px 缩略图（仅用于 README 展示）。

换图方式：把新图覆盖到 `ui/guide.png`，再跑 `npm run vendor`（会重新生成 `build/app.ico` 并同步到 `ui/app.ico`）。

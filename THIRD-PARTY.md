# 第三方组件与素材

本项目是 `dsh-pet` 插件的**独立 Windows 外壳**：外壳代码是本仓库的，桌宠的渲染、物理、动画全部来自原插件。

## 1. dsh-pet（核心，MIT）

| 项 | 内容 |
|---|---|
| 包名 / 版本 | `dsh-pet@0.3.6` |
| 仓库 | https://github.com/PC2005-cloud/dsh-pet |
| 许可证 | MIT（`vendor/plugin/LICENSE`） |
| 版权 | 归 dsh-pet 原作者所有 |

**我们对它的修改**（全部在 `scripts/prepare.mjs` 里，可复现、可审计）：

1. `runtime/electron-helper/sprite.js`
   - 右键菜单增加「设置」「大小（变大/变小/还原）」；
   - 按平台能力裁剪「打开网站 / 查看余额 / 碎碎念 / 对话」（独立 App 没有 DSH 站点与模型）；
   - 增加对应的动作分发。
2. `lib/index.js`
   - 增加 `DSH_PET_EMBEDDED=1` 分支：宿主不再自己 spawn Electron helper，窗口由外壳主进程创建。

这些修改遵循 MIT：保留原许可证与版权声明，并在此列明改动。

**素材**：`vendor/plugin/assets/` 下 106 个 `.webm` 动画（约 52 MB）随插件一同分发。若你计划再分发，请自行确认这些美术素材的授权（原插件仓库未附素材署名文件）。

## 2. Electron / Chromium / Node.js

- Electron —— MIT，https://github.com/electron/electron
- Chromium —— BSD 3-Clause 及若干第三方许可
- Node.js —— MIT

本项目使用 Electron 43.3.0（由 dsh-pet 下载到 `~/.dsh/electron`，或打包时内置一份）。

## 3. ui/guide.png / docs/hero.png（引导插画）

由本项目作者**等鱼的心跳**原创，随仓库以 MIT 许可一同发布。
`docs/hero.png` 是 `ui/guide.png` 的 640px 缩略图（仅用于 README 展示）。

换图方式：把新图覆盖到 `ui/guide.png`，再跑 `npm run vendor`（会重新生成 `build/app.ico` 并同步到 `ui/app.ico`）。

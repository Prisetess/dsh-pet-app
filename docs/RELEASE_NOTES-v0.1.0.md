**把 dsh-pet 桌宠做成独立的 Windows 软件：不装 DSH 也能双击运行。**

> 本项目是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的二次创作（MIT 外壳）<br>
> 原作者：**PC2005-cloud** · 原仓库：**https://github.com/PC2005-cloud/dsh-pet**<br>
> 桌宠动画素材：允许开源使用、**禁止商用**；本项目免费分发，不用于商业用途。

![DSH Pet](https://raw.githubusercontent.com/Prisetess/dsh-pet-app/main/docs/hero.png)

## 下载

| 文件 | 大小 | 说明 |
|---|---|---|
| `DSH-Pet-Setup-0.1.0.exe` | 200 MB | 双击安装，**自带 Electron 运行时**，目标机器不需要装 DSH / Node / 任何依赖 |

**SHA256**：`4B0F1EF16883032874961A866EC8C90A8F16649E649F2697AB7F10E390C60527`

## 安装

1. 双击 `DSH-Pet-Setup-0.1.0.exe`
2. UAC 提示点「是」（发布者显示"未知"是正常的，原因见下）
3. 选择安装目录 —— 管理员运行时默认 `C:\Program Files\DSH Pet`；普通用户运行则退回 `%LOCALAPPDATA%\Programs\DSH Pet`
4. 装完自动创建桌面快捷方式 + 开始菜单（含卸载项）

静默安装：`DSH-Pet-Setup-0.1.0.exe /S /D=D:\Apps\DSH Pet`

## ⚠️ 首次运行会被 Windows 拦一次

安装包用的是**自签名证书**（没有购买商业代码签名证书），所以：

- **SmartScreen**：「Windows 已保护你的电脑」→ 点 **更多信息 → 仍要运行**
- **UAC**：发布者显示「未知」→ 点「是」

只需一次，之后不再提示。若文件被标记为"来自 Internet"，也可以右键 exe → 属性 → 勾选「解除锁定」。

## 功能

- 透明置顶桌宠：拖拽 / 甩抛 / 物理弹跳 / 屏幕边缘反弹
- 右键菜单：动作点播 / **大小（变大 · 变小 · 还原默认）** / 设置 / 回到初始位置
- 独立设置窗口：宠物、桌面行为、物理手感、通用（开机自启）、互动统计、设置搜索
- 托盘常驻：显示/隐藏 · 暂停动画 · 开机自启 · 设置 · 重新加载
- **记住拖拽位置**、**全屏应用时自动隐藏**、**首次运行引导**
- 开机自启：写当前用户 `Run` 键，免管理员，卸载时清除

## 系统要求

- Windows 10 / 11（x64）
- 约 500 MB 磁盘空间（安装后约 410 MB）

## 已知限制

- **余额 / 碎碎念 / AI 对话不可用**：依赖 DSH 的凭证与模型，独立版没有（菜单里已隐藏，不会假装成功）
- **独占全屏**的老游戏可能检测不到，不会自动隐藏（无边框全屏正常）
- 卸载时会询问是否删除宠物配置（`%USERPROFILE%\.dsh\dsh-pet`）；若检测到 DSH 插件也用这个目录，会提醒会连带删除

## 从源码构建

```powershell
git clone https://github.com/Prisetess/dsh-pet-app.git
cd dsh-pet-app
npm run vendor      # 自动拉取 dsh-pet@0.3.6 并打补丁
npm run start       # 开发运行
npm run installer   # 产出 dist\DSH-Pet-Setup-0.1.0.exe
```

需要 Node ≥ 20 与 Windows 自带的 .NET Framework（编译安装器/启动器）。

## 致谢

桌宠的渲染、物理、动画来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT，作者 PC2005-cloud）。
本仓库提供的是独立运行的外壳、设置页与打包流程。

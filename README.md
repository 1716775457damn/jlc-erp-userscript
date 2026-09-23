# 嘉立创 ERP 油猴（JLC Userscript）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.16.21-green.svg)](jlc-proofread-query.user.js)

嘉立创机器库校对 / 下载桥接 Tampermonkey 脚本。  
**本仓是油猴协作真源**；ERP 仓内同名文件为部署拷贝。同事改脚本请 fork 后提 PR。

当前版本：脚本头 `@version` / 常量 `VERSION` = **1.16.21**（以脚本为准）。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| **下载桥** | 浏览器 ↔ 本机 ERP（`127.0.0.1:18765`）轮询执行 `ping` / `query` / `list` / `download` 等 |
| **会话** | 登录态落盘与恢复；机器库页下发 `SMT_ERP_SESSION_ID`，避免 ERP 报 460 |
| **机器库校对** | 连扫下载、云目录大批量 list、模板分类相关桥命令 |
| **私有库提货** | 查客编库存、打开提货申请页填单（自动提交默认关闭） |
| **CTU** | 查容器号 / 容器列表勾选（呼出 API 默认关闭） |
| **FAB** | 机器库页悬浮「JLC桥」状态，显示版本与在线 |

> 截图（可选）：现场可在 Issues 或 PR 中附上 FAB 在线态、ERP「油猴在线」面板截图，便于新人对照。

---

## 文件

| 文件 | 说明 |
|------|------|
| `jlc-proofread-query.user.js` | Tampermonkey 主脚本 |
| `jlc-setup.html` | 安装 / 更新指引页（版本文案须与脚本一致） |
| `CONTRIBUTING.md` | 贡献与 PR 约定 |
| `LICENSE` | MIT |

---

## 安装

### 方式 A：现场（推荐，随 ERP 部署）

1. 仓库 ERP 已起（端口 `8787`）时打开：  
   `http://127.0.0.1:8787/userscripts/jlc-setup.html`
2. 点「安装/更新」→ Tampermonkey 确认。
3. 打开机器库页 `nw.jlcerp.com/smtbaseservice`，FAB 显示 **JLC桥 v1.16.21** 且在线。
4. 回 ERP「嘉立创校对」应显示油猴在线。

脚本内 `@updateURL` / `@downloadURL` **仍指向本机 8787**（与现网部署一致）。  
磁盘更新 ≠ TM 已加载；须经 setup 页重装并刷新页面。

### 方式 B：从本 GitHub 仓安装（开发 / 无 ERP 静态页时）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 Raw 脚本：  
   https://github.com/1716775457damn/jlc-erp-userscript/raw/main/jlc-proofread-query.user.js  
   → TM 会提示安装 / 更新。
3. 仍须登录嘉立创并打开机器库页；桥命令依赖本机 ERP（`18765`）。

也可 clone 后在 TM 中「从本地文件添加」；冒烟时勿依赖自动更新 URL。

### 会话注意（460）

- 只开 mh 首页「已登录」不够；必须打开贴片机机器库页才会下发 `SMT_ERP_SESSION_ID`。
- 已在机器库页仍 460 → 退出再登录，勿反复新开标签。
- 打开 nw 被跳到 mh 属正常；同站点勿 Chrome + Edge 双开。

---

## 开发与提 PR

1. Fork 本仓 → 改 `jlc-proofread-query.user.js`（需要时同步 `jlc-setup.html` 版本提示）。
2. 改行为时 bump `@version` 与脚本内 `VERSION`（保持一致）。
3. 本地用 TM「从本地文件添加」或临时改 `@updateURL` 做冒烟。
4. 提 PR 到 `main`（见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 PR 模板）。
5. **合并后**：维护者把脚本同步进 [`smt-component-erp`](https://github.com/1716775457damn/smt-component-erp) 的 `userscripts/`，再 appsync 推仓库。

---

## 相关

- ERP 主仓：https://github.com/1716775457damn/smt-component-erp  
- 桥端口：浏览器 ↔ `127.0.0.1:18765`（ERP 进程提供）  
- 安装指引（仓内）：[jlc-setup.html](jlc-setup.html)

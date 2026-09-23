# 嘉立创 ERP 油猴（JLC Userscript）

嘉立创机器库校对 / 下载桥接油猴脚本。同事改脚本请在本仓 fork 后提 PR。

## 文件

| 文件 | 说明 |
|------|------|
| `jlc-proofread-query.user.js` | Tampermonkey 主脚本 |
| `jlc-setup.html` | 安装/更新指引页 |

当前版本见脚本头 `@version`。

## 安装（现场）

1. 仓库 ERP 已起（`8787`）时，打开：  
   `http://127.0.0.1:8787/userscripts/jlc-setup.html`
2. 点「安装/更新」→ Tampermonkey 确认。
3. 打开机器库页 `nw.jlcerp.com/smtbaseservice`，FAB 显示 **JLC桥** 且在线。

磁盘更新 ≠ TM 已加载；须经 setup 页重装并刷新页面。

## 开发与提 PR

1. Fork 本仓 → 改 `jlc-proofread-query.user.js`（需要时同步改 `jlc-setup.html` 版本提示）。
2. 本地用 Tampermonkey「从本地文件添加」或临时改 `@updateURL` 做冒烟。
3. 提 PR 到 `main`；说明改了什么、测了哪条路径（下载 / 会话 / CTU 等）。
4. **合并后**：维护者把脚本同步进 `smt-component-erp` 的 `userscripts/`，再 appsync 推仓库。

本仓是油猴协作真源；ERP 仓内同名文件为部署拷贝。

## 相关

- ERP 主仓：https://github.com/1716775457damn/smt-component-erp  
- 桥端口：浏览器 ↔ `127.0.0.1:18765`（ERP 进程提供）

# 贡献说明

## 改什么

- 只改油猴相关：`jlc-proofread-query.user.js`、`jlc-setup.html`、本仓文档与 GitHub 模板
- 改行为时请 bump `@version` 与脚本内 `VERSION` 常量（保持一致）
- `jlc-setup.html` 里的「必须 ≥x.y.z」与 FAB 提示版本一并更新
- **不要**擅自改 `@updateURL` / `@downloadURL`（现场默认仍为 `127.0.0.1:8787`）

## PR 要求

- 标题写清场景（如「修复 460 会话恢复」「禁止 CTU 呼出」）
- 描述：动机、改动点、本地如何验证（Chrome/Edge、机器库页 FAB 是否在线、ERP 是否显示油猴在线）
- 不要提交 `.bak*`、浏览器缓存、Cookie、个人路径、`.env`

## 合入后

维护者同步到 `smt-component-erp/userscripts/` 并推仓库部署；现场须经 setup 页重装 TM。

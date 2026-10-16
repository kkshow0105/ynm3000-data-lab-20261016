# Git预算工作流集成

用户已授权启用真实发布，开关使用 `ENABLED` / `DISABLED`。这不代表供应商正式许可。预算无法确认时仍禁止真实请求。仅手动 workflow_dispatch，无 schedule。

- `update-market.yml` 已停止 Artifacts 路径，复用 `git-budget-ledger.js`：先持久化最大预留、远端读回，采集前再次核验。
- Mock 模式使用同一 `prepareRun` / `collectRun` 及真实 `budget-ledger` 分支；行情来源为纯内存Mock，发布存储也是内存，不改已有公开JSON。每批仅记1个simulation虚拟单位，不代表真实FMP调用。
- 真实模式已获用户执行授权，供应商数据许可风险仍未消除；账户重置周期和未入Git真实账本的外部消耗仍必须确认。现有旧实验至少FMP6/FRED2（2026-10-16T06:14:11.884Z），与预算分支knownExternal描述同一基线，不重复相加。Mock预留完全隔离。
- 127/128分类配置冻结于已核实的2026-10-14；身份、交易所、唯一性、必要字段校验失败则不发布。
- `scripts/market-cloud-artifacts.js` 与 `legacy/update-market-artifacts.yml` 是切换前原文件备份，不被当前工作流调用；不能因Git账本失败自动切回Artifacts或归零。回退需人工审查旧路径的已知恢复问题。
- 原有 `lab/cloud-budget.json`、旧历史JSON、旧一次性实验锁及其他工作流均保留，不能删除锁重新消耗额度。
- 若上一版本公开的旧模拟快照分类不符合新的真实分类白名单，不将其迁移或冒充真实行情；本轮集成验收完全在内存Mock发布中完成。

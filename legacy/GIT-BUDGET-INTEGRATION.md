# Git预算工作流集成

用户已授权启用真实发布，开关使用 `ENABLED` / `DISABLED`。这不代表供应商正式许可。预算无法确认时仍禁止真实请求。仅手动 workflow_dispatch，无 schedule。

- `update-market.yml` 已停止 Artifacts 路径，复用 `git-budget-ledger.js`：先持久化最大预留、远端读回，采集前再次核验。
- Mock 模式使用同一 `prepareRun` / `collectRun` 及真实 `budget-ledger` 分支；行情来源为纯内存Mock，发布存储也是内存，不改已有公开JSON。每批仅记1个simulation虚拟单位，不代表真实FMP调用。
- 真实模式已获用户执行授权，供应商数据许可风险仍未消除；可使用已核实剩余额度证据，无需猜测重置周期；未入Git真实账本的外部消耗仍必须确认。现有旧实验至少FMP6/FRED2（2026-10-16T06:14:11.884Z），与预算分支knownExternal描述同一基线，不重复相加。Mock预留完全隔离。
- 127/128分类配置冻结于已核实的2026-10-14；身份、交易所、唯一性、必要字段校验失败则不发布。
- `scripts/market-cloud-artifacts.js` 与 `legacy/update-market-artifacts.yml` 是切换前原文件备份，不被当前工作流调用；不能因Git账本失败自动切回Artifacts或归零。回退需人工审查旧路径的已知恢复问题。
- 原有 `lab/cloud-budget.json`、旧历史JSON、旧一次性实验锁及其他工作流均保留，不能删除锁重新消耗额度。
- 若上一版本公开的旧模拟快照分类不符合新的真实分类白名单，不将其迁移或冒充真实行情；本轮集成验收完全在内存Mock发布中完成。

## 已核实剩余额度模式

真实批次支持 `VERIFIED_REMAINING`，无需猜测供应商重置时点；原固定重置规则未伪造或修改。

- 证据为实际后台的已用/剩余及ISO UTC核实时间，两数之和必须为250，最长有效24小时，时间不会自动更新。
- 新额度证据与其覆盖的账本revision绑定；同一证据不能更改时间或推进锚点，旧池不得回退使用。新池只能凭更新的真实证据建立，历史预留全部保留。
- 账户剩余额度只扣证据锚点后的真实预留及截图后累计账本外消耗；截图已包含的旧6不再从剩余额度扣一次。14个Mock预留不扣真实池。
- 滚动24小时20次FMP/4次FRED的项目保护独立保留；已发生的旧请求仍可占项目保护窗口，但不会再次扣除新账户余额。
- 失败不退款；旧账本丢失不自动重建。未知或超过5分钟未确认的外部消耗拒绝授权，不能默认0。
- 手动运行需填写 `verified_account_at`（UTC）、`verified_account_used`、`verified_account_remaining`、`credit_checkpoint_revision`，并明确勾选账户证据与截图后外部消耗的确认。
- 同一额度证据重复使用时沿用原checkpoint，不能改成最新revision以释放预算。获得新证据后才以其覆盖的当前revision建立新池。
- 刷新证据是新的人工账户事实，不能通过日期变化、失败状态或清空账本恢复额度。

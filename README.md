# Stock 策略演进系统

本机运行的 PostgreSQL + Node.js + Vue 3 策略工作台。当前有效方案为：

- `docs/product/Stock_策略演进系统_产品方案_v2.0.md`
- `docs/design/Stock_策略演进系统_技术设计_v2.0.md`

旧纯前端 MVP、文件读取适配器和文档同步入口已经退役；生产运行不读取 `project/` 外文件。

当前策略与 Agent 工作台四阶段已于 2026-08-18 完成。2026-08-19 又完成三阶段收敛：页面业务写入与任务治理、0029 短线/长线池及行情重构、0030 成交归因/回测最终结论/Agent 记忆。当前数据库迁移上限为 40；外部 CLI 桥继续暂缓。

## 单一事实源

| 领域 | 当前事实源 |
|------|------------|
| 行情与标的 | `market_*` |
| 持仓、账户、持仓流水 | `portfolio_position*` / `portfolio_account_snapshot` / `portfolio_account_state`；后者按“快照锚点 + 锚点后成交”维护实时现金与清仓收益 |
| 短线池、长线池与板块偏好 | `pool_membership` / `pool_board_preference`；系统不存在独立自选 |
| 当前策略与核心指引 | `strategy_state` / `strategy_document*`；用户可见历史只读 `strategy_evolution_log` 摘要 |
| 每日计划与其他任务结果 | `job_run_output`（关联 `job_definition` / `job_run` / Agent session） |
| 冻结的旧策略、计划与归档 | `content_document` / `content_revision`（仅兼容读取和迁移审计，不再写入） |
| Agent Flow 提示词 | `job_prompt` / `job_prompt_revision` |
| 作业定义、状态和缺口 | `job_definition` / `job_run` |
| Agent 会话、过程事件和领域引用 | `chat_session` / `chat_message` / `chat_session_event`；任务、回测和策略提案直接用 `session_id` 关联 |
| 分析与估值 | `analysis_*` / `fundamental_snapshot` / `valuation_snapshot` |
| 回测 | `backtest_*`；默认历史只展示研究会话确认的 `final` 结论 |
| Agent 可复用记忆 | `agent_memory_artifact`；只保存已验证、长期可复用产物 |

旧内容域不保存持仓、资金、持仓流水、标的池、行情、作业提示词/结果、分析、回测或记忆副本。迁移 0014 已删除已迁移领域的旧内容文档；0017 把最终策略与历史每日计划迁到专用领域后关闭全部内容写入口。`content_*` 与 `content_legacy_import` 不再向 Agent 开放。

## 启动

跨电脑或正式独立部署统一按 [`docs/独立部署说明.md`](docs/独立部署说明.md) 使用 Docker Compose。以下命令只用于源码开发，要求 Node.js 22.19+、npm 10 和 PostgreSQL 16；启用 Agent 临时代码回测还需要 Docker Desktop 与本机 Node 22 镜像。

```bash
cd project
cp .env.local.example .env.local
docker compose --env-file .env.local up -d postgres
npm ci
npm run db:migrate
npm run web:build
npm run server
```

服务仅监听 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)，不得暴露到局域网或公网。首次使用时在「设置 → 数据源凭据」配置扶摇 API Key，在「设置 → AI 模型与厂商」配置模型；密钥存入 PostgreSQL，接口不回显。

0040 起扶摇密钥只存 `system_setting`；旧 `.env.local` 中的 `HITHINK_FINANCE_API_KEY` 会在首次启动时仅迁入一次，迁移后应删除该旧项。`fetch_market_data` 可在一次调用中批量补行情，也可通过 `financial_requests` 获取估值快照与利润表、资产负债表、现金流量表；服务只选择三张报表共同存在的最新报告期，并幂等写入 `valuation_snapshot` / `fundamental_snapshot`。

## Agent 数据库流程

新会话注册 `database_schema`、`database_query`、`memory_query`、`portfolio_write`、`pool_write`、`job_write`、`finalize_backtest`、`memory_write`、`strategy_publish_request`、`analysis_run`、隔离版 `run_backtest`、`fetch_market_data`、`trigger_job` 与 `ui_refresh`。系统提示词从同一读事务动态注入完整当前策略、轻量表索引、轻量有效记忆索引、当前持仓、实时资金摘要、今日作业和行情截止日。

1. 从轻量表索引选择少量相关表。
2. 用 `database_schema.describe_tables` 获取当前结构和 `schema_hash`。
3. 用携带逐表哈希的结构化 `database_query` 查询；服务端重验哈希、校验标识符并构建参数化只读 SQL。
4. 普通写入只使用 `portfolio_write`、`pool_write`、`job_write`、`finalize_backtest`、`memory_write`，并经过对应领域 service；`watchlist_write`、`content_write`、`backtest_write` 和固定服务版 `run_backtest` 已退役。
5. 策略调整只使用 `strategy_publish_request` 创建待真人审核提案；Agent、调度器和 YOLO 都没有批准能力。

确认制只创建 pending 提案；YOLO 在校验后直接事务执行。两种模式都保留敏感数据保护、审计、数据库写锁和目标状态冲突检测。`trigger_job` 返回 queued 只表示已排队，实际终态查询 `job_run`。

页面以查询与治理为主：标的入池、成交/资金、任务定义/提示词和记忆变更只能经 Agent。任务中心只保留查看、启停、立即运行、失败处理和来源会话；当前策略发布仍必须由真实用户批准。

内置 agent_flow 从 `job_prompt_revision` 固化提示词，只注册 `database_schema` / `database_query`；执行前固化 `strategy_state.change_seq/current_hash` 并注入对应完整策略快照，业务事实读取结构化表，历史任务产物读取 `job_run_output`。新结果与 `job_run` 终态在同一事务写入 `job_run_output`，`job_run.result_md` 只兼容读取。每次 agent_flow 排队时原子创建一个侧边栏可见的普通任务会话；第一条用户消息保存固化任务提示词，自动重试继续使用同一会话历史和策略快照。datasource、analysis 和 missed 运行不创建伪会话。

`POST /api/chat/:sessionId/messages` 是交互与任务会话的统一发送入口；任务只保留 `session_type/source` 来源标签，完成后可直接在原会话追问。`POST /api/chat/:sessionId/control` 携带当前 `run_id`：`abort` 真正取消服务端 Agent，`steer` 在下一执行边界注入，`follow_up` 在本轮自然结束后执行。已经完成的工具写入不会因中断回滚。

长会话按模型输入预算自动压缩：达到约 80% 时摘要旧前缀并保留约 18% 的近期上下文，旧工具大结果先在模型视图内裁剪，工具调用与结果保持成对。摘要检查点保存在 `chat_session`，全部原始 `chat_message` 继续完整保留。交互对话与 Agent 作业统一使用 session 执行路径。

对话历史统一读取 `GET /api/chat/sessions/:id/messages`，低频事件统一通过 `GET /api/chat/:id/events?after=<cursor>` 重放；不再提供任务专用过程 API 或过程面板。Agent 成功落库后，工具卡通过稳定结果引用直接打开对应结果或定位业务记录；任务完成后会话追加 `/?result=job-output:<id>`，在全局单例阅读器打开完整 `job_run_output`。阅读器由 URL 恢复，保留原业务页面和 Agent 会话状态，也兼容旧 `/jobs?output=<id>` 链接。回测延续、回测对比、策略演进和任务解读等快捷入口先二次确认，再新建独立会话并预填上下文，不自动发送。

前端使用布局内 `AgentWorkspace`，不再使用悬浮抽屉。左侧菜单可在 188/56px 间收放；右侧工作区可拖动宽度、收起为 48px 轨道并持久化状态，收起不会卸载 `ChatView` 或丢失草稿。小于 1100px 时 Agent 位于业务页面下方。会话列表统一展示对话与任务标签；运行中输入框可选择干预、排到下一轮或停止。`ui_refresh` 仅允许白名单模块局部重新取数，不具备点击、输入、导航或浏览器控制能力。

回测创建统一由 Agent `run_backtest` 在隔离的临时 TypeScript 工作区驱动；每次运行先是 `working`，调用 `finalize_backtest` 写入结论摘要与适用边界后才进入默认历史。同一研究会话只保留一个当前 `final`，再次确认会把旧结论标记为 `superseded`。固定服务创建/激活 API、页面表单和 `backtest_write` 已退役；数据库、聊天、审计和备份均不保存回测代码正文。

资金摘要使用 `portfolio_account_state` 的实时口径：人工/券商快照建立锚点，锚点后的买入扣减现金、卖出回补现金，完全清仓时删除当前持仓行并按成交数量与持仓成本累加清仓收益；更晚快照重新校准台账。锚点日及以前成交不重复计算；从未同步快照时现金保持未知。

每条新增成交/调整事件会固化决策来源、执行符合度、当前策略序号与哈希、可选计划结果、来源会话及归因说明；计划外或执行偏离必须说明原因。持仓页只聚合展示事件归因构成，不保存会覆盖历史的单一布尔值。

短线池和长线池是唯一研究清单。入池要求完整角色、分级、评分、股性、阶段、标签和评估摘要；股票还必须已有同花顺官方行业关系，ETF 不强制行业归属。池内不保存本地板块代码或独立行业选择，同一标的只能有一个当前角色。行情不作为一级菜单，从池、板块、持仓和全局搜索下钻；行情图表不提供画线功能。

Agent 记忆只保存已验证的研究方法、模板、数据源经验、任务编排、故障处理和长期偏好。密钥、临时代码、当前持仓和策略正文副本会被拒绝；系统提示词只注入轻量索引，正文通过 `memory_query` 按需读取。

当前策略页只展示 8 份最终策略/指引和简要演进摘要。待审提案可查看逐文档差异；批准/拒绝必须先由该页面领取 5 分钟一次性令牌。批准成功后 Agent 下一轮自动使用新的整体策略哈希。任务中心按具体作业展示 `job_run_output`，19 份迁入的历史每日计划可直接预览，不需要经过内容库。

## 稳定命令

```bash
npm run typecheck
npm run web:typecheck
npm test
npm run web:build

npm run db:migrate
npm run server
npm run web:dev
npm run market:fetch
npm run volume:export
npm run volume:restore -- <dump路径> [--target <连接串>] [--data-only]
npm run portable:export
npm run portable:restore -- <payload路径> --target <连接串>
```

## 跨电脑独立部署

`project/` 可以脱离父目录独立部署。新电脑统一使用 Docker Compose；固定资产范围、首次恢复顺序、验收、更新和敏感数据边界见 [`docs/独立部署说明.md`](docs/独立部署说明.md)。

## 目录

| 路径 | 职责 |
|------|------|
| `server/migrations/` | 只向前 SQL 迁移；已应用文件不得修改 |
| `server/agent/` | AI/core 接入、统一 session 执行器、系统提示词、渐进式查询、领域工具、确认制与审计 |
| `server/modules/` | 持仓、内容、作业、行情、短线/长线池、回测和记忆等领域 service 与 API |
| `server/datasource/` | 扶摇/AKShare 通道，行情、财务与估值落库 |
| `server/scheduler/` | Asia/Shanghai 作业调度与受控 Runner |
| `server/analysis/` / `server/backtest/` | 数据库原生分析与回测 |
| `server/volume/` | 完整私有备份和可移植初始化包 |
| `web/` | Vue 3 工作台 |
| `tests/server/` | 数据库、API、Agent、调度和数据卷测试 |

`project/.env.local`、`server/uploads/`、`datavolume/` 与构建产物均按敏感或可再生数据处理，不提交版本库。

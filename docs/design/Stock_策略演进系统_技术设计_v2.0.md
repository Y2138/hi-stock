# Stock 策略演进系统 技术设计 v2.0

| 项目 | 填写内容 |
|------|----------|
| 文档标题 | Stock 策略演进系统 技术设计 v2.0（二期：策略演进工作台） |
| 文档版本 | v2.26 |
| 目标产品版本 | 二期 M1–M4 + Agent 主导业务写入与首期 Web 研究 |
| 状态 | T1–T45 已确认；跨电脑固定资产同步已收敛；外部 CLI 桥暂缓 |
| 更新日期 | 2026-08-21 |
| 关联 PRD | `project/docs/product/Stock_策略演进系统_产品方案_v2.0.md`（v2.29，E1–E38） |
| 前置设计 | `Stock_策略演进系统_技术设计_v1.0.md`（一期，已交付，保留为历史） |

> 本文按 `设计文档模板_v1.0.md` 裁剪：模板中与交易事实写入、计划状态机、成交校验相关章节在二期仍不适用（系统不产生交易执行），删除并在此注明。一期设计文档中的 Schema v1、迁移策略、错误格式约定继续有效，本文在其上扩展。

---

## 一、决策摘要

### 1.1 产品层已批准决策

E1–E38 全文见产品方案 §一，不再复制。技术层关键约束：PostgreSQL 16、Node 22 + TypeScript、Vue 3、服务端原生数据获取、LLM/扶摇凭据只读写 PostgreSQL、LLM 工具参数零信任、Agent 业务写入数据库级互斥、页面业务事实只读、当前策略只允许真人发布、成交归因绑定事件、回测工作运行与最终结论分层、记忆只保存已验证复用产物、临时代码不持久化、Web 外部资料不可信且首期不开放任意 URL 抓取、M3.5 后运行时不读取 `project/` 外文件、跨电脑只同步策略与定时任务固定资产、M4 当前不探测或调用外部 CLI、仅 127.0.0.1。

### 1.2 技术层决策（T1–T45 已确认）

| 编号 | 决策 | 结论 | 依据 |
|------|------|------|------|
| T1 | pi 内核依赖 | `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`，pin 到实施时最新版（撰写时 0.84.2）；不用已停更的 `@mariozechner/*@0.73.1` | 仓库已迁移至 earendil-works/pi；新旧版 API 破坏性变化，新版为 `Models` 集合 + `Agent` 类，调研事实见 §六 |
| T2 | 前端工程 | `project/web/` 独立 Vite + Vue 3 工程；依赖 `vue`、`vue-router`、`echarts`、`markdown-it`、`diff`；状态用 composable，不引入 pinia；构建产物输出 `project/server/public/app/`（gitignored）由 server 托管 | 最小依赖；产物可由源重建，与一期 `dist/` 同规则 |
| T3 | cron 解析 | 引入 `croner`（零依赖、支持时区）；不手写 cron 解析 | 调度正确性敏感，成熟小库优于自研 |
| T4 | 流式协议 | SSE（`text/event-stream`），不用 WebSocket；图片走 multipart 先行上传 | 单向流足够，SSE 断线语义简单 |
| T5 | 确认制实现 | 写类工具返回"提案 + pending_id"，agent 挂起等待；前端确认卡调 `POST /api/confirmations/:id/{approve,reject}` 执行真正写入 | 工具执行与确认解耦，拒绝路径不落库 |
| T6 | 行情表结构 | 单表 `market_bar`，主键 `(instrument_id, freq, bar_date, bar_time)`；日线/30分钟/期货用 `freq` 区分；`bar_time` NOT NULL，日线存当日 00:00:00Z（Postgres 主键列不允许 NULL） | 查询模式统一，避免多表 JOIN |
| T7 | Markdown 渲染 | `markdown-it` + GFM 表格/代码高亮，服务端不渲染，前端渲染 + DOMPurify 级白名单 sanitize（自实现属性过滤，不加 DOMPurify 依赖则用 markdown-it 默认禁用 HTML） | 内容全部来自本库可信源，禁用内嵌 HTML 即可 |
| T8 | 差异视图 | `diff` 包行级 diff，前端渲染双栏 | 成熟小库 |
| T9 | agent 三层 | `agent/ai/` 负责 pi-ai Provider/Models 与凭据适配，`agent/core/` 负责 pi-agent-core loop 和事件映射，`components/chat/` 负责 UI；HTTP/SSE、工具与确认制在三层边界之外编排 | 避免厂商、核心循环和展示状态混在单一 kernel |
| T10 | LLM 配置源 | `llm_provider`、`llm_model`、`llm_setting` 是唯一事实源；`DatabaseCredentialStore` 不回退 `~/.pi/agent/auth.json` 或环境变量；API Key 查询永不回显 | 支持用户自助配置与多厂商切换，安全边界可审计 |
| T11 | 系统级对话与选择器（展示形态已由 T34 重构） | 对话属于全局系统能力和旧 `/chat` 兼容继续有效；原悬浮按钮与抽屉仅作为第二阶段前的历史实现。选择控件继续统一封装 `@vueform/multiselect` | 当前目标布局以 T34 为准，既有消息/工具/确认组件继续复用 |
| T12 | 渐进式数据库读取 | 新会话注册 `database_schema` 与 `database_query`。前者以 `list_tables` 返回轻量表索引，再以 `describe_tables` 按需返回字段、主外键、唯一键、枚举、关系、业务约束与写策略；后者只接受携带逐表 `schema_hash` 的结构化查询计划，不接受原始 SQL | 降低上下文负担，并在执行时防止 Schema 漂移 |
| T13 | 领域表名前缀 | `0005_domain_table_names.sql` 只向前重命名：`data_*`、`market_*`、`portfolio_*`、`agent_*`；已有一致前缀的 task/backtest/pool/strategy/script/chat/llm/volume/schema 表不变。历史自选表已由 0029 删除 | 同领域表可发现、可批量操作，避免 generic 名称冲突 |
| T14 | 批量动作与 UI 聚合 | `fetch_market_data.requests` 最多 200 项，服务端顺序执行并通过 tool_update 汇报进度；UI 对连续同名且无确认卡的调用分组折叠，单批结果优先展示汇总 | 减少模型调用轮次与工具卡噪声，确认内容仍完整可见 |
| T15 | YOLO 与能力提示词（工具集合已由 T42 收敛） | `agent_setting` 持久化 `yolo_mode`；确认制写 pending、YOLO 直接事务执行，两条路径都经领域 service、状态指纹、写锁与审计。现行普通领域写工具为 `portfolio_write`、`pool_write`、`job_write`、`memory_write` 与 `finalize_backtest`；策略发布提案始终要求真人批准。系统提示词动态注入轻量表索引、轻量记忆索引与当前模式 | 保留 YOLO 安全语义，同时以 T42 的现行工具集合为准 |
| T16 | 工具零信任与并发写协调 | pi loop 的 schema 校验不是信任边界；每个 execute/domain 入口再次严格校验并拒绝未知字段和语义歧义。所有 Agent 业务写工具共用按当前数据库区分的 PostgreSQL transaction advisory lock；确认批准锁定提案行并复核目标状态 SHA-256 | LLM 可输出错误参数；多会话与重复确认必须由数据库而非提示词保证一致性 |
| T17 | M3 调度一致性与自动流程权限 | `croner` 只接受 5 段 cron并固定 Asia/Shanghai；`(job_id, scheduled_for)` 部分唯一索引去重，Runner 原子 claim；同一 `job_run` 最多两次尝试。当前只允许 datasource/analysis/agent_flow，agent_flow 工具覆盖为只读集合；旧 script Runner 已退役 | 防重复 tick、自动流程越权与多作业并发写入 |
| T18 | 领域写工具（历史集合，现行以 T42 为准） | 删除通用 `database_change`。历史阶段曾注册自选与回测写工具；0029 后自选工具退役，0030 后由 `run_backtest` 产生工作运行、`finalize_backtest` 晋升最终结论，并新增记忆读写。策略调整只能使用 `strategy_publish_request` 创建待审核提案。领域参数不包含表、列或 SQL；确认与 YOLO 都经正式 service、审计、写锁和状态冲突检测 | 保留历史决策演进，同时以 T42 明确当前工具边界；策略发布始终排除在 YOLO 之外 |
| T19 | 当前策略与冻结内容域 | `strategy_document` 保存当前策略稳定身份，`strategy_document_revision` 只追加内部技术修订，`strategy_state` 保存整体序号与哈希；用户可见历史只读 `strategy_evolution_log` 摘要。`content_*` 的旧策略/指引只保留冻结迁移审计和兼容读取，POST/PATCH 统一拒绝 | 页面只呈现最终策略，同时保留并发一致性、恢复和审计能力 |
| T20 | 作业提示词与结果 | `job_prompt` + `job_prompt_revision` 独立版本化；`job_definition.prompt_id` 引用稳定提示词，`job_run.prompt_revision_id` 固化实际版本。`job_write` 维护定义与提示词，`trigger_job` 只排队；Markdown 产物原子写 `job_run_output` 并关联运行/session，`job_run.result_md` 只兼容读取 | 计划与执行分离，历史运行和领域结果均可解释 |
| T21 | 分析与回测 | 板块温度、关键位、长线估值由 `analysis/` 读结构化表计算；第三阶段仍由固定 `backtest/` 服务异步执行，数据库只保存输入摘要、服务版本、指标、结论、缺口与终态。第四阶段改由 Agent 临时工作器驱动，仍不得保存代码正文或中间文件 | 消除外部 Python 依赖并只保留可复查结论；不把第三阶段固定入口误当目标形态 |
| T22 | 数据交付双轨（由 T45 收敛） | 完整私有备份保留全库并 gitignore；可移植包只承担策略与定时任务固定资产交付，个人与运行数据不进入包 | 新机器可初始化，同时避免跨设备复制个人状态和敏感数据 |
| T23 | 事实源切换 | legacy importer 只读旧文件并记录原路径/mtime/SHA；逐领域对账后才关闭旧读路径。切换后移除 `sync_now`、`read_repo_file`、`REPO_ROOT` 生产引用、Python Runner、旧 MVP 和一期 `/legacy/` | 独立性可由 clean-room 验收证明 |
| T24 | 组合账户资金快照 | `portfolio_write` 以 `action` 区分 `record_position_change` 与 `upsert_account_snapshot`；后者由组合账户 service 校验日期、有限金额和账户恒等式，缺省证券市值按总资产减可用资金推导，并按 `snap_date` upsert。0010 仅向前增加 `closed_pnl` | 复用既有领域写链，避免为资金摘要新增按字段/按表工具，同时保持确认、事务和并发保护 |
| T25 | Agent Flow 数据库原生读取 | Runner 从 `job_prompt_revision` 取得并固化流程提示词，只注册 `database_schema` / `database_query`；0017 后运行前固化 `strategy_state.change_seq/current_hash`，从对应技术修订读取完整当前策略，历史任务结果按 `job_run_output` 查询，不再发现 `content_*`。旧导入器、文件读取和 `job_run.result_md` 新写入均已停止 | 保证任务与交互 Agent 使用同一策略事实，并把计划结果归具体任务而非笼统内容库 |
| T26 | 单一事实源与系统提示词路由 | 0014 物理删除已迁移到 `pool_*`、`portfolio_*`、`job_prompt*` 的 7 份内容副本及其导入证据；`content_legacy_import` 加入 Agent 隐藏表。`buildSystemPrompt` 注入单一事实源映射、数据库化任务路由、目标日计划边界、引用/缺口/实盘例外规则和 `portfolio_account_state` 实时资金摘要；离散人工/券商记录按需查询 `portfolio_account_snapshot` | 从存储、Schema 暴露和模型指令三层防止双事实源与错误路由，并区分实时台账与离散锚点 |
| T27 | 财务估值通道与独立出口 | `fetch_market_data.financial_requests` 直连扶摇估值与三张财务报表；按三表共同存在的最新报告期组装并幂等写 `valuation_snapshot` / `fundamental_snapshot`。最终初始化包携带样本；在无父目录 clean-room 恢复后验证内容、作业、分析、回测、Agent 工具和页面路由，源码边界扫描排除旧文件/脚本运行依赖 | 长线估值不再因缺少财务事实而长期 partial，并以可复查恢复证据证明 M3.5 独立性 |
| T28 | M4 页面解读与外观 | 页面通过单一 `stock:ask-ai` 事件把数据库记录 ID 和解读边界交给全局侧栏，仅预填、不自动发送；沿用现有会话、SSE 和 Agent 数据库工具。主色与明暗外观使用独立状态，支持浅色/深色/跟随系统，ECharts 监听主题事件重绘；动效开关与系统减少动态效果共同生效。外部 CLI 代码、探测和工具注册均不实施 | 复用已审计的对话链，避免复制业务正文或新建旁路 LLM 端点；用户保留发送前控制，主题变化覆盖 CSS 与 Canvas 图表 |
| T29 | 仪表盘状态聚合与响应式布局 | `DashboardView.vue` 复用 `/api/market/coverage`、`/api/jobs`、`/api/positions`、`/api/account/snapshots` 与 `/api/account/summary` 五个现有只读端点；实时总资产/现金取 0020 台账摘要，历史趋势取离散快照，并在前端计算失败/部分失败/错过任务、持仓缺行情、资金锚点相对日线截止滞后和第一大持仓占比。状态总览全宽；账户/待处理、趋势/运行健康采用 `minmax(0, …)` 主次双栏，并在 1040px 断点降为单列；指标在 760px 断点由四列降为两列 | 不为仪表盘增加重复 API 或新事实源；区分实时台账、离散趋势和行情日期，同时消除异构四卡同排造成的窄列、断行和图表不可读 |
| T30 | 会话级模型与输入聚焦态 | 0015 为 `chat_session` 增加 `model_id` 外键；新会话继承 `llm_setting.active_model_id`，发送按会话模型解析运行时。`ChatView.vue` 从模型目录构建会话选择器并按模型能力控制图片；输入框仅由 `.composer-box` 提供单层焦点描边，移除焦点阴影。该阶段只审计压缩接口，后续实现以 T37 为准 | 会话之间的模型选择必须隔离且刷新可恢复；避免把全局默认模型误当作所有历史会话的运行模型 |
| T31 | 全局消息与接口错误提示 | `stores/message.ts` 维护最多四条消息及短时去重，`AppMessageCenter.vue` 通过 Teleport 渲染 success/error/warning/info 四态提示。`api/client.ts` 的 JSON、SSE 和上传失败统一调用 `apiError`；Abort 不报错，SSE 协议内 error 由 `ChatView` 补充。业务 mutation 成功显式调用 success，本地校验调用 warning | 接口失败不能只停留在局部状态或控制台；统一入口避免各页面样式、时长和错误码展示不一致，同时保留加载区原位重试能力 |
| T32 | 当前策略与真人发布 | 第三阶段建立 `strategy_state`、当前策略技术修订、简要演进和 `strategy_publish_proposal`。Agent 只能提交 `pending` 提案；批准/拒绝接口不注册为工具且只接受真实用户主体，YOLO 不参与。发布在同一事务复核基线并更新全部当前文档和整体哈希 | 用户只关心最终策略，但系统仍需并发一致性；策略会改变所有后续 Agent 行为，风险高于普通领域写 |
| T33 | 可持久化 Agent 对话（由 T40 收敛） | `chat_session` 是交互和任务的统一容器，完成消息与工具结果持久化；早期 attempt/resource 投影与专用过程接口由 T40 删除 | 保留统一对话与断线恢复能力，取消重复状态模型 |
| T34 | 常驻可收放工作台与页面刷新 | 第二阶段用布局内 `AgentWorkspace` 替代并删除 `ChatDrawer`；菜单 188/56px，Agent 收起为 48px 轨道、拖动分栏并恢复宽度、session、滚动和草稿。`ui_refresh` 只发布白名单模块事件，前端按游标去重、按模块防抖并局部重新取数；不执行整页重载或任意浏览器控制 | 业务结果和 Agent 过程需要同屏；收放释放空间但不能终止运行；刷新必须保留用户状态 |
| T35 | Agent 自驱回测工作器 | 第四阶段使用 TypeScript 临时工作区、固定回测 SDK 和独立 Node 进程/容器。工作器无外网、无数据库凭据、只读根文件系统并受 CPU/内存/进程/时间限制；代码正文、补丁、路径不得进入消息、审计、确认或备份，终态必须清理 | 复用当前类型与部署体系，并把不可信代码执行边界与主服务、业务事实彻底隔离 |
| T36 | 四阶段发布 | 正式实现按 session 基础、工作台、策略/任务领域归位、自驱回测四阶段串行推进。第一、二阶段不迁移业务事实；第三阶段切换前双读对账、切换后只写新事实源，旧 API 适配读取新表；第四阶段工具默认关闭并通过安全专项后开放 | 避免运行时、事实源和不可信代码执行在同一发布中同时变化；每阶段可独立验收和回退 |
| T37 | Agent 运行控制、任务会话统一与上下文压缩 | `run-control.ts` 维护 `session_id → {run_id, Agent}` 进程内注册表；控制接口携带期望 `run_id` 调用 pi 的 `abort/steer/followUp`。任务与交互会话共用列表和发送入口，类型只保留来源元数据。0018 保存摘要与 `through_seq`，输入估算达到预算 80% 时摘要旧前缀并保留约 18% 近期消息；原始消息不删，工具调用/结果按原子单元保留 | 真正停止服务端工作，避免迟到控制误伤新轮次；让任务结果可在原上下文追问；长会话控制输入规模且保留完整审计历史 |
| T38 | 第四阶段隔离回测与旧入口退役 | 0019 扩展 `backtest_run` 并新增历史比较关系；Agent `run_backtest` 只在本次调用内接收 TypeScript，编译后交给 `node:22-alpine` 容器。容器无网、无数据库凭据、只读根、非 root、drop capabilities，并受 CPU/内存/PID/文件/时间限制；消息、事件、审计、初始化包和数据库只保存代码哈希/字节数。固定服务创建/激活 HTTP、页面表单与 `backtest_write` 已删除 | 不可信代码与主服务隔离；成功、失败、超时、中断和重启均收敛为可审计终态并清理工作区 |
| T39 | 实时资金台账 | 0020 新增单行 `portfolio_account_state`。`upsert_account_snapshot` 在不早于当前锚点时重置现金、清仓收益与锚点；锚点后买入扣现金、卖出回补，完全清仓时删除 `portfolio_position` 当前行并按卖出数量×（成交价－持仓成本）累加清仓收益，历史由 `portfolio_position_change` 追溯。成交、持仓与台账在同一事务并锁定状态行；无锚点不猜现金 | 让页面和 Agent 在两次券商快照之间保持可解释的实时现金口径，并由下一次快照校准漂移 |
| T40 | 定时 Agent 对话化收敛 | 0021 把 `job_run.agent_session_id`、`backtest_run.agent_session_id` 改名为 `session_id`，删除 `agent_session_attempt`、`agent_session_resource` 和 `chat_message.attempt_no`，把保留的低频事件改名为 `chat_session_event`。调度器创建普通任务对话并调用同一个 `runAgentSessionTurn`，重试复用对话历史；结果通过对话 Markdown 链接打开 `job_run_output`。页面快捷 AI 动作二次确认后 POST 新会话并预填记录上下文 | 一条用户可见对话即可承载执行、重试、结果和追问；`job_run`/`backtest_run` 已提供领域状态与直接外键，无需第二套 attempt/resource 投影 |
| T41 | 单轮 Agent 执行轨迹聚合 | `rowsToMessages` 保留持久化 assistant 消息粒度和 toolResult 回填；前端 `groupMessagesIntoTurns` 再以 user 消息为边界，把连续 assistant 消息组合为一个 `UiAgentTurn`。`assistant_start` 只开始卡内新阶段，不创建新的外层气泡。卡内根据后续文本与工具存在性区分思考进展、工具调用和最终回答；工具/确认对象仍引用原 `UiToolCall` 响应式状态 | 不修改 SSE、数据库或审计事实即可统一历史与实时展示；避免多工具轮次产生大量同级气泡，同时不丢失顺序、错误与确认交互 |
| T42 | Agent 主导业务写入与研究闭环 | 0029 扩展 `pool_membership`、建立 `pool_board_preference`、删除自选与持久化标注；0030 为成交事件增加归因，为回测增加 working/final/superseded 状态，并建立 `agent_memory_artifact`。页面删除业务录入和任务定义编辑，任务控制使用独立窄接口；池、持仓、回测和记忆页面只读。系统提示词只注入轻量记忆索引，正文按需查询 | 消除页面与 Agent 双写、独立清单和试验结果污染；保留领域 service、确认/YOLO、写锁、状态冲突和真人策略发布边界 |
| T43 | Provider 抽象与首期 Web Search | `web-research-provider.ts` 保留稳定搜索契约并提供 DeepSeek 原生实现；`web_search` 通过固定 `https://api.deepseek.com/anthropic/v1/messages` 和 `web_search_20250305` 搜索，凭据只读取已启用且 base origin 为官方地址的 `deepseek` 数据库配置。工具参数限长、域名限枚举，结果再按域名、条数、单摘要和总字符上限过滤；成功审计只保存查询哈希。首期不注册 `web_fetch` | 不引入完整 pi-coding-agent 或第三方搜索依赖；避免任意 URL 获取和 SSRF 面，同时让后续 Tavily/Exa 只替换 Provider，不改变模型工具契约 |
| T44 | 行情日线化与市场结构独立导航 | `MarketView` 只保留日线区间对比和日线/期货日线 K 线详情，移除 30 分钟页面入口；`MarketStructureView` 以独立路由和两组 Tab 展示七类结构数据，并使用固定中文列定义。0033 删除 `market_quote_latest`、`market_quote_sample`、`market_runtime_setting` 和 `market_system_tracking.realtime`，服务入口不再启动近实时轮询器，旧 quotes/realtime API 返回 404；池和板块投影改读最新日线。盘后 `daily_market_update` 的扶摇快照转日线及关键位分析使用的 30 分钟数据不变 | 产品明确不支持实时查看后，不再维护会误导用户的订阅、SSE 和盘中采样链路；保留对 Agent 分析仍有价值的受控 30 分钟事实，避免把页面删减扩大为分析能力和历史数据破坏 |
| T45 | 系统凭据与固定资产部署 | 0040 新增单例 `system_setting`，扶摇 Key 由设置 API 写入且 GET 只返回状态；旧 env 仅在首次启动且库中为空时一次性导入。固定资产包 v4 白名单只含 `strategy_*` 当前策略/演进摘要和 `job_definition`/`job_prompt*`，任务定义时间戳在目标机重建；恢复会清空持仓、账户、流水、池、行情和运行结果，保留目标机默认 LLM 目录与空系统设置 | `project/` 单独复制即可恢复长期资产；凭据和个人运行态由每台电脑独立维护，调度器不会追记源电脑停机区间 |

### 1.3 开放问题

| 问题 | 默认行为（未决前） |
|------|---------------------|
| 主色暖橙 `#E8833A` 还是青绿 `#2FA08C` | M1 打样两稿对比，用户选 |
| LLM provider 与模型选择 | 已收敛为 PostgreSQL 配置：设置页维护厂商、模型目录与新会话默认模型，对话框维护当前会话模型；未配置 API Key 时全局对话栏显示引导，系统其余功能不受影响 |
| 标的池角色变更是否免确认 | 与其他领域写入一致：确认制需确认，YOLO 直接执行；页面不提供直接写入口 |

## 二、范围与依赖

### 2.1 里程碑范围

| 里程碑 | 本文对应章节 | 出口标准（产品方案 §十） |
|--------|--------------|--------------------------|
| M1 | §三、§四、§五、§七、§九、§十 | 六类资产可看、行情全读库、迁移对账通过、数据卷演练通过、台账迁移完成 |
| M2 | §六（agent 核心、只读工具、图片、确认流） | 对话可答事实、确认制持仓更新可用 |
| M3 | §八（调度器、datasource/agent_flow 作业） | 每日链路自动跑并入账 |
| M3.5 | §四、§七至§十二（内容/作业事实源、分析、回测、初始化包、切换） | 无父目录文件的干净目录与空库恢复后完整运行 |
| M4 | §六（页面 AI 解读与仪表盘；CLI 桥暂缓）、UI 打磨 | 三类解读入口可追溯且不自动发送；仪表盘异常与日期口径清晰且桌面宽度无挤压；明暗主题、图表、弹层与动效完成收口；生产无 CLI 调用 |
| 阶段一 | §4.12、§6.1–§6.4、§八、§十 | Agent 作业先创建真实 session；交互与任务共用执行边界；低频过程可补发并续流；现有领域事实不变 |
| 阶段二（已完成） | §三、§6.6、前端契约 | 常驻可收放工作台与 `ui_refresh` 可用；旧抽屉已删除；窄屏使用页面下方分区而非悬浮层 |
| 阶段三（已完成） | §4.13、§七、策略/任务 service | 0017 已应用；当前策略与任务结果切换到新事实源；真人发布门禁、真实库对账和安全初始化包恢复通过 |
| 阶段四（已完成） | §4.15、§6.2、回测工作器 | 临时代码验证闭环和清理通过安全专项；旧固定回测创建与剩余兼容写入口已退役 |

### 2.2 外部依赖

| 依赖 | 失败影响 | 降级 |
|------|----------|------|
| 扶摇 API（fuyao.aicubes.cn，`HITHINK_FINANCE_API_KEY`） | 日线/快照/通用端点不可用 | akshare 通道（规范优先级，留痕） |
| 新浪/东财公开 HTTP 接口 | 30分钟/期货/资金流不可用 | 记录缺口；不恢复外部 Python 链路 |
| PostgreSQL 中当前 LLM 模型或 API Key 缺失（M2 起） | 对话不可用 | 设置页可补齐；系统其余功能不受影响 |
| codex / claude CLI（暂缓） | 无影响，当前不探测、不注册委派工具 | 使用 pi 对话主通道 |
| Docker / 本机 Postgres | 库不可用 | 同一 `DATABASE_URL` 切换 |

## 三、目录结构与前端工程（T2）

```
project/
  web/                      Vue 3 源工程（新增）
    index.html
    vite.config.ts          构建输出 ../server/public/app/，dev 代理 /api → 127.0.0.1:8787
    src/
      main.ts  router.ts  theme.css        主题令牌（色板/圆角/动效）集中在 theme.css
      api/client.ts                         fetch 封装 + 统一错误
      components/                           MarkdownView、DiffView、KlineChart、CommandPalette、StatusBar、
                                            chat/AgentWorkspace、
                                            chat/ToolCard、chat/ToolGroupCard、ui/UiSelect …
      views/                                dashboard strategies short-pool long-pool positions
                                            market-detail backtests jobs memories datasync settings
      stores/                               composable 状态（currentInstrument 等）
  server/
    public/app/             前端构建产物（gitignored，由 web 构建生成）
    datasource/             hithink.ts akshare.ts ratelimit.ts service.ts types.ts
    volume/                 完整私有备份 + 安全初始化包导出/恢复
    scheduler/              tick.ts runner.ts（datasource/analysis/agent_flow）
    analysis/               板块温度、关键位、长线估值
    backtest/               数据库行情上的受控回测
    agent/                  ai/{runtime,repo,credentials,routes}.ts（pi-ai + DB 配置）
                            core/loop.ts（pi-agent-core loop）
                            session-runner.ts（阶段一统一持久化执行边界）
                            database-tools.ts tools.ts confirmations.ts routes.ts events.ts
    modules/                content job-prompts backtests positions market pools memory
    migrations/             0002_core.sql 0003_chat_agent.sql 0004_llm_config.sql
                            0005_domain_table_names.sql 0006_agent_settings.sql 0007_jobs.sql
                            0008_content_jobs.sql 0009_analysis_backtest.sql …
                            0015_chat_session_model.sql 0016_agent_session.sql（阶段一）
    uploads/                图片附件（gitignored）
  bootstrap/                可移植安全初始化包（提交前仍需人工审阅正文）
```

- `npm run web:dev`（Vite dev）、`npm run web:build`、server 启动时检测 `server/public/app/index.html`，缺失则 `/` 返回引导提示而不是 404。
- 一期原生台账与旧纯前端 MVP 源码、文件同步/摄取和 CSV 迁移适配器均已删除。
- `.gitignore` 追加：`project/server/public/app/`、`project/server/uploads/`、`project/datavolume/`。

## 四、数据契约（Schema v2，只向前迁移）

一期数据结构沿用。新增迁移按里程碑拆分、只向前执行；M2 模型配置为 `0004_llm_config.sql`，领域表名统一为 `0005_domain_table_names.sql`，Agent 模式为 `0006_agent_settings.sql`，M3 作业迁移顺延为 `0007_jobs.sql`。

### 4.1 `0002_core.sql`：资产与行情（M1，以下表名按 `0005` 迁移后的当前名称展示）

```sql
-- 标的档案
CREATE TABLE market_instrument (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,              -- 000636.SZ / 000001.SH / CU0
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('stock','etf','index','futures')),
  sector_code text,                              -- 板块映射（15 板块受控口径），个股可空
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 池内角色（生效区间版本化，对应标的池.md 的角色/分级/评分）
CREATE TABLE pool_membership (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES market_instrument(id),
  pool           text NOT NULL CHECK (pool IN ('short','long')),
  role           text NOT NULL,                  -- 短线/波段/长线/观察
  grade          text,                           -- 分级
  score          numeric,                        -- 研究评分
  tags           jsonb NOT NULL DEFAULT '[]',    -- 股性标签、跟踪期货标注等
  effective_from date NOT NULL,
  effective_to   date,                           -- NULL = 当前
  note           text,
  UNIQUE (instrument_id, pool, effective_from)
);

-- 0029 后池关系继续使用带有效期的 pool_membership，并补齐完整研究属性。
ALTER TABLE pool_membership
  ADD COLUMN stock_character text,
  ADD COLUMN stage text,
  ADD COLUMN evaluation_summary text,
  ADD COLUMN attention_reason text,
  ADD COLUMN attention_from date,
  ADD COLUMN attention_until date,
  ADD COLUMN evaluation_session_id bigint REFERENCES chat_session(id);
CREATE UNIQUE INDEX pool_membership_one_current_role
  ON pool_membership (instrument_id) WHERE effective_to IS NULL;
CREATE TABLE pool_board_preference (
  pool text NOT NULL CHECK (pool IN ('short','long')),
  board_instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  sort integer NOT NULL DEFAULT 0,
  PRIMARY KEY (pool, board_instrument_id)
);

-- 独立自选和持久化图表标注已由 0029 向前删除；历史迁移文件保留审计，不回改。

-- 持仓（当前）与变更事件流
CREATE TABLE portfolio_position (
  instrument_id   bigint PRIMARY KEY REFERENCES market_instrument(id),
  quantity        numeric NOT NULL,
  cost_price      numeric NOT NULL,
  cost_basis      text,                          -- 成本口径原文（券商显示/策略参考等）
  opened_at       date,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portfolio_position_change (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  bigint NOT NULL REFERENCES market_instrument(id),
  change_date    date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('buy','sell','adjust','note')),
  quantity       numeric,
  price          numeric,
  amount         numeric,
  reason         text,
  source         text NOT NULL CHECK (source IN ('form','chat','job','ingest')),
  confirmation_id bigint,                      -- 确认制关联（§六）
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- 每日快照（收益曲线数据源；历史只含已记录离散点）
CREATE TABLE portfolio_position_snapshot_daily (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snap_date      date NOT NULL,
  instrument_id  bigint NOT NULL REFERENCES market_instrument(id),
  quantity       numeric NOT NULL,
  cost_price     numeric NOT NULL,
  close          numeric,
  market_value   numeric,
  pnl_amount     numeric,
  stop_price     numeric,                        -- 执行位结果值（不含公式）
  target_price   numeric,
  UNIQUE (snap_date, instrument_id)
);
CREATE TABLE portfolio_account_snapshot (
  snap_date      date PRIMARY KEY,
  total_asset    numeric,
  market_value   numeric,
  cash           numeric,
  raw_text       text,                           -- 原始文本（保留约数标记）
  precision      text NOT NULL DEFAULT 'exact' CHECK (precision IN ('exact','approx')),
  source         text NOT NULL DEFAULT 'ingest'  -- ingest / job / form
);

-- 行情唯一数据源
CREATE TABLE market_bar (
  instrument_id  bigint NOT NULL REFERENCES market_instrument(id),
  freq           text NOT NULL CHECK (freq IN ('day','30m','futures_day')),
  bar_date       date NOT NULL,
  bar_time       timestamptz NOT NULL,           -- day/futures_day 存当日 00:00:00Z；30m 存实际时刻（主键列不可空）
  open   numeric NOT NULL, high numeric NOT NULL,
  low    numeric NOT NULL, close numeric NOT NULL,
  volume numeric,
  ma5 numeric, ma10 numeric, ma20 numeric, ma60 numeric,
  adjustment   text,                             -- forward/none/NULL=未知
  volume_unit  text,                             -- NULL=未知
  channel      text NOT NULL,                    -- hithink/sina/eastmoney/migrate
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, freq, bar_date, bar_time)
);
CREATE INDEX market_bar_lookup ON market_bar (instrument_id, freq, bar_date DESC);

-- 每次获取记录
CREATE TABLE market_fetch_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_run_id  bigint,                            -- 由调度触发时关联
  channel     text NOT NULL,
  scope       jsonb NOT NULL,                    -- {instruments, range, freq}
  rows_written int NOT NULL DEFAULT 0,
  degraded_from text,                            -- 降级原因
  gaps        jsonb NOT NULL DEFAULT '[]',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- 数据卷快照登记
CREATE TABLE volume_snapshot (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path       text NOT NULL,                      -- datavolume 相对路径
  created_at timestamptz NOT NULL DEFAULT now(),
  manifest   jsonb NOT NULL,                     -- 表行数、coverage、校验和
  kind       text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled','manual'))
);

-- 策略文档与脚本版本（同构）
CREATE TABLE strategy_doc (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path text NOT NULL UNIQUE,                     -- 仓库相对路径
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE strategy_version (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id         bigint NOT NULL REFERENCES strategy_doc(id) ON DELETE CASCADE,
  version_no     int NOT NULL,
  sha256         text NOT NULL,
  content        text NOT NULL,
  change_summary text,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version_no)
);
CREATE TABLE script_registry (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE script_version (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script_id      bigint NOT NULL REFERENCES script_registry(id) ON DELETE CASCADE,
  version_no     int NOT NULL,
  sha256         text NOT NULL,
  content        text NOT NULL,
  change_summary text,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (script_id, version_no)
);

-- 回测引擎版本哈希
ALTER TABLE backtest_run ADD COLUMN engine_sha256 text;
```

### 4.2 `0003_chat_agent.sql`（M2/M4，以下表名按 `0005` 迁移后的当前名称展示）

```sql
CREATE TABLE chat_session (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL DEFAULT '新会话',
  archived   boolean NOT NULL DEFAULT false,
  model_id   bigint REFERENCES llm_model(id) ON DELETE SET NULL, -- 0015 追加；会话固定模型
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_message (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  seq         int NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content     jsonb NOT NULL,        -- pi Message 序列化（文本/图片/工具调用块）
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE TABLE chat_attachment (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  path        text NOT NULL,         -- uploads/ 相对路径
  mime_type   text NOT NULL,
  size_bytes  int NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 确认制提案
CREATE TABLE agent_confirmation (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint REFERENCES chat_session(id),
  tool_name   text NOT NULL,
  payload     jsonb NOT NULL,        -- 提案全文（变更前后 diff 所需数据）
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_at  timestamptz,
  result      jsonb,                 -- 执行结果摘要
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_tool_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint,
  tool_name   text NOT NULL,
  args        jsonb NOT NULL,
  result_sha256 text,
  status      text NOT NULL,         -- ok/error/blocked/pending
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_external_cli_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  bigint,
  agent       text NOT NULL CHECK (agent IN ('codex','claude')),
  prompt      text NOT NULL,
  exit_code   int,
  output_sha256 text,
  timed_out   boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
```

### 4.3 `0004_llm_config.sql`（M2 优化）

```sql
CREATE TABLE llm_provider (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key text NOT NULL UNIQUE,
  name         text NOT NULL,
  api_protocol text NOT NULL CHECK (api_protocol IN
                 ('openai-completions','openai-responses','anthropic-messages')),
  base_url     text NOT NULL,
  api_key      text,                              -- 只供服务端读取，查询 API 不返回
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llm_model (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id      bigint NOT NULL REFERENCES llm_provider(id) ON DELETE CASCADE,
  model_key        text NOT NULL,
  name             text NOT NULL,
  input_modalities jsonb NOT NULL DEFAULT '["text"]',
  reasoning        boolean NOT NULL DEFAULT false,
  context_window   int NOT NULL DEFAULT 128000,
  max_tokens       int NOT NULL DEFAULT 8192,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_key)
);
CREATE TABLE llm_setting (
  singleton       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_model_id bigint REFERENCES llm_model(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

- 迁移只预置 DeepSeek、小米、OpenAI、Anthropic 的可编辑模板与示例模型，不写任何 API Key；默认选中 DeepSeek 模型但保持“待密钥”。
- `llm_setting` 只允许一行；当前模型必须启用且所属厂商启用。删除当前模型或当前厂商返回 409，需先切换。
- 供应商查询只返回 `api_key_configured: boolean`；更新请求中空字符串表示清除密钥。

### 4.4 `0005_domain_table_names.sql`（M2 补强）

该迁移只执行 `ALTER TABLE ... RENAME TO ...`，不复制、不删除数据；PostgreSQL 自动更新外键引用。最终表名映射：

| 旧名 | 当前名 | 领域 |
|------|--------|------|
| `dataset` | `data_dataset` | 数据资产 |
| `instrument` | `market_instrument` | 行情/标的 |
| `fetch_run` | `market_fetch_run` | 行情获取 |
| `position` | `portfolio_position` | 组合持仓 |
| `position_change` | `portfolio_position_change` | 组合持仓 |
| `position_snapshot_daily` | `portfolio_position_snapshot_daily` | 组合持仓 |
| `account_snapshot` | `portfolio_account_snapshot` | 组合账户 |
| `confirmation` | `agent_confirmation` | agent 确认制 |
| `external_cli_run` | `agent_external_cli_run` | agent 委派审计 |

其余表已具有领域前缀，不重命名。旧 `database_change` 记录与 pending 提案不做兼容执行，必须按新领域工具重新发起。

### 4.5 `0006_agent_settings.sql`（M2 补强）

`agent_setting` 是单行全局设置表，`yolo_mode boolean NOT NULL DEFAULT false`。设置 API 只接受布尔值；每次构造系统提示词和执行领域写工具时读取当前值，修改后无需重启。

### 4.6 `0007_jobs.sql`（M3）

```sql
CREATE TABLE job_definition (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  cron       text NOT NULL,
  job_type   text NOT NULL CHECK (job_type IN ('datasource','script','agent_flow')),
  config     jsonb NOT NULL DEFAULT '{}',   -- datasource: 范围; script: 白名单命令 id; agent_flow: 非提示词运行参数
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      bigint NOT NULL REFERENCES job_definition(id),
  task_run_id bigint REFERENCES task_run(id) ON DELETE SET NULL,
  target_date date NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('cron','manual')),
  scheduled_for timestamptz,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','success','failed','partial','missed')),
  attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  next_retry_at timestamptz,
  log         text NOT NULL DEFAULT '',
  artifacts   jsonb NOT NULL DEFAULT '[]',
  data_gaps   jsonb NOT NULL DEFAULT '[]',
  result_md   text,                          -- agent_flow 产出 Markdown
  started_at  timestamptz, finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_run_job_date ON job_run (job_id, target_date DESC);
CREATE UNIQUE INDEX job_run_scheduled_once
  ON job_run (job_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
```

`market_fetch_run.job_run_id` 在 0007 增加到 `job_run(id)` 的外键。初始作业由迁移插入；当前 datasource 的 config 只保存 pipeline，agent_flow 通过 `prompt_id` 绑定数据库提示词，不在 config 保存模板路径或策略参数。`job_definition`、`job_run` 是 Agent 通用数据库工具的保护表，只可通过作业专用 API 与 `trigger_job` 维护。

一期 `task_run` 只读保留历史记录；当前系统调度统一写 `job_run`，新 Runner 不再为 agent_flow 复制登记 `task_run`。

### 4.7 `0008_content_jobs.sql`（M3.5 内容与提示词事实源）

- `content_document(code, title, content_type, status, legacy_path, current_revision_id, created_at, updated_at)`：`content_type` 限定 `strategy | guidance | trading_plan | archive`；常规内容操作不物理删除，0014 的固定迁移清理是一次性例外。
- `content_revision(document_id, revision_no, content, sha256, source, base_revision_id, change_summary, created_at)`：唯一 `(document_id, revision_no)` 与 `(document_id, sha256)`；`source` 限定 `legacy_import | user | agent | rollback`。服务层在同一事务锁定文档行并校验 `base_revision_id = current_revision_id`。
- `job_prompt(code, name, status, current_revision_id, created_at, updated_at)` 与 `job_prompt_revision(prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary, created_at)`：同样只追加版本。
- `job_definition.prompt_id` 新增可空外键；`job_run.prompt_revision_id` 新增可空外键。Runner 只认外键，缺失即失败，不回退文件；0012 清除初始作业遗留的 `config.template_path`，0013 继续清除不再使用的 `task_code`。
- 既有 `strategy_doc/strategy_version` 迁入 `content_*`，以原 path 与 sha 去重；0008 创建三个稳定提示词身份并绑定现有 agent_flow 作业，0012 直接追加数据库原生正文。迁移完成后旧导入器删除，避免重新引入文件副本。

### 4.8 `0009_analysis_backtest.sql`（M3.5 分析与回测结论）

- `analysis_run` 保存 `analysis_type`、结构化 request、输入摘要、服务版本、状态、结果、缺口与时间戳；状态为 `queued | running | success | partial | failed`。
- `fundamental_snapshot` / `valuation_snapshot` 以标的和 `as_of_date` 唯一，承载长线估值所需结构化事实；datasource 负责获取和校验，不读取 CSV。
- `backtest_run` 只向前增加 `request_json`、`input_summary`、`service_version`、`metrics_json`、`conclusion_md`、`data_gaps`、`progress`；旧字段与 `backtest_artifact` 暂保留历史兼容但不再由新执行器写入，待对账后退役。
- 作业、分析和回测运行历史只允许状态机推进，不允许 Agent 任意更新或删除。

### 4.9 `0010`–`0014`（账户摘要、数据库原生 Flow 与单一事实源）

- 0010 为 `portfolio_account_snapshot` 增加累计清仓收益，不改变既有快照键和写入 service。
- 0011 把指引类内容纠正为 `guidance`，并临时归档已由结构化表或作业提示词接管的旧内容条目。
- 0012 为三个内置 agent_flow 追加数据库原生提示词版本，原子切换 `current_revision_id` 并清除旧文件配置；历史提示词版本继续保留。
- 0013 清除 agent_flow 的 `task_code`，新运行结果只保存到 `job_run`，不再复制登记一期 `task_run`。
- 0014 删除短线/长线标的池、三个任务模板和 2026 年 7/8 月持仓流水共 7 份内容文档、正文版本及对应迁移证据。迁移只按固定 `legacy_path` 命中，保留策略、指引、当前计划和计划归档。

### 4.10 `0015`（会话级模型）

- 0015 为 `chat_session` 增加可空 `model_id`，外键指向 `llm_model(id)` 并使用 `ON DELETE SET NULL`；现有会话在迁移时继承 `llm_setting.active_model_id`，新会话创建时继承当时的全局默认模型。
- 对话框切换模型只更新当前会话；发送前按 `chat_session.model_id` 读取并复核模型、厂商和 API Key。外键因模型删除而置空时回退到当前全局默认模型，避免保留失效引用。

### 4.11 已完成的切换顺序

1. 应用 0008/0009，旧读路径保持可用；运行 legacy importer，记录逐文件 SHA、mtime、目标 revision。
2. 对账策略/指引/计划/归档、提示词、结构化持仓/标的池和旧回测结论；差异未清零时不切换。
3. 内容 API/UI、Agent 工具和 Runner 先切数据库读写；观察期可通过数据库导出恢复内容版本，但不回写旧文件。
4. 用户确认事实源切换后，删除生产注册中的 `sync_now`/`read_repo_file`、Python script Runner 与 `REPO_ROOT`；再做引用扫描和全量回归。
5. 删除旧纯前端 MVP 构建源码、专属测试/scripts/依赖；0014 最后清除已迁移领域的内容副本。后续恢复只使用数据库备份或初始化包，不恢复文件读取兼容层。

### 4.12 `0016_agent_session.sql`（历史第一阶段）

0016 首次为 `chat_session` 增加 `session_type`、`session_status`、`source`、`parent_session_id`、策略快照和终态字段，使交互、任务、回测与策略演进具备公共会话身份。该迁移曾引入一套任务过程投影；当前有效结构已由 0021 收敛，运行时只使用普通会话、领域直接外键和通用低频事件。

### 4.13 `0017_strategy_job_outputs.sql`（第三阶段当前策略与任务结果）

- `strategy_document` 保存 8 份当前策略/核心指引的稳定身份、角色和注入顺序；`strategy_document_revision` 只追加内部技术修订。`strategy_state` 以单行 `change_seq + current_hash` 锁定完整策略集合，哈希按注入顺序聚合各文档 SHA-256。
- `strategy_evolution_log` 只保存用户可见的大纲、结论、调整点和采纳状态；`strategy_evolution_backtest` 只关联已完成回测 ID。页面不提供历史正文选择、长期 diff 或回滚入口。
- `strategy_publish_proposal` 保存基线序号/哈希和待审多文档正文。`strategy_publish_request` 绑定服务端当前 session，只能创建 `pending`；即使 YOLO 已开启也不进入普通 confirmation。批准/拒绝只接受当前策略页面的真实用户字段和 5 分钟一次性内存令牌。
- 批准事务锁定策略状态、提案和目标文档，重验整体基线与逐文档修订；冲突时正文不变并把提案标记 `conflict`。成功时追加技术修订、更新当前指针、整体哈希和 `change_seq`；批准、拒绝或冲突后清除拟议全文。
- `job_run` 新增策略序号/哈希；Agent Flow 首次运行固化快照，自动重试按技术修订恢复同一快照。`job_run_output` 保存任务领域结果并关联 job、run、session、目标日与策略快照；Markdown 结果和运行终态同事务提交，`job_run.result_md` 不再新写。
- 0017 从冻结 `content_*` 的当前指针只迁 8 份最终正文，不构造演进；19 份历史每日计划归 `daily_plan_flow`，允许 `run_id IS NULL` 以避免伪造历史运行。三份内置 Flow 提示词追加 v3，改读当前策略快照和任务结果域。
- 旧内容 API 与 `content_write` 已删除。Agent Schema 隐藏冻结内容表，新增策略和任务结果元数据。

### 4.14 `0018_agent_context_compaction.sql`（M4 Agent 生命周期）

- `chat_session.context_summary` 保存模型可见的历史摘要，`context_summary_through_seq` 是被摘要替换的最后原始消息序号，`context_summary_estimated_tokens` 与 `context_compacted_at` 用于审计和界面状态。
- `chat_message` 不删除、不改写；摘要边界只能前进。模型输入由摘要和边界后的原始消息重建，页面历史仍读取全部消息。
- `job_run.status` 增加 `cancelled`；用户中断任务 Agent 后，当前 attempt 与 session 同步为 cancelled，任务不进入自动重试。已完成的工具事务不做补偿回滚。

### 4.15 `0019_agent_backtest_workspace.sql`（第四阶段隔离回测）

- `backtest_run` 新增 `execution_origin`、当前有效的 `session_id`、策略序号/哈希、研究大纲、假设、工作器/SDK 版本、源码 SHA-256/字节数与清理状态；没有源码、补丁、临时路径或 stdout/stderr 列。
- `backtest_run_comparison(run_id, compared_run_id, relation)` 只保存回测间的历史对比关系，禁止自关联；回测直接由 `backtest_run.session_id` 关联来源会话。
- 新运行只能由有持久化 session 的 Agent `run_backtest` 创建。主服务读取结构化日线并生成只读输入快照；源码编译后进入一次性工作区，工作器终态后 `finally` 删除目录。服务启动清理遗留目录，并把无法恢复源码的 queued/running 记录标记失败。
- `backtest_run.request_json` 不含源码；统一脱敏器在消息、事件、工具审计、资源元数据和初始化包导出前把 `source_code` 替换为 SHA-256、字节数和 `persisted=false`。PostgreSQL 时间戳先标准化为 ISO 文本，避免通用对象递归破坏恢复数据。

### 4.16 `0020_portfolio_account_state.sql`（实时资金台账）

- `portfolio_account_state` 是 `id=true` 的单行表，保存 `cash`、`closed_pnl`、`anchor_date` 与 `updated_at`；安全初始化包排除该表，完整私有备份保留。
- `upsert_account_snapshot` 仍把原始人工/券商点写入 `portfolio_account_snapshot`；当快照日期不早于现有锚点时，在同一事务把实时台账重锚到该快照。更早快照只补历史序列，不倒退当前状态。
- `record_position_change` 在持仓事务内 `FOR UPDATE` 锁台账：仅处理 `change_date > anchor_date` 的买卖；买入扣减成交金额，现金不足抛 400 并回滚持仓/事件/台账；卖出回补成交金额，卖后数量为 0 时删除当前持仓行并累加本次清仓收益，历史保留在事件流。`adjust`、`note` 和锚点日及以前成交不改台账。
- `/api/account/summary` 以台账给出实时现金/清仓收益，以当前持仓乘最新收盘派生证券市值和总资金；缺行情计入 `missing_quote`。无台账时 `tracked=false`，现金与总资金返回空值。

### 4.17 `0021_chat_first_agent_jobs.sql`（定时 Agent 对话化）

- `job_run.session_id` 和 `backtest_run.session_id` 是领域记录到普通会话的直接外键；任务尝试次数只由 `job_run.attempt_count` 维护。
- 删除任务专用的尝试和资源投影，`chat_message` 不再保存尝试号；保留的 `chat_session_event` 只承载所有会话共有的完成消息、工具、确认、状态、控制、压缩和刷新事件。
- agent_flow 排队与 `session_type='job'` 会话在同一事务创建。固化任务提示词是第一条用户消息；自动重试读取同一会话历史并追加重试说明，不创建子过程。
- `job_run` 终态与 `job_run_output` 同事务提交，随后在会话追加结果链接。任务中心和 Agent 侧边栏只打开这一个会话，不维护独立过程视图。
- 快捷 AI 入口必须先由用户二次确认；确认后创建独立的普通、回测或策略演进会话，写入父会话引用并只预填上下文，绝不自动发送。

### 4.18 `0029_agent_first_pools.sql`（Agent 主导池与行情重构）

- `pool_membership` 增加股性、阶段、评估摘要、近期关注区间和评估来源会话；部分索引 `pool_membership_one_current_role` 保证同一标的只有一个当前角色。
- `pool_board_preference(pool, board_instrument_id)` 保存短线池/长线池各自的常用行业顺序，不改写官方板块目录。
- 迁移先检查旧自选中是否存在没有当前策略角色的标的；若存在则中止，避免把未评估标的自动迁入池。
- 对账通过后向前删除旧自选三表和 `chart_annotation`。服务端移除对应模块和工具，前端同步移除画线能力。

### 4.19 `0030_attribution_backtest_memory.sql`（成交归因、最终回测与记忆）

- `portfolio_position_change` 增加 `decision_origin`、`execution_compliance`、策略序号/哈希、可选计划结果、来源会话、归因说明和偏离原因；计划外或执行偏离必须提供原因。`recordPositionChange` 在事务内读取当前 `strategy_state` 并固化快照。
- `backtest_run` 增加 `conclusion_status`、结论摘要、适用边界、确认时间和替代关系。默认工作运行是 `working`；`finalizeBacktest` 只允许当前会话的 success/partial 运行晋升，同会话旧 `final` 原子改为 `superseded`。
- `agent_memory_artifact` 保存标题、类型、摘要、正文、标签、适用范围、来源会话/运行、证据、状态、替代关系和最后验证时间。有效主题有唯一约束；写入 service 拒绝密钥、临时代码、当前持仓与策略正文副本。
- 可移植初始化包仅加入池研究字段、板块偏好和已脱敏记忆结构；仍排除聊天、确认审计、持仓账户与临时代码。

### 4.20 `0038_official_industry_pool.sql`（官方行业唯一口径）

- 标的池所属行业只投影 `source='hithink' AND board_type='industry'` 的当前有效关系；股票入池前必须已有该关系，ETF 不强制。
- 删除池中的旧本地板块标签和非官方行业排序偏好，移除池记录上的独立行业选择字段；所属行业不再由 Agent 或本地迁移标签指定。
- 板块目录仍可保留同花顺行业、概念、区域和特色分类，但标的池导航、行业顺序和“所属行业”列只使用官方行业。

## 五、datasource 模块（E11，M1 核心）

### 5.1 通道抽象

```typescript
interface FetchRequest { code: string; freq: 'day'|'30m'|'futures_day'; start: string; end: string }
interface FetchResult { bars: Bar[]; channel: string; degradedFrom?: string }
interface Channel { name: string; supports(req: FetchRequest): boolean; fetch(req: FetchRequest): Promise<Bar[]> }
```

`service.ts` 按 `数据获取规范.md` 优先级编排：hithink → akshare 通道；降级写 `market_fetch_run.degraded_from`，不静默切换。写入 `market_bar` 幂等（主键冲突更新），每次写入记录 `market_fetch_run`。

### 5.2 hithink 通道（`hithink.ts`）

- 直连 `https://fuyao.aicubes.cn`：kline（单标的、≤3 年、日线、`.SH/.SZ` 后缀、股票默认前复权）、按资产类型的行情快照、通用端点。股票使用 `/api/a-share/prices/snapshot`、指数使用 `/api/a-share-index/prices/snapshot`，两者传批量 `thscodes`；ETF 使用 `/api/fund/market/snapshot`，按单只 `thscode` 请求。
- 认证：请求头 `X-api-key` 携带 PostgreSQL `system_setting.hithink_api_key`；设置 API 只回显配置状态，Key 不入日志、URL、审计或固定资产包。旧 `HITHINK_FINANCE_API_KEY` 只用于 0040 首次启动兼容导入，运行请求不再读取 env。
- 信封：`code==0` 才成功；`code=4001`/HTTP 429 时指数退避重试（最多 2 次），批量串行、请求间隔 ≥3 秒（`ratelimit.ts` 实现令牌桶）。
- 行情、估值、利润表、资产负债表和现金流量表端点均按扶摇官方接口逐端点验证；财务写入只采用三表共同存在的最新报告期。

### 5.3 akshare 通道（`akshare.ts`，直连底层公开接口，不经 Python）

| 能力 | 底层接口 | 备注 |
|------|----------|------|
| 30 分钟线 | 新浪 `stock_zh_a_minute` 同源 HTTP（period=30、不复权、sh/sz 前缀） | 口径与 `fetch_30m_data.py` 一致：末价与日线收盘偏差 >3% 弃用 |
| 期货主力连续日线 | 新浪 `futures_main_sina` 同源 HTTP | 合约拼接序列只表趋势，当年起窗口覆盖拉取 |
| 个股资金流 | `https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get`（参数按规范 §2.3） | 主域 IP 风控，禁止走 push2his 主域；实测（2026-08-16）日级仅返回最近 1 个交易日，资金流暂只取数不落库，存储位置待后续明确 |

### 5.4 每日更新链路（datasource 作业）

1. 先按 `market_instrument.kind` 将持仓/池内标的，以及全部活跃指数和板块，分成股票、指数/板块和 ETF 三组，再调用各自快照端点追加最新交易日；单组快照失败时只对该组逐只重拉 kline。缺口 >1 日或除权跳空时也对该标的 kline 重拉；重拉全部成功时原快照错误仅保留在 `market_fetch_run` 审计中，不计为作业最终数据缺口。板块和大盘指数查看时若所选日线区间尚未入库，按扶摇单次不超过 3 年的边界分段拉取并持久化；普通池外股票仍只做响应内临时计算。
2. 落库后补算 MA5/10/20/60（服务端 TS 实现，窗口不足留空）。
3. 拉期货主力连续与关键位所需 30 分钟线。
4. 写 `market_fetch_run` 汇总与缺口；链路末尾触发数据卷导出（M1 先手动/CLI，M3 接入调度）。

### 5.5 已完成的一次性历史迁移

M1 曾用受控适配器把历史 CSV 解析、校验并写入 `market_bar`，逐文件行数、日期范围和库内计数已全部对账。该适配器、CSV 导出和生产路由已在 M3.5 删除；报告只作为迁移审计保留，当前服务不扫描或读取旧目录。

### 5.6 财务与估值闭环

`fetch_market_data` 保持一个聚合工具：`requests` 批量处理行情，`financial_requests` 批量处理标的财务与估值。每个财务请求顺序拉取估值、利润表、资产负债表和现金流量表，严格校验扶摇信封与数值；三张报表按报告期取交集，只组装共同存在的最新期。`valuation_snapshot(instrument_id, as_of_date)` 与 `fundamental_snapshot(instrument_id, report_date)` 使用唯一键幂等写入，单项失败继续其余项并返回成功/失败/写入量汇总。板块温度、关键位、长线估值均由 `analysis/` 直接读数据库，不存在脚本导出或外部 Python 过渡路径。

## 六、agent 集成（E6，M2/M4）

### 6.1 AI / core / session / UI 四层接入（T1、T9–T11、T33–T34、T37）

```typescript
// AI 层：从 PostgreSQL 读取当前厂商/模型，注册对应协议并用数据库凭据适配器鉴权。
const runtime = await resolveActiveChatModel(pool, session.model_id);

// core 层：只消费统一的 model + streamFn，不感知厂商协议、Base URL 或凭据存储。
const agent = new Agent({
  initialState: { systemPrompt, model: runtime.model, thinkingLevel: 'medium', tools, messages: restored },
  streamFn: runtime.models.streamSimple.bind(runtime.models),
  sessionId: `chat-${chatSessionId}`,
});
agent.subscribe((event) => /* 映射为领域无关 frame，再由 HTTP 层编码为 SSE */);
await agent.prompt(text, images);   // images: ImageContent[]（base64 + mimeType）
```

- AI 层（`server/agent/ai/`）：`repo.ts` 读写 `llm_*` 三表；`DatabaseCredentialStore` 实现 pi-ai `CredentialStore`，只访问 PostgreSQL；`runtime.ts` 根据 `api_protocol` 注册 OpenAI Completions / OpenAI Responses / Anthropic Messages Provider。
- core 层（`server/agent/core/loop.ts`）：只负责注册工具、运行 `Agent.prompt`，把 pi 事件映射为 `run_started/assistant_start/text/tool_*/confirmation_pending` frame；不持久化数据库、不编码 HTTP。创建 Agent 后以 UUID `run_id` 注册，结束后按同一令牌安全注销。
- session 层（`server/agent/session-runner.ts`）：交互和定时 `agent_flow` 的统一执行边界；解析会话模型、构造系统提示词、读取历史、串行化同 session turn、持久化完成消息/工具/状态事件，再交给 HTTP 或调度器。任务重试继续读取同一会话历史。
- UI 层：布局内 `AgentWorkspace` 复用消息、图片、工具卡与确认卡；同一用户轮次内连续 assistant 消息聚合为一张执行轨迹卡，内部区分思考进展、工具调用和最终回答。运行中输入框保持可编辑，可选择干预、排到下一轮或停止。任务会话显示来源/状态标签但不使用另一套 UI。
- 会话持久化：`agent.state.messages` 为纯 JSON，序列化存入 `chat_message.content`。完成消息入库后写 `message_completed` 事件，逐 token `text` 仅实时推送、不入事件表；任务重试次数只查 `job_run.attempt_count`。
- 会话模型：`chat_session.model_id` 是当前会话的模型事实；设置页 `llm_setting.active_model_id` 仅作为新会话默认值和空会话模型的回退。PATCH 会话模型时先验证模型、厂商启用状态与厂商密钥，发送时再次按会话值解析运行时。
- 上下文压缩：`context-compaction.ts` 读取全部原始消息与上次检查点，先把旧超大 `toolResult` 的模型视图裁到 12000 字符，再按 assistant toolCall + 紧随 toolResult 构造不可拆原子单元。估算输入达到可用预算 80% 时，用同一会话模型把较早前缀和已有摘要合并为中文事实摘要，保留约 18% 最近消息；摘要失败时使用受限的确定性文本作为降级。摘要只写 `chat_session` 检查点，`chat_message` 永久保留。
- 运行控制：`run-control.ts` 的注册表只保存当前进程活跃 Agent。`abort` 先清空队列再调用 `agent.abort()`；`steer` 调用 `agent.steer()`，在当前 assistant turn 与工具批次完成后的下一模型边界消费；`follow_up` 调用 `agent.followUp()`，仅在本轮原本应结束时消费。三者均校验调用方期望 `run_id`，服务重启后旧令牌自然失效。
- 版本锁定：`@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` 均 pin `0.84.2` 精确版本。
- 错误语义：LLM 错误由 core 以结果返回；session 层先写错误摘要和状态事件，再由交互 HTTP 映射为 SSE 错误帧，或由调度器进入同一 session 的下一 attempt/最终失败。
- vision：用 `model.input.includes('image')` 探测；不支持时前端禁用上传并提示。
- 配置安全：生产路径不读取 `LLM_PROVIDER`、`LLM_MODEL`、LLM 环境变量或 `~/.pi/agent/auth.json`；所有配置更新即时生效，不需要重启服务。

### 6.2 工具注册（T12、T14、T16、T18、T24、T43）

新会话只注册：

| 工具 | 契约 |
|------|------|
| `database_schema` | `list_tables` 返回表名、领域、业务说明与逐表 `schema_hash`；`describe_tables` 必须回传该哈希，单次最多 20 张表，返回字段、主外键、唯一键、枚举、双向关系、检查约束、业务约束、敏感列隐藏数量和写入策略。 |
| `database_query` | `queries` 一次最多 30 项；每项必须携带对应表 `schema_hash`，支持列选择、结构化 filters、排序、count、limit/offset。默认最多 100 行，硬上限 500 行。执行前重算哈希，不一致抛 `DATABASE_SCHEMA_CHANGED` 且不执行查询。 |
| `memory_query` | 按关键词、类型、标签和状态检索记忆；默认状态为 active，正文只在工具查询时返回，不全量进入系统提示词。 |
| `web_search` | 通过 `WebResearchProvider` 搜索当前外部资料；首期使用 DeepSeek 原生服务端搜索，只保留白名单域名，返回标题、URL、来源域名、发布时间或缺失标记、抓取时间和摘要。结果为不可信外部资料，不得覆盖库内事实或触发业务写入；不提供 `web_fetch`。 |
| `portfolio_write` | `record_position_change` 记录 buy/sell/adjust/note，固化 0030 归因与策略快照，并维护事件流、当前持仓与实时资金台账；`upsert_account_snapshot` 维护人工/券商锚点。 |
| `pool_write` | add/update/remove 角色；新增/更新必须提供完整研究属性，股票必须已有同花顺官方行业关系；拒绝本地板块标签和自行指定行业字段。service 关闭旧有效行并保留历史，数据库保证全局唯一当前角色。 |
| `job_write` | 创建或修改受控作业与版本化提示词；不允许修改运行历史。 |
| `finalize_backtest` | 只允许当前会话的 success/partial 工作运行晋升为 final；写入结论摘要与适用边界，同会话旧 final 原子改为 superseded。 |
| `memory_write` | create/update/supersede/deprecate 记忆；必须绑定来源会话、证据和最后验证时间，并通过可复用内容门禁。 |
| `strategy_publish_request` | 只创建待真人审核的当前策略发布提案；批准/拒绝接口不注册为工具，YOLO 不生效。 |
| `analysis_run` | 批量运行受控分析并保存结果与缺口。 |
| `run_backtest` | 在隔离的临时 TypeScript 工作区同步验证策略思路；源码只存在于工具参数内存与一次性目录，返回 working 运行摘要并保存历史对比关系，不自动进入回测历史。 |
| `fetch_market_data` | `requests` 一次最多 200 项，顺序调用 datasource；`tool_update` 汇报 total/completed/succeeded/failed/rows_written，默认单项失败后继续。 |
| `trigger_job` | 只按现有 `job_definition.code` 排队受控作业；queued 不等于完成。 |
| `ui_refresh` | 只发布 dashboard/positions/jobs/pools/market/strategies/backtests/memories/datasync/status 白名单模块刷新事件。 |

数据库读取不接受原始 SQL。`database-tools.ts` 从 `pg_catalog` 动态读取列、约束、索引和关系，以稳定 JSON 计算逐表 SHA-256；查询执行时再次读取并比对。标识符必须来自当前表结构并满足小写字母数字下划线，所有值只通过 PostgreSQL 参数绑定进入服务端构建的 SELECT。敏感列既不进入描述结果，也不能进入查询列或过滤条件。

系统提示词在每轮构造时动态注入轻量表索引、轻量有效记忆索引、当前持仓、`portfolio_account_state` 实时资金摘要、今日作业和行情截止日；记忆正文仅由 `memory_query` 按需读取。模型只对任务相关表调用 `describe_tables`。静态规则声明各结构化领域的单一事实源映射、页面业务事实只读和 Agent 写入门禁。记忆与当前策略、持仓、行情或任务结果冲突时，以 PostgreSQL 当前领域事实为准。目标日计划不得覆盖策略正文；规则、研究评分、量化条件、计划动作和运行结果必须分开。

领域写工具不接收表名、列名、过滤器、任意 SQL 或任意 JSON 行，只接收固定领域命令；账户快照、成交归因、池完整评估、回测晋升和记忆替代都是 service 内部语义。pi-agent-core 的 TypeBox 校验仅为第一层；execute、提案批准入口和领域 service 都重新校验。超过 256 KiB、未知字段、无效日期、非有限金额、动作矛盾或非法状态在写锁外/事务内相应阶段被拒绝。旧 `database_change`、`watchlist_write`、`content_write`、`backtest_write` 和固定服务版 `run_backtest` 不再注册。

### 6.3 确认制、YOLO 与并发控制（T5、T12、T15、T16）

- 领域写工具和 `fetch_market_data` 统一调用 `withAgentMutationLock`。协调器开启 `SERIALIZABLE` 事务，并以 `pg_try_advisory_xact_lock(hashtext(current_database()), hashtext('stock.agent.database-mutation.v1'))` 取得数据库级锁；锁忙时立即返回 `AGENT_DATABASE_BUSY`，不等待、不执行任何业务写入。不同数据库互不阻塞。
- 每个领域工具先由 `previewDomainWrite` 按业务主键读取目标状态，提案阶段生成稳定 SHA-256 指纹；批准/YOLO 阶段以 `FOR UPDATE` 锁定相关行并重算。`server/db/transaction.ts` 让 HTTP 入口传 Pool 时由 service 自建事务、Agent 入口传 PoolClient 时复用外层事务，避免业务写入逃逸到另一连接。
- 确认制：在持有写锁时原子写入 `agent_confirmation(status='pending')`、目标状态指纹与 pending 审计，不直接写业务表；用户确认时先 `SELECT ... FOR UPDATE` 锁定提案行，再取得数据库级写锁并重算目标指纹。指纹变化返回 409，业务零写入且提案保持 pending。
- YOLO：不创建 pending confirmation；在同一可序列化事务内重算并锁定目标行、调用对应领域 service、写 `agent_tool_audit(status='ok')` 后提交。结果详情标记 `auto_approved/yolo_mode`，core 不发送 `confirmation_pending` 帧。
- 前端收到工具卡片后按领域展示 reason、action 与目标参数；用户点确认 → `POST /api/confirmations/:id/approve` → 提案行锁 + advisory lock + 状态指纹复核 → 在单事务内调用领域 service、回填 `agent_confirmation.result` 并审计 → SSE 推送确认结果。任一操作失败则全部回滚且提案保持 pending；两个并发 approve 至多一个执行。
- 拒绝：`POST /api/confirmations/:id/reject`，只留审计。
- 超时：pending 超过 24h 标 `expired`，不自动执行。
- 旧 `database_change` 记录和 pending 提案不兼容；拒绝仍可留审计，批准要求重新按新领域工具发起。

### 6.4 SSE 协议（T4）

`POST /api/chat/:sessionId/messages` 建立 SSE 流，帧类型：

| frame | 数据 |
|-------|------|
| `run_started` | `{run_id}`，后续控制请求的乐观并发令牌 |
| `assistant_start` | `{timestamp?}`，开始同一执行轨迹卡内的新 assistant 阶段；不再切分外层气泡 |
| `context_compacted` | `{through_seq, estimated_tokens}`，只表示模型视图更新 |
| `text` | `{delta}`（来自 `message_update` 内嵌 `text_delta`） |
| `tool_start` / `tool_update` / `tool_end` | `{toolCallId, name, args?, result?, isError?}` |
| `confirmation_pending` | `{confirmation_id, tool_name, payload}` |
| `done` | `{message}` 完整 assistant 消息 |
| `aborted` | `{run_id, message}`，服务端 Agent 已取消 |
| `error` | `{code, message}` |

`POST /api/chat/:sessionId/messages` 实时发送当前 run 的文本和工具帧；内部使用 `AgentSessionRunner`，完成消息与低频事件持久化后才发送 `done/aborted/error`。任务与交互会话共用该入口。

`POST /api/chat/:sessionId/control` 接受 `{action, run_id, text?}`：

- `abort` 不接收文本，真正取消服务端 Agent 并返回 202；
- `steer` 与 `follow_up` 要求非空文本，分别进入 pi 的 steering/follow-up 队列；
- 无运行中 Agent 返回 `AGENT_NOT_RUNNING`，令牌不匹配返回 `AGENT_RUN_MISMATCH`，均不执行控制；
- 接受后的控制动作写 `agent_control` 低频事件，正文最终随 pi 消费后的 user message 进入 `chat_message`。

`GET /api/chat/:sessionId/events?after=<cursor>`：

1. 先订阅进程内总线并缓冲新事件；
2. 从 `chat_session_event.id > after` 按升序补发数据库事件；
3. 去重并冲洗订阅期间缓冲的更大游标事件；
4. 后续继续实时推送并用 25 秒 heartbeat 保活。

客户端以最后已处理 `cursor` 重连。同一事件只处理一次；工具 `tool_update` 经过节流/合并后才持久化，文本 delta 不进入该流。确认结果、任务状态和页面刷新均使用这一条普通对话事件流。

UI 先以用户消息为轮次边界，把中间由工具调用产生的连续 assistant 消息聚合为一张 Agent 执行轨迹卡；卡内保留原始阶段顺序，并通过样式区分思考进展、工具调用和最终回答。单次批量工具读取 `summary` 显示聚合进度；历史连续同名且无确认卡的工具调用按相邻顺序合并为 `ToolGroupCard`，默认折叠各项 JSON。带确认卡的调用永远独立展示。

### 6.5 外部 CLI 桥（M4 暂缓）

以下只保留后续设计，不进入当前生产实现。当前没有 `agent/bridge/cli.ts`、CLI 可用性探测、`delegate_to_cli` 工具注册或 `agent_external_cli_run` 新写入。

- `delegate_to_cli(agent, prompt, timeout)`：`spawn('codex', ['exec', ...])` / `spawn('claude', ['-p', '--output-format', 'stream-json', ...])`，cwd=仓库根，超时默认 10 分钟上限 30，stdout 截断 200KB，并发信号量 2。
- 输出分片经 `onUpdate` 回流为工具 partial result → SSE `tool_update` 帧。
- 全部写 `agent_external_cli_run`；设置页探测走 `codex --version` / `claude --version` / `pi --version`。

### 6.6 页面 AI 解读、工作台与外观（M4/T28；第二阶段按 T34 重构）

- `web/src/utils/askAi.ts` 定义单一页面事件契约；内容库、任务中心和回测页只发送数据库记录 ID、展示标签和解读边界，不发送整篇正文。
- 第二阶段 `App.vue` 已使用布局内 `AgentWorkspace`，`ChatDrawer` 已删除；带唯一请求 ID 的问题继续只预填并聚焦，不自动发送，旧 `/chat` 只重定向为打开当前工作区。
- 左侧导航维护 `expanded/collapsed` 并记忆状态；Agent 维护 `open/collapsed` 和上次分栏宽度。收起只用 `v-show` 隐藏展开区，不卸载 `ChatView`，因此 session 连接与输入草稿继续保留。小于 1100px 时网格把 Agent 放到主页面下方，工作区取消左边框和拖动手柄，不使用悬浮遮罩。
- `ui_refresh` 只接受 `targets` 白名单和非空 `reason`，事件类型固定为 `ui_refresh`，先写 `chat_session_event` 再推送。`ChatView` 复用 session 游标去重后转发为 `stock:ui-refresh`；各页面 `useUiRefresh` 在 80ms 内合并同模块请求并只调用现有资源 reload，不调用 `location.reload`、不重挂载路由或覆盖编辑草稿。确认制领域写入只在真实批准成功后自动发布刷新事件。
- 第三阶段当前策略、任务运行与回测结果只把领域记录 ID 和解读边界带入 Agent，不复制正文；资源事件到达时主模块刷新但不抢占用户锁定记录。
- `stores/theme.ts` 独立维护 `warm/teal` 强调色和 `system/light/dark` 外观，分别写本机存储；跟随系统时监听 `prefers-color-scheme`，解析后的明暗值写到根节点 `data-color-scheme`。
- `theme.css` 集中定义明暗中性色、状态色、遮罩和阴影；弹层/抽屉进入退出、键盘 `focus-visible`、全局关闭动效和 `prefers-reduced-motion` 使用统一令牌。K 线和账户快照图监听主题变化事件，重新读取 CSS 变量并刷新 Canvas 配色。

### 6.7 会话级模型与输入体验（M4，T30）

- `ChatView.vue` 并行读取会话列表与 `/api/llm/providers` 模型目录，在消息区顶部展示“本会话模型”选择器；选择只 PATCH 当前 `chat_session.model_id`，发送中、归档会话和保存中禁用切换。
- 模型可用性同时检查厂商启用、模型启用和 API Key 已配置；当前有待发送图片时，不允许切换到不含 `image` 输入能力的纯文本模型。图片上传入口和提示也按当前会话模型判断，不再按全局模型判断。
- SSE 文本先进入短缓冲，再由 `useStreamTypewriter` 按固定时间片平滑追加；流结束前冲完缓冲，中断时保留已显示部分。输入区外层 `.composer-box` 是唯一边界，`:focus-within` 只改变描边色和轻微背景色，不叠加 box-shadow。

### 6.8 仪表盘每日状态聚合（M4，T29）

- 仪表盘不新增服务端汇总表或专用接口；五个现有只读资源并行加载，保持行情、作业、持仓、实时资金摘要和离散账户快照各自领域事实源。
- 状态总览和“需要关注”在前端做只读派生：最新作业状态为 `failed/partial/missed`、活动持仓 `close IS NULL`、缺少日线覆盖、缺少资金快照，或资金快照日期早于日线截止日期时生成可下钻项。加载错误也进入同一区域，不能在数据不完整时显示“正常”。
- 实时总资产、现金和现金占比读取 `/api/account/summary`，并显示 `portfolio_account_state.anchor_date`；活动持仓市值、浮动盈亏和集中度以 `market_coverage(day).last_date` 标注。账户趋势和“较上次记录”仍只使用 `portfolio_account_snapshot` 离散序列，不把台账实时值反写为历史快照。
- 总资产变化只比较相邻两条有 `total_asset` 的离散记录，文案固定为“较上次记录”，不命名为日收益或连续净值；图表继续只画散点。
- 页面头保留“交给 Agent”和运行既有任务入口；数据明细、任务日志和完整持仓图通过卡片内下钻链接访问。仪表盘不提供成交或入池旁路表单。
- 栅格列使用 `minmax(0, …)` 并对卡片设置 `min-width: 0`；1280px 实测主栏约 652px、次栏约 376px，卡片 `scrollWidth === clientWidth`，较窄桌面在 1040px 断点降为单列。深色主题复用现有令牌，不新增硬编码亮色背景。

### 6.9 全局 message 提示（M4，T31）

- `stores/message.ts` 提供 `success/error/warning/info/apiError/dismiss` 单一调用面；消息按类型、标题、正文和错误码组成去重键，5 秒内相同提示只显示一次，同时最多保留四条。success/info 自动停留 3.2/4 秒，warning/error 停留 5/6.5 秒，均可手动关闭。
- `AppMessageCenter.vue` 在 `App.vue` 常驻并 Teleport 到 body，桌面顶端居中、窄屏留 12px 边距；错误/警告使用 `role=alert`，成功/信息使用 `role=status`，继承明暗主题、动效开关和系统减少动态效果。
- `api/client.ts` 是接口错误提示的唯一公共入口：普通 JSON 请求、SSE 建流/读取中断和 multipart 上传失败都构造 `ApiFail` 后立即调用 `apiError`，状态码映射为参数错误、权限不足、内容不存在、状态冲突或服务处理失败；主动 Abort 不提示。
- 原位状态与全局提示分工：`StateBlock`、表单字段和长任务结果继续承载可恢复细节；全局 message 提供即时感知。创建、保存、切换、触发、导出、恢复等业务成功由调用方显式报告，避免对所有 POST/PATCH 机械显示“成功”。

## 七、内容库（M3.5）

- 旧内容 API 已删除；冻结内容表只保留迁移审计与可移植初始化包兼容数据。“当前策略”页面只展示最终正文和简要演进，不提供历史全文时间线或回滚入口。
- `modules/job-prompts/` 以同样的只追加模型维护 Agent Flow 提示词；`job_run.prompt_revision_id` 固化每次实际执行版本。
- 内容范围只包含策略、指引、当前交易计划和交易计划归档。持仓/资金/流水、标的池、行情、作业提示词/结果、分析和回测均使用各自结构化事实源；0014 已删除对应内容副本。
- 旧导入器与文档同步运行入口已删除。`strategy_*`、`script_*` 和 `content_legacy_import` 仅保留历史迁移审计，不注册生产路由、不参与 Agent Flow 或内容展示，且不进入 Agent 表索引。

## 八、调度器（M3，`scheduler/`）

- `service.ts`：每 30 秒用 `croner` 解析 enabled 作业；只接受传统 5 段 cron，固定时区 `Asia/Shanghai`。`job_run_scheduled_once` 保证多 tick/多进程对同一计划时刻只插入一次，Runner 以 `UPDATE ... WHERE status='queued'` 原子 claim。
- 启动补偿：从每个作业最后 `scheduled_for`（初次为定义创建/更新时间）扫描到启动时刻，插入 `missed` 记录；不补跑，页面提示可手动触发。暂停区间不追记。
- `runner.ts`：`datasource` → 数据库动态解析持仓/有效标的池/活跃指数/活跃板块/期货范围 → `dailyMarketUpdate`（含 MA）→ scheduled 数据卷导出；`analysis` → 严格校验三类结构化请求并复用 `analysis/`；`agent_flow` → 固化 `job_prompt_revision`，只注册 `database_schema` / `database_query`，按提示词查询 `content_*` 当前版本与结构化业务表，Markdown 写 `job_run.result_md`。
- 并发：同一 server 固定 3 个轻量 worker，`UPDATE ... WHERE status='queued'` 原子 claim 防重复；datasource 最多同时 1 个并继续使用独立 PostgreSQL 市场写锁，其余名额由 analysis/agent_flow 并行使用。Agent 领域写仍由原有 Agent 写锁保护。
- 失败：日志入 `job_run.log`；第一次失败把同一行恢复 queued 并设置 `next_retry_at=now()+5min`，第二次失败标 failed。`partial` 为有数据缺口的终态，不重试。
- 生命周期：scheduler 随 server 启动；SIGINT/SIGTERM 先停止新 tick，等待当前 Runner 安全落终态/重试态，再关闭 HTTP 与连接池。

## 九、数据卷（`volume/`，M1）

- 导出：`pg_dump -Fc` 到 `datavolume/stock_YYYY-MM-DD_HHmm.dump` + 同名单 `.manifest.json`（导出时间、每表行数、`market_bar` 各 freq 的 min/max bar_date、manifest sha256）；滚动保留 14 份（删除最旧）。
- 导入：`volume:restore <快照>` —— 建库迁移 → `pg_restore` → 校验 manifest 与库内计数一致 → 写 `volume_snapshot(kind='manual')` 恢复记录；任一校验失败即报错列出差异，不静默通过。
- CLI：`npm run volume:export` / `npm run volume:restore -- <path>`；页面「数据与备份」提供同功能按钮。安全初始化包另走 `portable:export` / `portable:restore` 和固定表/列白名单。

## 十、HTTP API（二期新增，沿用一期错误格式与 127.0.0.1 绑定）

| 方法与路径 | 说明 |
|-----------|------|
| `GET /api/instruments?kind=&q=` | 标的检索（命令面板/选择器） |
| `GET /api/market/bars?code=&freq=&start=&end=` | K 线数据（读库） |
| `GET /api/market/structure?date=&dataset=&page=&size=` | 市场结构按日分页查询 |
| `GET /api/market/coverage` | 行情覆盖对账摘要 |
| 旧行情 quotes/realtime 路由 | 0033 后不再注册并返回 404；Agent `market_snapshot_query` 改读最新日线 |
| `GET /api/pools/short`、`GET /api/pools/long` | 短线/长线池的成员、研究属性、近期关注、板块偏好与行情投影，只读 |
| 旧自选与图表标注 API | 已退役且不注册路由；请求返回 404，前端不提供画线能力 |
| `GET /api/positions`、`GET /api/positions/changes`、`GET /api/account/snapshots`、`GET /api/account/summary` | 持仓、事件流、离散账户快照与 0020 实时资金摘要 |
| `POST /api/positions/record` | 已退役且不注册路由；成交/调整/资金事实只能由 Agent `portfolio_write` 写入 |
| 旧内容 API | 已删除；页面导航不暴露冻结内容域 |
| `GET /api/job-prompts`、`GET /api/job-prompts/:id`、版本子路由 | Agent Flow 提示词与不可变版本，只读；写入只经 `job_write` |
| `GET /api/analysis/runs`、`GET /api/analysis/runs/:id`、`POST /api/analysis/run` | 板块温度、关键位与长线估值 |
| `GET /api/backtests`、`GET /api/backtests/:id` | 只返回 final 回测结论、适用边界、历史兼容结论与对比关系；working/superseded 默认不可见 |
| `POST /api/backtests/run`、`POST /api/backtests/:id/activate` | 已退役且不注册路由；请求返回 404，新运行只能由有持久化 session 的 Agent `run_backtest` 创建 |
| `GET /api/memories`、`GET /api/memories/:id` | Agent 记忆列表与详情，只读；支持关键词、类型、标签、状态和数量限制 |
| `GET /api/strategy/current`、`GET /api/strategy/evolutions`、`GET /api/strategy/proposals` | 当前最终策略、简要演进与发布提案读取 |
| `GET /api/strategy/proposals/:id/review`、`POST /api/strategy/proposals/:id/approve`、`POST /api/strategy/proposals/:id/reject` | 当前策略页面一次性审核令牌与真人批准/拒绝；不注册为 Agent 工具 |
| `POST /api/volume/export`、`POST /api/volume/restore`、`GET /api/volume/snapshots` | 完整私有数据卷 |
| `GET /api/volume/portable`、`POST /api/volume/portable/export`、`POST /api/volume/portable/restore` | 安全初始化包 |
| `GET /api/jobs`、`PATCH /api/jobs/:code/control`、`POST /api/jobs/:code/trigger`、`GET /api/jobs/:code/runs`、`GET /api/job-runs/:id` | 任务中心只读定义并控制启停/立即运行/失败处理；页面创建和通用修改接口已退役 |
| `GET /api/jobs/:code/outputs`、`GET /api/job-outputs/:id` | 按任务查看历史与当前领域结果；历史导入可无伪造 `job_run` |
| `GET/POST /api/chat/sessions`、`PATCH /api/chat/sessions/:id`（重命名/归档/会话模型，`?archived=1` 查归档）、`GET /api/chat/sessions/:id/messages`、`GET /api/chat/:sessionId/events?after=<cursor>`、`POST /api/chat/:sessionId/messages`（SSE）、`POST /api/chat/:sessionId/control`、`POST /api/chat/:sessionId/attachments`（multipart） | 唯一对话 API；任务与交互共用可继续的会话和低频重放事件，控制接口按 `run_id` 执行 abort/steer/follow_up |
| `GET /api/llm/status` | 当前 LLM 配置与能力状态（configured/provider/model/vision；不返回密钥） |
| `GET/POST /api/llm/providers`、`PATCH/DELETE /api/llm/providers/:id` | 模型厂商查询、新增、更新、删除；查询只返回 `api_key_configured` |
| `POST /api/llm/providers/:id/models`、`PATCH/DELETE /api/llm/models/:id`、`POST /api/llm/models/:id/activate` | 模型目录维护与当前模型切换 |
| `GET/PATCH /api/agent/settings` | 读取或切换确认制/YOLO；PATCH 只接受 `yolo_mode: boolean` |
| `POST /api/confirmations/:id/approve`、`POST /api/confirmations/:id/reject` | 确认制（M2） |
| `GET /api/audit/tools`、`GET /api/audit/cli-runs` | 审计查询 |

## 十一、隐私与安全

| 数据/凭据 | 存储 | 规则 |
|-----------|------|------|
| 扶摇 API Key | PostgreSQL `system_setting.hithink_api_key` + 私有 datavolume 快照 | 仅服务端读取；GET/错误/日志不返回本体；固定资产包排除；旧 env 只一次性迁移 |
| LLM API Key | PostgreSQL `llm_provider.api_key` + datavolume 快照 | 仅服务端写入/读取；任何 GET、错误与日志不返回本体；数据卷按敏感介质管理 |
| 持仓/账户金额 | PostgreSQL + datavolume 快照 | 仅本机；快照只经自有介质拷贝 |
| 图片附件 | `server/uploads/`（gitignored） | 无外链入口 |
| 会话与工具审计 | DB | 不输出 key；prompt 全量留存供审计 |

服务仅绑 127.0.0.1；出站请求仅限扶摇/新浪/东财/用户配置的 LLM provider；LLM Base URL 只接受 http/https。外部 CLI 桥约束见 6.5，当前生产不探测或执行本机命令。

## 十二、测试与验收

- `tests/server/` 当前覆盖 datasource 行情/财务/估值通道选择、降级、限流、共同报告期与幂等落库，内容/提示词不可变版本和乐观并发，受控分析/回测，完整备份与初始化包恢复，confirmation/YOLO/写锁状态机，以及 Asia/Shanghai cron、重复 tick 去重、启动 missed、datasource/analysis/agent_flow、一次重试和作业 API。旧 CSV、文件同步、摄取、Python Runner 与纯前端 MVP 测试已随生产入口删除。
- agent 测试用注入的 fake runtime，不依赖真实 API；LLM 配置回归测试覆盖供应商/模型 CRUD、激活、停用约束、密钥不回显与数据库唯一配置源；会话路由覆盖新会话继承默认模型、独立模型持久化和非法模型拒绝。
- 数据库工具测试覆盖轻量索引、按 hash 描述、主键/写策略、敏感列与迁移证据表隐藏、跨领域批量查询与 DDL 后旧 hash 拒绝；系统提示词测试覆盖单一事实源、目标日计划、实盘例外、领域写入和资金摘要。领域写工具覆盖确认制零写入、批准后 service 事务执行、YOLO 无 pending、写锁争用、状态指纹冲突、拒绝/过期和旧 `database_change` 明确停用。组合账户用例额外覆盖资金摘要市值推导、清仓收益、同日 upsert、非法日期/金额/恒等式和提案后状态变化。批量行情测试注入 fake datasource，验证单次调用的成功/失败/进度汇总。
- 前端验收覆盖常驻工作台、侧栏拖拽/键盘缩放、宽度持久化、旧 `/chat` 重定向、未配密钥引导、内容/作业/回测三类 AI 解读预填、不同会话独立模型、单轮执行轨迹卡与卡内流式打字效果、运行中干预/排队/停止、任务会话标签与追问、输入框单层焦点描边、四态 message 与接口失败自动提示、日线对比、市场结构 Tab 与中文表头，以及全站无原生 `select`。
- 工具 UI 验收覆盖单轮多 assistant 阶段聚合、思考/工具/回答样式区分、批量结果摘要、连续同名调用聚合、展开明细，以及确认卡不参与折叠。
- M3.5 集成验证清单：服务端/前端类型检查、Vue 生产构建与数据库原生永久测试全绿；最终初始化包在无父目录 clean-room 空库恢复；内容、作业、长线估值、服务内回测、会话、12 个 Agent 工具和页面路由冒烟通过；源码扫描无旧文件读取、任意命令/Python spawn 或原生 `<select>`。
- M4 非 CLI 验收：浅色、深色、跟随系统可切换并刷新保持偏好；暗色下弹层、Markdown、diff、表格和 ECharts 可读；关闭动效和系统减少动态效果均禁用非必要动画。源码扫描确认未新增 CLI 探测、命令执行或委派工具注册。
- Agent 生命周期永久测试扩展既有 `chat-routes.test.ts`：慢速 faux 流验证服务端 abort 与 cancelled；过期 `run_id` 零执行；steering/follow-up 依次形成同一会话内的用户/助手消息；任务 session 可直接追问；压缩后检查点前进且原始消息只增加本轮两条、不因压缩减少。
- 仪表盘验收：以真实数据库返回验证失败任务和资金快照滞后可进入待处理区；1280px 下两组主次双栏无横向滚动或卡片内部溢出，浅色/深色均截图检查；总资产变化明确为离散记录比较，资金与行情日期分别显示。
- 第一阶段永久测试扩展现有 `migrate.test.ts`、`chat-routes.test.ts` 与 `scheduler.test.ts`：覆盖 0016 迁移、交互/任务 session、作业排队原子关联、遗留 queued 幂等补建、同 session 自动重试 attempt、消息/工具/错误/终态先持久化、游标断线补发与去重，以及 datasource/analysis/missed 不创建 session。功能开关关闭时既有 `/api/chat` 与调度结果保持兼容。

### 12.1 第一阶段验收结果（2026-08-18）

- 真实 PostgreSQL 已从 0015 向前应用 0016，迁移记录为 1–16；三张 `agent_session_*` 子表和 `chat_session` 通用 session 字段均已核对。
- `npm run typecheck`、`npm run web:typecheck`、`npm test`（12 文件、94/94）和 `npm run web:build` 全部通过；生产构建只有既有单包大于 500 kB 提示。
- 永久测试已覆盖新旧执行路径结果兼容、排队原子创建、创建失败整体回滚、断线游标补发与实时去重、自动重试复用同一 session、服务重启收敛遗留 running，以及 datasource/analysis/missed 不创建伪 session。任务只读限制已由 T37 后续迁移取消。
- 可移植初始化包继续只导出显式白名单，不包含聊天与 `agent_session_*`；完整私有 `pg_dump` 自动包含新表。本阶段未迁移策略、计划、回测事实，未加入临时代码工作区。

### 12.2 第二阶段验收结果（2026-08-18）

- 旧 `ChatDrawer.vue` 已删除，`App.vue`、`AgentWorkspace.vue` 和 `theme.css` 形成同一 CSS Grid 布局；左侧导航实测 188/56px，右侧工作区实测 721/48px，收起后主业务区扩展且 `ChatView`、session 和草稿不卸载。桌面 1280×720 无横向溢出；业务主区使用容器查询，在宽 Agent 分栏下仪表盘、任务、策略和回测自动改单栏。
- 任务中心可从具体运行直接打开同一普通任务会话；落库结果统一使用 `ResultRef(type,id)`，可独立阅读的任务结果、最终回测和 Agent 记忆通过 `?result=<type>:<id>` 在全局单例阅读器打开，策略提案、持仓变化、标的池成员和任务定义导航并定位到业务页面。任务中心历史抽屉不再在列表底部内联 Markdown；旧 `/jobs?output=<id>` 仍兼容。事件 SSE 使用 `replay_complete` 标记重放与实时边界，页面不再维护只读任务过程组件。
- `ui_refresh` 已进入新会话工具目录和系统提示词；第二阶段原白名单已由 T42 更新为 dashboard、positions、jobs、pools、market、strategies、backtests、memories、datasync、status。永久测试覆盖非法目标拒绝、事件先持久化、确认批准后自动刷新和重放完成标记。
- `npm run typecheck`、`npm run web:typecheck`、`npm run web:build`、`npm test`（12 文件、95/95）和 `git diff --check` 通过。第二阶段未新增迁移，未改变策略、任务结果或回测事实源；第三阶段切换前仍只使用现有适配读取。

### 12.3 第三阶段验收结果（2026-08-18）

- 真实 PostgreSQL 已从 0016 向前应用 0017。`strategy_document` 为 8 份（组合、短线、长线各 1，核心指引 5），`strategy_state.change_seq=0`，整体 SHA-256 重算一致；迁移不伪造演进或提案。
- 19 份历史每日计划已归 `daily_plan_flow` 的 `job_run_output`。三份 Agent Flow 当前提示词均为 v3，包含 `job_run_output` 且不再包含 `content_document`；新运行的结果与 `job_run` 终态同事务写入输出表。
- 隔离库在 YOLO 开启状态下验证待审摘要、逐文档 diff 和真人按钮；一次性页面令牌批准后策略序号从 0 变 1、提案正文清除、演进标记已采纳。无令牌、错误主体/来源、基线冲突和拒绝清理均有永久测试。
- 1280×720 下左侧菜单与右侧 Agent 工作区独立收放，任务中心显示并预览 19 份历史结果，水平溢出为 0，干净页面控制台 0 warning/error。
- `npm run typecheck`、`npm run web:typecheck`、`npm run web:build`、`npm test`（13 文件、99/99）和 `git diff --check` 通过。新安全初始化包迁移上限 17，在空库恢复后 8 份策略、19 份结果和策略哈希再次对账一致，API Key 与 session 均为 0。

### 12.4 第四阶段与最终一致性验收结果（2026-08-18）

- 真实 PostgreSQL 迁移记录为 1–20：0018 落地上下文压缩检查点，0019 落地 Agent 临时回测元数据与历史比较，0020 落地快照锚点后的实时资金台账。既有迁移未回改。
- `redactEphemeralCode` 对 `Date` 保留 ISO 字符串且只递归普通对象；初始化包永久回归覆盖时间戳不能退化为 `{}`。资金台账永久回归覆盖无锚点、重锚、锚点后买入扣现金、卖出回补、现金不足整体回滚，以及只有完全清仓才计算收益。
- `npm run typecheck`、`npm run web:typecheck`、`npm run web:build` 通过；13 个永久测试文件逐文件独立执行，合计 108/108。生产构建只有既有单包大于 500 kB 提示。
- 当前初始化包 `stock_init_2026-08-18_190406` 的迁移上限为 20、行情 321,241 行、白名单表 26 张；空库恢复后 manifest 差异为 0。结构化扫描 321,568 条 payload 记录未发现禁止表或禁止字段，恢复库中的 API Key、聊天/session、确认/审计、持仓和账户均为 0。
- 恢复库上的真实 Docker 隔离工作器返回 `success`，工作器/SDK 为 `agent-backtest-worker-v1` / `stock-backtest-sdk-v1`，临时代码清理状态为 `deleted`；验收会话、回测记录和 `$TMPDIR/stock-agent-backtests` 临时工作区均已清理。

### 12.5 Agent 主导写入三阶段验收结果（2026-08-19）

- 真实 PostgreSQL 已向前应用 0029 与 0030，迁移记录为 1–30；旧自选三表和 `chart_annotation` 不再存在，`pool_board_preference`、成交归因列、回测结论列和 `agent_memory_artifact` 已核对。
- 页面成交、任务创建/编辑、提示词编辑、自选与服务端画线入口已删除；`POST /api/positions/record`、旧任务写接口、自选和图表标注接口均返回 404，任务控制统一为 `PATCH /api/jobs/:code/control`。
- 永久测试覆盖池完整投影和唯一当前角色、成交归因与偏离原因、持仓归因构成、工作回测隐藏/最终结论晋升/同会话替代、记忆敏感内容拒绝及只读 API、可移植初始化包迁移上限 30。
- `npm run typecheck`、`npm run web:typecheck`、`npm run web:build` 已通过；完整 `npm test` 为 13 个测试文件、117/117 用例通过。

## 十三、风险与取舍

| 风险 | 缓解 |
|------|------|
| pi 内核 API 漂移 | pin 0.84.2 精确版本；厂商适配集中 `agent/ai/`，loop 集中 `agent/core/`，跨层只传稳定运行时与 frame 契约 |
| LLM 数据库凭据泄露 | 查询 API 永不返回 key；响应/日志/构建产物做泄漏检查；数据库与数据卷仅限本机和自有介质 |
| 数据库工具越权/大范围误改 | 读取不开放原始 SQL且强制逐表 schema_hash；普通写入不开放表/列，只开放组合账户、标的池、作业、回测晋升和记忆固定命令并强制经过 service；策略只能创建待真人审核提案。确认制与 YOLO 都受事务、写锁、状态指纹和审计保护 |
| 回测试验污染历史 | `run_backtest` 只产生 working；默认 API 只返回 final，`finalize_backtest` 绑定来源会话并在事务内维护唯一最终结论与替代链 |
| Agent 记忆过期或夹带敏感事实 | 记忆写入检查敏感模式和禁止副本；默认检索 active，页面展示来源与验证时间，冲突时以当前领域事实为准 |
| LLM 伪造/畸形工具参数 | pi schema 之外在 execute 与 domain 入口再次严格校验；未知字段、语义矛盾、非真实唯一键与超大载荷直接拒绝，错误审计只留参数哈希 |
| 多会话并发写、重复批准或旧提案覆盖 | PostgreSQL 数据库级 transaction advisory lock + 提案行锁 + 目标状态指纹；忙锁与状态冲突快速失败且业务零写入 |
| 批量行情部分失败 | 默认继续其余项并逐项留 `market_fetch_run`；工具汇总明确 succeeded/failed/gaps，用户可只重试失败项 |
| 新浪/东财接口漂移 | 响应严格校验、失败留痕，按数据获取规范在服务端通道间显式降级 |
| SSE 确认流复杂度 | T5 解耦设计；M2 先做只读工具再开写工具 |
| 行情表体量 | 单表+主键索引足够（150 标的×6 年≈22 万行日线）；30m 线按受控范围摄取 |
| 多进程重复调度或停机漏跑 | `(job_id, scheduled_for)` 数据库唯一约束 + Runner 原子 claim；启动只记 missed，不伪装补跑成功 |
| 自动作业或 Agent 越权 | 作业类型只允许 datasource/analysis/agent_flow；analysis 只接受固定结构化请求，agent_flow 仅注册只读工具，输出只入 `job_run.result_md`；不存在命令或脚本 Runner |
| session 事件丢失、重复或内存流与数据库游标竞态 | 低频事件先入库再推送；订阅先缓冲实时事件，再按游标补库并去重冲洗；逐 token 文本明确不承诺重放，完成消息可恢复 |
| 统一执行器回归现有对话或调度终态 | 第一阶段保留运行开关和既有 HTTP 契约；新旧路径对账消息、结果与作业终态，开关回退不删除 0016 数据或证据 |
| 策略发布被 Agent、调度器或 YOLO 绕过 | 第三阶段批准接口不注册为工具、不向调度器暴露，并验证真实用户主体；YOLO 分支只能创建 pending 提案，不能调用批准事务 |

## 十四、评审记录

| 日期 | 评审人/角色 | 结论 | 阻断项 | 后续动作 |
|------|-------------|------|--------|----------|
| 2026-08-16 | 当前模型（起草） | 待用户确认 | T1–T8 待确认 | 确认后启动 M1 任务二至七 |
| 2026-08-17 | 真实用户（M2 优化指令） | 确认并授权实施 | 无 | 按 T9–T11 完成三层拆分、数据库 LLM 配置与系统级对话 UI |
| 2026-08-17 | 真实用户（数据库工具与批量交互补强） | 确认并授权实施 | 无 | 按 T12–T14 收敛双数据库工具、统一领域表名、批量行情与工具卡聚合 |
| 2026-08-17 | 真实用户（Agent 工具体系重构） | 确认并授权实施 | 无 | 按 T18 改为渐进式 Schema 发现、查询哈希防漂移和六个领域 service 写工具；不兼容旧 database_change 提案 |
| 2026-08-17 | 真实用户（停止 8787 并继续 M3） | 确认并授权实施 | 无 | 按 T17 完成调度器、受控 Runner、作业 API/工具与任务中心 |
| 2026-08-18 | 真实用户（内容单一事实源与内置 Agent 增强） | 确认并授权实施 | 无 | 按 T26 删除已迁移内容副本，隐藏迁移证据并把仓库任务路由翻译进数据库原生系统提示词 |
| 2026-08-18 | 真实用户（独立维护收口） | 确认并授权实施 | 无 | 按 T27 补齐财务估值批量通道、最终初始化包和无父目录 clean-room 验收，完成 M3.5 后再推进 M4 |
| 2026-08-18 | 真实用户（进入 M4，暂缓 CLI 桥） | 确认并授权实施 | 外部 CLI 桥不进入本轮 | 按 T28 完成内容/运行结论 AI 解读、暗色模式和动效/可访问性打磨 |
| 2026-08-18 | 真实用户（仪表盘高频信息与视觉优化） | 确认并授权实施 | 无 | 按 T29 重构状态聚合、日期口径、快捷入口和响应式主次栅格 |
| 2026-08-18 | 真实用户（会话模型与输入体验） | 确认并授权实施 | 上下文压缩只审计、不实施 | 按 T30 增加会话级模型持久化与选择器，收敛输入框焦点边界；记录当前未启用自动压缩 |
| 2026-08-18 | 真实用户（全局提示规范） | 确认并授权实施 | 无 | 按 T31 新增四态 message、API 失败统一报告、成功与校验提示规范 |
| 2026-08-18 | 真实用户（当前策略与 Agent 工作台评审） | 确认并授权分阶段实施 | 无 | 按 T32–T36 串行推进四阶段；先完成第一阶段 session 基础并独立验收，不提前引入事实迁移或临时代码执行 |
| 2026-08-18 | 真实用户（Agent 生命周期增强） | 确认并授权实施 | 外部 CLI 仍暂缓 | 按 T37 复用 pi 控制能力，实现服务端中断、steering、follow-up、任务原会话追问和原始历史不丢失的持久压缩 |
| 2026-08-18 | 真实用户（0020 资金口径与偏移收口） | 确认并授权实施 | 无 | 按 T38–T39 完成隔离回测、旧入口退役、实时资金台账，并同步产品/技术文档、README、初始化包和状态账本 |
| 2026-08-19 | 真实用户（Agent 主导写入与研究闭环） | 确认、要求拆分并依次实施 | 无 | 按 T42 完成页面写入收敛、0029 池/行情重构、0030 成交归因/最终回测/记忆，并通过数据库迁移与永久回归 |
| 2026-08-20 | 真实用户（首期 Web 研究） | 确认并授权实施 | `web_fetch` 暂不开放 | 按 T43 保留 Provider 抽象，首期仅注册 DeepSeek 原生 `web_search`，完成来源白名单、限额、审计脱敏和永久回归 |

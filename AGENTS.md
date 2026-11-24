# AGENTS 工作规范

本文件面向维护本仓库的编码 Agent。README 面向使用者，部署与运维步骤在根 `README.md` 的「部署与运维」章节；产品和技术事实以 `docs/product` 下的 PRD 及当前代码为准。

- 回复先给结论，再给处理建议和关键依据；保持简洁、少用加粗，避免堆砌数据和重复提醒。连续更新只说明变化、判断是否改变及操作是否改变，不重写整篇。
- 商品与期货分析的落点是 A 股：结论必须给出具体标的、当前价格位置和盈亏比，说明现在是否值得入场；进场推荐度统一用 1–100 分标注。先看商品趋势及其对公司售价、成本和利润的传导，再用必要的技术分析判断入场时机和风险。区分盘中观察位、波段压力区和止盈目标。盈亏比的目标只取强压力位：前高或新高位置、前面连续放量交易日的价格中枢；MA 和震荡高低点只作观察位，不当目标，也不因此否决。分析要综合：基本面、技术面（盈亏比之外的趋势、结构、量价、相对强弱等）、消息面（产业消息、政策消息、关联商品变化）和盈亏比一起看，任何单项都不作为唯一关键指标，也不作为严格门禁；只有数据来源、日期时效、缺数写法、不编数字这几条是硬约束。用户只做股票，不给期货下单建议。交易时段问“现在”时使用盘中数据并注明行情时点；拿不到盘中数据须明确说明，不能用昨收代答当前行情。
- 查行情按三级来源：先读本地 PostgreSQL，读不到再调系统内提供的只读接口，两者都拿不到才按 skill 要求调外部行情接口。

## 一、项目边界

- 本仓库可独立构建、测试、部署和恢复，运行时数据只来自 PostgreSQL。
- PostgreSQL 是运行时唯一事实源；页面、Agent、调度器和脚本都通过服务层读写数据库。
- 新增源码、文档、迁移、测试和脚本只能写在本仓库内。
- 需求与设计只维护在 `docs/product`；`specs/` 已退役，不再新建 spec bundle。

## 二、目录职责

| 路径 | 职责 |
|------|------|
| `server/migrations/` | 只向前 PostgreSQL 迁移 |
| `server/modules/` | 持仓、池、行情、策略、任务、回测等领域服务与路由 |
| `server/agent/` | Agent 会话、工具、确认、审计、模型接入与安全边界 |
| `server/datasource/` | 扶摇、AKShare 数据获取与落库 |
| `server/scheduler/` | 定时任务排程与 Runner |
| `server/volume/` | 私有完整备份和固定资产包 |
| `web/` | Vue 3 工作台 |
| `tests/server/` | 数据库、API、Agent、调度和数据卷测试 |
| `docs/` | 按功能组织的 PRD、技术口径、回测结论与索引；部署步骤在根 `README.md` |
| `bootstrap/` | 人工确认后可提交的当前固定资产包 |

不要重新引入已退役的 Markdown/CSV 同步器、纯前端事实源或外部 Python Runner。

## 三、不可破坏的业务约束

- API Key 只存 PostgreSQL 设置表。查询接口只返回配置状态，密钥不得进入日志、URL、错误、审计或固定资产包。
- 扶摇请求必须检查业务信封 `code == 0`，保持限流、退避和缺数显式失败；不得用公开行情推断个人持仓。
- 持仓、账户、流水、标的池、行情、聊天、任务运行结果、分析和回测是本机运行数据，不得进入 Git 固定资产。
- 可移植固定资产只包含当前策略正文、策略演进摘要、评分基准、定时任务定义、提示词及其版本；系统不保存历史策略版本。修改白名单时必须同时更新导出、恢复、校验、测试和部署文档。
- 容器服务无认证：宿主端口必须绑定 `127.0.0.1`。不得把应用直接暴露到局域网或公网。
- 策略清单哈希由 `strategy_document` 的 `code:sha256` 按 `injection_order,id` 拼接（排除已退役的 `copper_inventory_strategy`、`lithium_warehouse_strategy`）。任何改动策略正文的迁移必须同步刷新 `strategy_state.current_hash` 并 `change_seq + 1`，否则调度器运行时校验失败，全部 agent_flow 任务拒绝执行。

## 四、修改流程

1. 先运行 `git status --short`，保留并绕开用户已有改动。
2. 用 `rg` 定位入口、全部调用方、对应测试和现有实现，优先复用已有模式。
3. 做能完整解决问题的最小改动，不增加未被当前需求使用的抽象或依赖。
4. 数据库变更必须新增迁移；已应用迁移文件不得修改，也不得改名（改名等于换 sha，落账时间与文件对不上，审计直接断掉）。迁移需可在空库和现有库向前执行。
5. 业务写入必须经过领域 service；Agent 不得获得通用 SQL 写权限。
6. 修改行为时更新已有测试；没有独立价值的临时测试文件在验证后删除。
7. 只在用户可见行为、部署步骤或维护契约变化时更新对应文档，README 不保存内部实现流水账。

## 五、验证要求

按改动范围执行最小充分验证：

| 改动 | 必跑 |
|------|------|
| 服务端 TypeScript | `npm run typecheck`、相关 `npx vitest run <测试文件>` |
| 前端 | `npm run web:typecheck`、`npm run web:build` |
| 迁移、数据卷、固定资产 | `npm run typecheck`、`npx vitest run tests/server/migrate.test.ts tests/server/migration-volume.test.ts tests/server/volume-routes.test.ts` |
| 调度器 | `npx vitest run tests/server/scheduler.test.ts`；时序用例失败时再单独运行具体用例，不能直接放宽断言 |
| Docker/部署 | `docker compose --env-file .env.local.example config --quiet`、`docker compose --env-file .env.local.example build app` |
| 跨领域或发布前 | `npm test` |

不得对真实生产库运行测试或恢复演练。需要完整部署验收时使用独立 Compose 项目名、独立端口和测试卷，结束后只删除该测试项目资源。

## 六、敏感信息与 Git

- 禁止提交 `.env.local`、`datavolume/`、`server/uploads/`、`server/public/app/`、数据库卷、私有备份、依赖目录或日志。
- `.env.local.example` 只能含占位配置，不能含可用凭据。
- `bootstrap/` 默认忽略所有时间戳导出，只对白名单中的当前正式包例外放行。新包必须先审阅 manifest 和 payload 表集合，再替换 `.gitignore` / `.dockerignore` 中的例外。
- 完整私有备份含 API Key、持仓和运行历史，不得提交或作为跨电脑固定资产分发。
- 提交前检查：

```bash
git status --short --ignored
git diff --cached
git diff --cached --check
git ls-files
```

同时扫描私钥头、GitHub/AWS/LLM Token、带明文凭据的连接串和 API Key 赋值。命中测试占位值时必须人工确认其不可用且仅用于验证脱敏。

## 七、部署与数据同步

- 部署或运维前必须完整阅读根 `README.md` 的「部署与运维」章节。
- 新电脑执行 `git clone` 会取得源码和当前固定资产包，但不会自动写入数据库；用户必须在首次启动应用前执行一次空库恢复。
- `.env.local`、数据库密码、扶摇 Key 和 LLM Key 必须由目标电脑用户本地配置，不能通过 Git 同步。
- 新电脑的持仓、账户、流水、标的池和行情保持为空，由该实例独立维护。
- 已运行数据库不得再次执行空库固定资产恢复；普通代码更新只构建并重启应用。
- 两个运行实例之间目前没有自动双向策略同步。若要把新策略导入既有实例，必须先实现冲突检测和真实用户确认，不能直接覆盖。

## 八、需要真实用户确认的操作

- 恢复会覆盖现有业务数据的私有备份。
- 删除 Docker 数据卷、数据库、附件或备份。
- 将服务暴露到本机以外网络，或给容器挂载 Docker Socket。
- 把新固定资产包设为 Git 正式版本并分发。

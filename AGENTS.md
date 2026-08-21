# AGENTS 工作规范

本文件面向维护本仓库的编码 Agent。README 面向使用者；部署细节见 `docs/独立部署说明.md`；产品和技术事实以 v2.0 文档及当前代码为准。

## 一、项目边界

- 本仓库可独立构建、测试、部署和恢复，运行时数据只来自 PostgreSQL。
- PostgreSQL 是运行时唯一事实源；页面、Agent、调度器和脚本都通过服务层读写数据库。
- 新增源码、文档、迁移、测试和脚本只能写在本仓库内。
- spec bundle 名和内容必须全部使用中文。

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
| `docs/` | 产品、技术、迁移与部署说明 |
| `bootstrap/` | 人工确认后可提交的当前固定资产包 |

不要重新引入已退役的 Markdown/CSV 同步器、纯前端事实源或外部 Python Runner。

## 三、不可破坏的业务约束

- 策略发布只能由当前策略页面的真实用户批准；Agent、YOLO、调度器和迁移不得代替用户批准。
- API Key 只存 PostgreSQL 设置表。查询接口只返回配置状态，密钥不得进入日志、URL、错误、审计或固定资产包。
- 扶摇请求必须检查业务信封 `code == 0`，保持限流、退避和缺数显式失败；不得用公开行情推断个人持仓。
- 持仓、账户、流水、标的池、行情、聊天、任务运行结果、分析和回测是本机运行数据，不得进入 Git 固定资产。
- 可移植固定资产只包含当前策略、策略版本/演进摘要、定时任务定义、提示词及其版本。修改白名单时必须同时更新导出、恢复、校验、测试和部署文档。
- 容器服务无认证：宿主端口必须绑定 `127.0.0.1`。不得把应用直接暴露到局域网或公网。

## 四、修改流程

1. 先运行 `git status --short`，保留并绕开用户已有改动。
2. 用 `rg` 定位入口、全部调用方、对应测试和现有实现，优先复用已有模式。
3. 做能完整解决问题的最小改动，不增加未被当前需求使用的抽象或依赖。
4. 数据库变更必须新增迁移；已应用迁移文件不得修改。迁移需可在空库和现有库向前执行。
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

- 部署或运维前必须完整阅读 `docs/独立部署说明.md`。
- 新电脑执行 `git clone` 会取得源码和当前固定资产包，但不会自动写入数据库；用户必须在首次启动应用前执行一次空库恢复。
- `.env.local`、数据库密码、扶摇 Key 和 LLM Key 必须由目标电脑用户本地配置，不能通过 Git 同步。
- 新电脑的持仓、账户、流水、标的池和行情保持为空，由该实例独立维护。
- 已运行数据库不得再次执行空库固定资产恢复；普通代码更新只构建并重启应用。
- 两个运行实例之间目前没有自动双向策略同步。若要把新策略导入既有实例，必须先实现冲突检测和真实用户确认，不能直接覆盖。

## 八、需要真实用户确认的操作

- 批准或拒绝策略发布。
- 恢复会覆盖现有业务数据的私有备份。
- 删除 Docker 数据卷、数据库、附件或备份。
- 将服务暴露到本机以外网络，或给容器挂载 Docker Socket。
- 把新固定资产包设为 Git 正式版本并分发。

# Stock 策略演进系统 技术设计

| 项目 | 填写内容 |
|------|----------|
| 文档标题 | Stock 策略演进系统 技术设计 |
| 文档版本 | v1.0 |
| 目标产品版本 | 一期（任务运行 + 回测台账） |
| 状态 | 已交付；二期见 `Stock_策略演进系统_技术设计_v2.0.md`，本文保留为一期实现的历史记录 |
| 更新日期 | 2026-08-15 |
| 关联 PRD | `docs/product/Stock_策略演进系统_产品方案_v1.0.md` 全文 |

> 本文按 `设计文档模板_v1.0.md` 裁剪：与交易事实写入、计划生成、成交校验相关的模板章节（模板 §4 任务流程、§6.2 长任务状态机、§7.3 校验分级、§7.5 回滚与纠错）在一期不适用——一期不产生任何交易事实写入，故删除并在此注明原因；二期移交持仓/计划模块时重新补齐。

---

## 一、问题与决策摘要

### 1.1 已批准决策

| 编号 | 决策 | 当前结论 | 决策人 |
|------|------|----------|--------|
| E1 | 事实源 | 数据库升格为事实源；Markdown 逐模块移交，未移交前 Markdown 仍是事实源 | 真实用户，2026-08-15 |
| E2 | 数据库 | PostgreSQL 16，本地 docker-compose，连接串在 gitignored `.env.local` | 同上 |
| E3 | 服务端栈 | Node 22 + TypeScript，与仓库现有工具链同栈 | 同上 |
| E4 | 范围切分 | 一期 = DB 骨架 + 任务运行 + 回测台账 | 同上 |

### 1.2 设计目标与非目标

**目标**：任务定义/运行记录、回测运行登记、数据集登记三张台账入库可查询；最小 HTTP API；两个只读台账视图；既有事实只读摄取。

**非目标**：不搬迁既有 Markdown 事实源；不做调度器（任务仍由 agent 触发，系统只记录）；不做实时行情；不引入 ORM/Web 框架/前端框架；不修改 `支撑/` 与根目录既有事实文件。

## 二、范围与依赖

### 2.1 外部依赖

| 依赖 | 当前状态 | 失败影响 | 降级方式 |
|------|----------|----------|----------|
| Docker Desktop / docker compose v2 | 本机已具备（v2.33.1） | 无法起 Postgres | 本机 Postgres + 同一 `DATABASE_URL` |
| `pg`、`dotenv`（运行时）；`tsx`、`@types/pg`（开发） | 新增 npm 依赖 | 服务端不可运行 | 无替代，需安装 |
| 既有事实文件（`定时任务/*.md`、`支撑/data/**`、`支撑/results/**`、`支撑/backtest/**`） | 只读 | 摄取缺项 | 登记时列出缺失，不伪造 |

### 2.2 新增 npm scripts

| 命令 | 作用 |
|------|------|
| `npm run db:migrate` | 执行未应用的 SQL 迁移（幂等） |
| `npm run server` | `tsx server/index.ts`，监听 `127.0.0.1:8787` |
| `npm run ingest:tasks` / `ingest:datasets` / `ingest:backtests` | 三个摄取脚本 |
| `npm run task:record -- <args>` | 任务运行登记 CLI |
| `npm run backtest:register -- <args>` | 回测登记 CLI |

现有 `build`/`test`/`test:e2e`/`test:acceptance`/`typecheck` 不变。

## 三、架构与目录

```
./
  docker-compose.yml          postgres:16 + 命名卷 pgdata，127.0.0.1:5432
  .env.local.example          DATABASE_URL 模板（真实 .env.local 被根 .gitignore 覆盖）
  server/
    index.ts                  入口：建池、迁移检查、起 HTTP
    config.ts                 读 DATABASE_URL / PORT，缺省报错
    db/client.ts              pg Pool 单例
    db/migrate.ts             迁移运行器
    migrations/0001_init.sql  Schema v1
    http/router.ts            node:http 路由、JSON 解析、统一错误 {code,message}
    modules/datasets/repo.ts
    modules/tasks/repo.ts routes.ts
    modules/backtests/repo.ts routes.ts
    public/                   一期台账视图（原生 HTML/JS，无构建、无框架）
      index.html  app.js  styles.css
  scripts/
    record-task-run.ts        CLI：开始/结束任务运行（fetch 调 API）
    register-backtest.ts      CLI：登记回测运行（fetch 调 API）
    ingest/seed-tasks.ts
    ingest/register-datasets.ts
    ingest/register-history-backtests.ts
  tests/server/               vitest：迁移、repo、API（需测试库，无库时 skip 并打印原因）
```

- 运行时/CLI/摄取统一 TypeScript，经 `tsx` 执行；不新增 .mjs 服务端脚本。
- 服务只绑定 `127.0.0.1`，无认证（单机本机信任假设，见 §八）。
- `server/public/` 是独立轻页面，与 `src/`（纯前端静态产物）完全分离；旧构建流程不感知新页面。
- 摄取脚本直连数据库（经 repo 层），不走 HTTP；CLI 走 HTTP（模拟日常使用路径）。

## 四、数据契约（Schema v1）

### 4.1 DDL（`server/migrations/0001_init.sql`）

```sql
CREATE TABLE schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_definition (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  template_path    text NOT NULL,
  template_sha256  text NOT NULL,
  cron             text,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_run (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_definition_id  bigint NOT NULL REFERENCES task_definition(id),
  target_date         date NOT NULL,
  trigger_kind        text NOT NULL CHECK (trigger_kind IN ('cron','manual')),
  status              text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','success','failed','partial')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  steps               jsonb NOT NULL DEFAULT '[]',
  produced_artifacts  jsonb NOT NULL DEFAULT '[]',
  data_gaps           jsonb NOT NULL DEFAULT '[]',
  summary             text,
  UNIQUE (task_definition_id, target_date)
);
CREATE INDEX task_run_def_date_idx ON task_run (task_definition_id, target_date DESC);

CREATE TABLE dataset (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_id      text NOT NULL,
  source_path     text NOT NULL,
  source_sha256   text NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN
                    ('market_csv','market_30m_csv','futures_csv',
                     'backtest_output','report_md','task_template_md')),
  coverage_start  date,
  coverage_end    date,
  row_count       integer,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_path, source_sha256)
);
CREATE INDEX dataset_type_idx ON dataset (source_type);

CREATE TABLE backtest_run (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('formal','research')),
  engine_path       text,
  engine_git_commit text,
  config_snapshot   jsonb,
  input_manifest    jsonb NOT NULL DEFAULT '[]',
  output_dir        text,
  report_path       text,
  status            text NOT NULL DEFAULT 'archived'
                    CHECK (status IN ('active','superseded','archived')),
  started_at        timestamptz,
  finished_at       timestamptz,
  metrics           jsonb,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- 正式锚点全局唯一
CREATE UNIQUE INDEX backtest_run_single_active_formal
  ON backtest_run (kind) WHERE kind = 'formal' AND status = 'active';

CREATE TABLE backtest_artifact (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  backtest_run_id bigint NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  dataset_id      bigint NOT NULL REFERENCES dataset(id),
  role            text NOT NULL CHECK (role IN ('input','output','report')),
  UNIQUE (backtest_run_id, dataset_id, role)
);
```

### 4.2 字段语义要点

- `task_run.status`：`running` 进行中；`success` 全部步骤完成；`partial` 有产物但有数据缺口或降级；`failed` 无可复核结果。
- `task_run.steps/produced_artifacts/data_gaps`：JSONB 数组。steps 元素 `{name, status, note?, at?}`；produced_artifacts 元素 `{path, kind, sha256?}`；data_gaps 元素 `{what, impact, recovery?}`。
- `backtest_run.status`：`active` 当前正式锚点；`superseded` 被替代的 former 锚点；`archived` 历史/研究登记。只有 `kind='formal'` 可为 `active`。
- `backtest_run.config_snapshot`：登记时点 `最终配置()` 的摘录 JSON，由调用方提供；系统不解析引擎源码。
- `dataset` 只证明本地文件可追溯（路径+哈希），不声称上游来源已核实；`coverage_start/end`、`row_count` 仅对行情 CSV 填，其余类型留空。
- 所有路径为仓库相对路径，正斜杠，不含绝对本机目录。

### 4.3 迁移策略

- `server/migrations/` 下 `{NNNN}_{name}.sql` 顺序执行；`db/migrate.ts` 计算文件 SHA-256，已应用且哈希一致则跳过，已应用但哈希不一致则报错中止（不允许改历史迁移），未应用则在单事务内执行并登记。
- 只向前迁移，不提供 down；纠错通过新迁移完成。

## 五、HTTP API 契约

基址 `http://127.0.0.1:8787`。错误统一 `{ "error": { "code": "...", "message": "..." } }`，码表：`BAD_REQUEST`(400)、`NOT_FOUND`(404)、`CONFLICT`(409)、`DB_UNAVAILABLE`(503)、`INTERNAL`(500)。

| 方法与路径 | 请求体 | 成功 | 说明 |
|-----------|--------|------|------|
| GET `/api/health` | — | `{status:'ok'}` | 含 DB 连通检查 |
| GET `/api/tasks` | — | 任务定义数组，各带 `latest_run` 摘要 | 按 code 排序 |
| GET `/api/tasks/:code/runs?limit=50` | — | 运行数组，target_date 降序 | 404 未知 code |
| POST `/api/tasks/:code/runs` | `{target_date, trigger_kind, summary?}` | 201 运行（running） | 同任务同目标日已存在 → 409 并返回已有 id |
| PATCH `/api/task-runs/:id` | `{status, steps?, produced_artifacts?, data_gaps?, summary?}` | 更新后运行 | 终态（success/failed/partial）置 `finished_at`；终态行只允许改 summary，改 status 返回 400；同目标日重跑须由调用方决定删除旧记录后重新 POST，不提供终态→running 重开 |
| GET `/api/backtests` | — | 运行数组：active 正式锚点置顶，其后 created_at 降序 | 每项带 `is_active_anchor` |
| GET `/api/backtests/:id` | — | 运行 + `artifacts`（join dataset，含路径/哈希/角色） | 404 |
| POST `/api/backtests` | 见下 | 201 运行 | 事务内完成 run + artifact 登记 |
| POST `/api/backtests/:id/activate` | — | 更新后运行 | 单事务：旧 active formal → superseded，本行 → active；`kind != 'formal'` → 400 |
| GET `/api/datasets?source_type=` | — | 数据集数组 | 可选过滤 |

POST `/api/backtests` 请求体：

```json
{
  "name": "V26.5正式集合扩容", "kind": "formal",
  "engine_path": "支撑/backtest/portfolio_engine.py",
  "engine_git_commit": "可选，缺省时服务端取 git rev-parse HEAD",
  "config_snapshot": {}, "input_manifest": [{"path": "...", "sha256": "..."}],
  "output_dir": "支撑/backtest/data/output/final/",
  "report_path": "支撑/results/....md",
  "metrics": null, "notes": null,
  "artifacts": [{"source_path": "支撑/results/....md", "role": "report"}]
}
```

服务端对 `artifacts` 逐个校验文件存在、计算 SHA-256、upsert `dataset`（`source_type` 由扩展名/路径推断）、插入 `backtest_artifact`；任一文件缺失 → 400 且整体回滚。

## 六、CLI 与摄取脚本契约

### 6.1 `scripts/record-task-run.ts`

```bash
npm run task:record -- start  --task daily_plan --date 2026-08-15 --trigger cron
npm run task:record -- finish --run 12 --status success \
  --summary "..." --artifact 交易计划/明日交易计划_2026-08-15.md \
  --gap "30分钟数据缺失:影响关键位精度"
```

- `start` 打印运行 id；`finish` 可重复 `--artifact`/`--gap`；`--status partial` 要求至少一个 `--gap`。
- API 基址取 `STOCK_API_URL`，缺省 `http://127.0.0.1:8787`。

### 6.2 `scripts/register-backtest.ts`

```bash
npm run backtest:register -- --name V26.6 --kind formal \
  --engine 支撑/backtest/portfolio_engine.py \
  --output-dir 支撑/backtest/data/output/final/ \
  --report 支撑/results/回测报告_V26.6_xxxx.md \
  --metrics '{"annual":0.0}' --activate
```

- `--activate` 在登记成功后调 activate；登记与激活分两个请求，失败时已登记 run 保持 `archived`，不产生半个锚点。

### 6.3 摄取脚本（直连 repo 层，需 `DATABASE_URL`）

| 脚本 | 行为 |
|------|------|
| `ingest/seed-tasks.ts` | 3 份 `定时任务/*.md` → `task_definition` upsert（by code；哈希变化时更新并保留旧值于日志输出） |
| `ingest/register-datasets.ts` | 扫描 `支撑/data/*.csv`、`支撑/data/30分钟/*.csv`、`支撑/data/期货/*.csv` → `dataset` upsert；从 CSV 首末行取 coverage、数据行数取 row_count |
| `ingest/register-history-backtests.ts` | ① 当前正式引擎：登记 `portfolio_engine.py` + `data/output/final/` 产物 + 报告 `回测报告_V26.5正式集合扩容_2026-08-13.md`，`kind='formal'`、`status='active'`（已存在 active 则跳过并提示）；② `支撑/results/回测报告_*.md`、`左侧交易独立研究_*.md`、`研究分级信号回测_*.md` 按文件名解析名称与日期，登记为 `archived`，metrics 一律留空；报告文件入 `dataset` 并关联 `backtest_artifact(role='report')` |

三个脚本全程只读事实文件；输出逐项登记/跳过摘要；任何文件缺失列为缺口，不中止其余项。

## 七、状态与异常

| 场景 | 行为 |
|------|------|
| DB 连接失败 | 服务启动失败并打印 `DATABASE_URL` 检查提示；运行期 `/api/health` 返回 503 |
| 迁移哈希不一致 | migrate 非零退出，列出冲突版本；禁止自动修复 |
| 重复登记任务运行 | 409，返回已有运行 id，由调用方决定 PATCH |
| 激活非 formal 运行 | 400，不产生任何写入 |
| 摄取遇缺失文件 | 记录缺口、继续其余项、退出码 0，但摘要中 `missing>0` 时打印醒目提示 |
| 页面 API 失败 | 视图原位显示错误与重试，不显示空表冒充无数据 |

## 八、隐私与安全

- 服务绑定 `127.0.0.1`，无认证；适用前提是单机本机使用，文档与启动日志均声明不得暴露到局域网/公网。
- 数据库凭据只在 `.env.local`（gitignored）；`.env.local.example` 只含占位值。
- 数据库内容含回测与任务元数据，一期不含持仓金额；页面与日志不得输出 `DATABASE_URL`。
- 无外部网络请求、无云同步、无远程访问入口。

## 九、二期/三期 Schema 草案（不实施）

`instrument(code, name, kind)`；`pool_membership(instrument_id, pool, role, grade, effective_from, effective_to)`；`position` / `position_snapshot(as_of, instrument_id, qty, cost, ...)`；`market_bar(dataset_id, time, open, high, low, close, volume)`；`strategy_doc` / `strategy_version(doc_id, version, content_sha256, effective_from, change_note)`；`plan` / `plan_item`。移交时按 PRD 第六节执行对账后切换事实源。

## 十、验收与测试

### 10.1 自动化（`tests/server/`，vitest）

- 测试库取 `TEST_DATABASE_URL`（缺省推导自 `DATABASE_URL` 加 `_test` 后缀）；无库时 `describe.skip` 并打印原因，不算失败。
- 迁移：连续执行两次幂等；篡改已应用迁移文件后报错。
- task：POST 重复 `(code, target_date)` → 409；PATCH 终态置 `finished_at`；终态后改 status → 400。
- backtest：activate 单事务（旧 active 降级、唯一索引生效）；artifact 文件缺失整体回滚；research 激活 → 400。
- datasets upsert：同 `(path, sha256)` 重复摄取不重复建行。

### 10.2 手工冒烟（对应 PRD §七）

`docker compose up -d` → `db:migrate` → 三个 ingest → `npm run server` → 浏览器打开 `http://127.0.0.1:8787/` 两个视图可见种子数据 → CLI 模拟一次任务运行登记与一次回测登记激活。

### 10.3 回归门禁

`npm run typecheck && npm test` 全绿；既有 `test:e2e`/`test:acceptance` 不受影响（新代码不参与静态构建）。`git status` 无 `.env.local`、`dist/`、数据库卷等敏感产物。

## 十一、风险与发布

| 风险 | 缓解 |
|------|------|
| Markdown/DB 双写漂移 | 一期新数据才入库；移交按 PRD §六对账后切换 |
| 用户机 docker 不可用 | 本机 Postgres + 同一 `DATABASE_URL`，README 双写法 |
| 历史报告指标缺失 | 留空不编造 |
| 阶段蔓延（顺手做二期） | 一期不建二期表，草案只留在本文 |

**发布门禁**：PRD §七 7 条验收全部通过；`AGENTS.md` 与 `README.md` 同步完成。

## 十二、评审记录

| 日期 | 评审人/角色 | 结论 | 阻断项 | 后续动作 |
|------|-------------|------|--------|----------|
| 2026-08-15 | 真实用户 | 批准 E1–E4 与一期范围 | 无 | 进入一期开发 |

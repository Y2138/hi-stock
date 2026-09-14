# hi-stock

一个面向个人 A 股投资者的本地策略研究与执行记录工作台。

它把当前策略、行情、持仓、标的池、每日计划、集合竞价复核、任务结果和回测统一保存在 PostgreSQL 中，再由确定性扫描服务和 Agent 协作完成日常研究。目标是让“依据什么规则、看了哪些数据、形成了什么计划、后来如何执行”可以连续追踪，而不是散落在表格、Markdown 和聊天记录里。

这不是券商交易终端，不连接账户自动下单。是否交易、成交数量以及策略发布均由用户决定。

## 日常工作流

1. 定时同步 A 股行情、指标、板块和市场结构数据。
2. 服务端扫描短线右侧、左侧反转、试盘启动、波段及打板信号，完整保留覆盖数和数据缺口。
3. 每日 Agent 任务读取当前策略和扫描结果，生成下一交易日的持仓预案、候选信号与近期关注。
4. 次日集合竞价结束后，复核每日计划中的打板候选并形成结构化结论。
5. 用户记录实际成交后，系统关联原计划、信号与策略版本，保留执行偏离和盈亏归因。
6. Agent 可发起隔离回测和策略调整提案；新策略必须由用户在页面上确认后才会发布。

## 主要能力

- **每日工作台**：集中查看数据异常、当前持仓、次日执行预案、打板机会和最近任务。
- **持仓与标的池**：管理成交记录、持仓归因、短线池、长线池及独立的近期关注。
- **市场研究**：查看日线指标、行业板块、涨跌停、炸板、连板天梯和龙虎榜等结构数据。
- **策略与回测**：维护当前最终策略，通过 Agent 运行受控 TypeScript 回测并生成待审核的策略演进提案。
- **Agent 工作区**：在所有业务页面旁查询事实、解释结果或发起受控写入；工具详情按需加载，业务写入始终经过领域服务、校验和审计。
- **自动任务**：运行数据更新、每日计划、周中检查、每周评分和集合竞价研判，结果可回看并继续追问。
- **风控三件套**：每日计划上下文内置开仓闸门判定——881 行业上涨占比（宽度确认）、881 等权综合 60/120 日收益（绝对动量，仅适用于与指数同向的广域宇宙）、连续 3 笔亏损平仓与净值 20 日回撤 5% 的账户熔断；净值快照自启用日起逐日积累。
- **本地数据管理**：提供跨机器初始化用的固定资产包，以及包含完整本机数据的私有备份。

## 运行边界

- PostgreSQL 是运行时唯一事实源，页面、Agent 和调度器不从仓库文件读取持仓或行情。
- 普通业务写入支持确认制和显式开启的 YOLO 模式；策略发布始终需要真人确认。
- 扶摇与 LLM API Key 只保存在本机 PostgreSQL，查询接口不会回显密钥正文。
- 当前按单用户本机部署设计，没有登录认证；宿主端口必须只绑定 `127.0.0.1`。

## 快速开始

要求 Docker Desktop，或支持 Compose v2 的 Docker Engine。

```bash
git clone https://github.com/Y2138/hi-stock.git
cd hi-stock
cp .env.local.example .env.local
# 修改 .env.local 中的 POSTGRES_PASSWORD，并同步修改 DATABASE_URL 的密码
docker compose --env-file .env.local build app
docker compose --env-file .env.local up -d postgres
docker compose --env-file .env.local run --rm app \
  npm run portable:restore -- bootstrap/stock_init_2026-08-21_135650.ndjson.gz
docker compose --env-file .env.local up -d app
```

固定资产恢复只用于首次部署的空数据库。启动后打开 <http://127.0.0.1:8787/>，在“设置”中配置扶摇数据源和 LLM 厂商。首次部署、验收、更新与恢复步骤见[独立部署说明](docs/独立部署说明.md)。

## 初始化历史行情数据（可选，仅首次部署）

新部署的数据库不含行情。系统默认的日更范围是持仓、标的池、核心指数和行业板块，只够日常运行；如果要回测或研究全市场，需要在首次部署时一次性引入全市场历史日线。这是**初始化操作，不是定期同步**：完成之后，各标的的日常更新由系统已有的日线更新链路负责。

前提：已安装并登录 `hithink-finance` CLI（`npm i -g @hithink-tech/hithink-finance-cli`），并在“设置”中配置好扶摇 API Key。

```bash
# 1) 拉取扶摇全市场批量导出（十年日K + 复权事件）到本地 DuckDB
hithink-finance data init

# 2) 导出为可回填的 CSV，并写入 PostgreSQL market_bar
npm run market:backfill -- --source duckdb
```

也可先导出到目录再回填，便于重复使用或断点重试：

```bash
npm run market:backfill -- --out /tmp/market-dump        # 导出 CSV，锚点取数据最新日
npm run market:backfill -- --from /tmp/market-dump --anchor 2026-09-11
npm run market:backfill -- --from /tmp/market-dump --dry-run   # 只统计不写库
```

**板块日线**（行业、概念、区域、特色）默认只有一级行业参与日更，历史深度也不足；补齐用：

```bash
npm run market:board-backfill -- --dry-run    # 先看缺口范围
npm run market:board-backfill                 # 补齐头部历史与尾部停更（走限流队列，约 2-3 小时）
```

要点：

- 回填把前复权价写入 `open/high/low/close`，原始成交价写入 `open_raw/high_raw/low_raw/close_raw`，交易所前收盘写入 `prev_close`；复权由 `server/datasource/adjustment.ts` 按固定锚点计算，不依赖供应商的前复权口径。
- 命令幂等；默认拒绝在已有回填数据时重复执行（这是初始化工具，不是同步器），确需按新锚点重建历史时加 `--force`。
- 全市场十年日线约 1,000 万行、约占 5 GB 数据库空间，请预留磁盘。
- 回填完成后系统会标记指标待重算；服务启动后指标工作器会串行补齐，数据量大时需要较长时间。

**之后的日常数据更新**由系统已有的链路完成。定时任务 `daily_data_update` 每个交易日更新持仓、标的池、核心指数、行业板块，并**默认覆盖全部活跃个股**（保证全市场历史持续更新）；需要单独补拉某个标的时使用：

```bash
npm run market:fetch -- --code 000636.SZ --freq day --start 2020-01-01 --end 2026-09-11
```

全市场扩展的行为分两层，用来控制计算成本：

- **日线（行情）**：全部活跃个股每日只做当日快照追加（约 30 次批量请求，约 2.5 分钟）。缺口修复与 K 线重拉仍只对持仓、标的池、核心指数和行业板块执行，避免个别标的除权就触发全市场逐标的请求。
- **指标（MA/MACD/RSI/股性）**：每日只对**信号相关范围**——持仓、标的池、核心指数、行业板块、当日结构候选——重算，约几分钟内完成，每日计划不会用到过期指标。其余约 5,000 只标的的指标由每周任务 `weekly_full_market_indicators`（周六 05:30）入队，后台指标工作器分批补齐（全量约 10–20 分钟）。

如果不需要全市场每日行情更新（例如只做池内研究），可在 `.env.local` 关闭：

```
DAILY_UPDATE_FULL_MARKET=false          # 回退为只更新持仓、池、指数、行业板块
INDICATOR_WORKER_INTERVAL_MS=2000       # 指标工作器回退到低负载节奏
```

## 数据边界

| 类型 | 保存位置 | 是否随 Git 同步 |
|------|----------|-----------------|
| 当前策略、演进摘要、定时任务定义与提示词 | `bootstrap/` 固定资产包 | 是 |
| 持仓、流水、标的池、行情、任务结果、回测与聊天 | 本机 PostgreSQL | 否 |
| 扶摇与 LLM API Key | 本机 PostgreSQL | 否 |
| 完整私有备份与附件 | 本机 Docker 卷 | 否 |

## 技术栈

- Node.js 22 + TypeScript
- Vue 3 + Vite
- PostgreSQL 16
- Docker Compose
- Vitest

## 本地开发

要求 Node.js 22.19+、npm 10 和 PostgreSQL 16。

```bash
npm ci
docker compose --env-file .env.local up -d postgres
npm run typecheck
npm run web:typecheck
npm test
npm run web:build
```

## 文档

- [独立部署说明](docs/独立部署说明.md)
- [产品方案 v2.0](docs/product/Stock_策略演进系统_产品方案_v2.0.md)
- [技术设计 v2.0](docs/design/Stock_策略演进系统_技术设计_v2.0.md)
- [智能助手工具设计与验收](docs/智能助手工具设计与验收.md)
- [Agent 维护规范](AGENTS.md)

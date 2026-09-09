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

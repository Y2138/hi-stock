# hi-stock

本地优先的 A 股策略演进工作台。系统使用 PostgreSQL 保存策略、行情、持仓、任务和 Agent 会话，通过 Vue 3 页面完成研究、执行记录、定时任务和策略发布治理。

当前按单用户本机部署设计，没有登录认证；服务只允许通过 `127.0.0.1` 访问。

## 主要能力

- 当前策略、版本与演进摘要管理；策略发布必须由真实用户确认。
- 短线/长线池、行情、财务估值、持仓与资金台账。
- 定时任务、任务提示词、结果归档和 Agent 工作区。
- 扶摇与 AKShare 数据源、数据库原生分析和隔离回测。
- 可移植固定资产包与本机私有完整备份。

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

打开 <http://127.0.0.1:8787/>。首次部署、验收、更新和数据边界见[独立部署说明](docs/独立部署说明.md)。

## 数据边界

| 类型 | 保存位置 | 是否随 Git 同步 |
|------|----------|-----------------|
| 当前策略、演进摘要、定时任务与提示词 | `bootstrap/` 固定资产包 | 是 |
| 持仓、账户、流水、标的池、行情、任务结果与聊天 | 本机 PostgreSQL | 否 |
| 扶摇与 LLM API Key | PostgreSQL 系统设置 | 否 |
| 完整私有备份与附件 | 本机 Docker 卷 | 否 |

## 开发

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
- [Agent 维护规范](AGENTS.md)

# 期货端点

> 期货品种、合约、主连/主力、持仓、仓单、基差、交易日与行情。

> 上级索引：[REST API 契约](../../api.md)

## 通用约定

| 项目 | 契约 |
| --- | --- |
| Base URL | `https://fuyao.aicubes.cn` |
| 方法 | 全部为 `GET` |
| 认证 | HTTP Header `X-api-key` |
| 成功判断 | HTTP 200 且信封 `code == 0` |
| 标的代码 | 期货用**大写**完整 `thscode`，如 `CU2701.SHF`；商品指数用 `.TI`，如 `850002.TI` |
| 日期 | ISO `yyyy-MM-dd`，按 `Asia/Shanghai` 解释 |
| 时间 | 毫秒 Unix 时间戳 |
| 空值 | `null` 表示上游无值；合法无数据返回 `item: []` |

> **验证状态**：本组 21 个端点于 2026-11-09 通过仓库配置的扶摇 Key 逐个实测。文档里的示例代码 `CU2601.SHF` 是旧合约（已到期，现在返回 `code=3001`），请用 [合约列表](contracts.md#2-合约基础信息列表) 查当前有效合约。

## 代码格式速查

| 类型 | 示例 | 说明 |
| --- | --- | --- |
| 具体合约 | `CU2701.SHF`、`IC2612.CFE` | 品种 + 年月 + 交易所后缀 |
| 主连 | `CUZL.SHF`、`AUZL.SHF`、`IHZL.CFE` | `ticker` 形如 `cu9999`；品种 + `ZL` |
| 连续 | `CU00.SHF`、`A00.DCE` | `ticker` 形如 `CU7777` / `A7777` |
| 加权 | `SS8888.SHF` | `ticker` 与代码同名 |
| 商品指数 | `850002.TI` | 期货通商品指数，走独立的合约/行情口径 |

交易所后缀：`.SHF` 上期所、`.DCE` 大商所、`.CZC` 郑商所、`.CFE` 中金所、`.INE` 上海国际能源交易中心、`.GFE` 广期所。

**代码消歧直接用元信息端点**（实测可用，不要自己拼代码）：

```bash
curl 'https://fuyao.aicubes.cn/api/meta/tickers/search?q=沪铜&limit=5' -H 'X-api-key: <your-api-key>'
curl 'https://fuyao.aicubes.cn/api/meta/tickers/list?asset_type=futures&limit=100&offset=0' -H 'X-api-key: <your-api-key>'
```

返回项的 `asset_type` 为 `futures`、`futures-commodity-index` 或 `options`（期权合约会与期货合约一起命中，按 `asset_type` 过滤）。

> `varieties/list` 的 `main_contract_thscode` 实测可能为 `null`（沪铜即为 `null`），不要依赖它拿主力合约；用 `contracts/main-list` 或 `contracts/main-continuous-list`。

## 端点清单

按需加载对应模块；本索引只做路由，参数与字段在各模块内。

| 端点 | 用途 | 文件 | 状态 |
| --- | --- | --- | --- |
| `GET /api/futures/prices/daily` | 期货合约 / 商品指数日 K | [prices.md](prices.md#1-期货日-k) | 已验证 |
| `GET /api/futures/prices/intraday` | 当前交易日分时 | [prices.md](prices.md#2-期货分时) | 已验证（仅当前交易日） |
| `GET /api/futures/contracts/detail` | 单个合约详情 | [contracts.md](contracts.md#1-合约详情) | 已验证 |
| `GET /api/futures/contracts/list` | 合约目录分页快照 | [contracts.md](contracts.md#2-合约基础信息列表) | 已验证（无 `total` 字段） |
| `GET /api/futures/contracts/main-continuous-list` | 主连清单 | [contracts.md](contracts.md#3-主连列表) | 已验证 |
| `GET /api/futures/contracts/main-list` | 主力合约清单 | [contracts.md](contracts.md#4-主力合约列表) | 已验证 |
| `GET /api/futures/contracts/secondary-main-list` | 次主力合约清单 | [contracts.md](contracts.md#5-次主力合约列表) | 已验证 |
| `GET /api/futures/contracts/commodity-index-list` | 商品指数合约清单 | [contracts.md](contracts.md#6-商品指数合约列表) | 已验证 |
| `GET /api/futures/varieties/list` | 品种目录与交易属性 | [varieties.md](varieties.md#1-品种资料) | 已验证 |
| `GET /api/futures/variety-plates/list` | 品种所属板块 | [varieties.md](varieties.md#2-品种板块) | 已验证 |
| `GET /api/futures/positions/variety-daily` | 品种日持仓 | [positions.md](positions.md#1-品种日持仓) | 已验证（限交易日） |
| `GET /api/futures/positions/company-variety-daily` | 公司品种日持仓 | [positions.md](positions.md#2-公司品种日持仓) | 已验证 |
| `GET /api/futures/positions/contract-daily` | 公司合约日持仓 | [positions.md](positions.md#3-公司合约日持仓) | 已验证 |
| `GET /api/futures/positions/contract-historical` | 公司合约历史持仓 | [positions.md](positions.md#4-公司合约历史持仓) | 已验证 |
| `GET /api/futures/positions/company-list` | 期货公司列表 | [positions.md](positions.md#5-期货公司列表) | 已验证 |
| `GET /api/futures/basis/main-continuous-latest` | 主连最新基差 | [basis.md](basis.md#1-主连最新基差) | 已验证 |
| `GET /api/futures/basis/historical` | 历史基差 | [basis.md](basis.md#2-历史基差) | 已验证 |
| `GET /api/futures/calendar/trading-schedule` | 交易日与交易时段 | [calendar.md](calendar.md#1-期货交易日) | 已验证 |
| `GET /api/futures/calendar/session-timeline` | 最近交易日交易时间轴 | [calendar.md](calendar.md#2-交易时间轴) | 已验证 |
| `GET /api/futures/warehouse-receipts/historical` | 历史仓单 | [warehouse-receipts.md](warehouse-receipts.md#1-历史仓单) | 已验证 |
| `GET /api/futures/fundamentals/indicators-historical` | 期货 F10 基本面指标 | [fundamentals.md](fundamentals.md) | 端外不可用（`code=2004`） |
## 错误与限流实测

| `code` | 实测触发场景 | 建议处理 |
| --- | --- | --- |
| `1001` | 缺 `thscode`（仓单、交易日历） | 补参数，不重试 |
| `1003` | 日 K 传 `min_1`；分时传历史 `trade_date` | 端外能力不开放，换端点或换当前交易日，不重试 |
| `1004` | 日 K 只传 `start` 或 `start > end` | 成对提供且顺序正确 |
| `2004` | F10 基本面指标 | 端外不可用，不重试 |
| `3001` | 合约不存在（含已到期合约、错误后缀） | 先用 `contracts/list` 确认有效代码 |
| `3004` | 商品指数走合约详情 / 基差历史 | 换成适用端点的目标类型 |
| `5003` | 非交易日查持仓；高频连发 | 先换交易日；连发时串行 + 间隔，退避重试 |

- 实测未出现 HTTP `429` 或 `code=4001`。网关层限流仍按 `429` / `4001` 处理，指数退避。
- 无间隔连发 40 次 `contracts/detail` 有 6 次返回 `5003`（`futures contract unavailable`）；加 200ms 间隔后全部 `code=0`。同一批连发 `varieties/list` 未失败，说明该现象与端点/瞬时并发有关，不是稳定限流码。批量取期货数据请串行并保留间隔。

## 未验证项

以下未在本次实测覆盖，使用前需单独验证，不要当成已确认事实：

- 日 K 的 `start/end` 上限：实测 10 年 2425 根成功，未测更长窗口和更细的截断边界。
- 分时 `session` 三档在盘前/盘中的真实差异：本次为盘后时段，三档返回同一份数据。
- `basis/historical` 的 `spot_indicator_id` 用法与时间范围上限。
- `company-variety-daily` 的 `varieties` 5 个上限（只测 2 个）。
- `contract-historical` 起始日一年窗口的边界行为。
- `contract-historical` 传入不存在的公司名称时的返回码。
- 主连/连续/加权代码的完整命名规则（只抽样了白银、沪铜、中证 500、不锈钢、豆一）。
- 商品指数除 `850002.TI` 外的其他代码。
- 期权端点（同一套文档提供 options），本次未验证。

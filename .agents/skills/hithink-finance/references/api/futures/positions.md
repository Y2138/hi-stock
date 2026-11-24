# 期货持仓端点

> 上级索引：[期货端点索引](index.md)

> 品种、公司、合约维度的日持仓与历史持仓。

## 1. 品种日持仓

```text
GET /api/futures/positions/variety-daily
```

指定交易日全品种持仓汇总。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `date` | query | string | 是 | 交易日 `yyyy-MM-dd`。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/positions/variety-daily?date=2026-11-06' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 74 条）：`date`、`variety_code`、`variety_name`、`volume`、`volume_change`、`long_position`、`long_position_change`、`short_position`、`short_position_change`、`net_position`、`net_position_change`、`twenty_day_avg_price`、`main_close_price`、`index_close_price`、`main_settle_price`、`main_change_ratio`、`change_risk`、`max_funds`、`capital_flow`。

> 实测非交易日（周日 `2026-11-08`）返回 `code=5003`（`Futures finance upstream returned failure status`），不是空数组。按交易日历选日期，遇到 `5003` 先换交易日再判断是否故障。

---

## 2. 公司品种日持仓

```text
GET /api/futures/positions/company-variety-daily
```

指定交易日、指定品种的期货公司持仓。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `date` | query | string | 是 | 交易日 `yyyy-MM-dd`。 | — |
| `varieties` | query | string | 是 | 1–5 个大写品种代码，逗号分隔。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/positions/company-variety-daily?date=2026-11-06&varieties=CU,AU' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（`CU,AU` 实测 127 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | string \| null | 交易日期。 |
| `variety_code` | string \| null | 品种代码。 |
| `company_name` | string \| null | 期货公司名称。 |
| `volume` | number \| null | 成交量。 |
| `volume_change` | number \| null | 成交量变化。 |
| `long_position` | number \| null | 多头持仓。 |
| `long_position_change` | number \| null | 多头持仓变化。 |
| `short_position` | number \| null | 空头持仓。 |
| `short_position_change` | number \| null | 空头持仓变化。 |
| `net_position` | number \| null | 净持仓。 |
| `net_position_change` | number \| null | 净持仓变化。 |
| `price_spread_contract` | string \| null | 价差合约代码文本。 |
| `day_profit` | number \| null | 日收益。 |
| `year_profit` | number \| null | 年收益。 |
| `week_win_rate` | number \| null | 周胜率原值。 |
| `day_mood` | number \| null | 当日情绪值。 |
| `three_day_mood` / `five_day_mood` | number \| null | 近 3 / 5 日情绪值。 |
| `three_day_net_change` / `five_day_net_change` | number \| null | 近 3 / 5 日净变化。 |
| `max_funds` | number \| null | 最大资金原值。 |
| `year_profit_days` | integer \| null | 年度盈利天数。 |

> 情绪值（`*_mood`）与收益字段是上游原值，口径未在文档中定义，不要二次解释成评级或建议。

---

## 3. 公司合约日持仓

```text
GET /api/futures/positions/contract-daily
```

单个合约在某交易日的各公司持仓与均价。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约完整代码。 | — |
| `variety` | query | string | 是 | 大写品种代码，须与 `thscode` 一致。 | — |
| `date` | query | string | 是 | 交易日 `yyyy-MM-dd`。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/positions/contract-daily?thscode=CU2701.SHF&variety=CU&date=2026-11-06' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：`timestamp`、`date`、`position_item[]`、`average_item[]`（两序列**不按位置关联**）。

`position_item[]`：`date`、`thscode`、`ticker`、`company_name`、`volume`、`volume_change`、`long_position`、`long_position_change`、`short_position`、`short_position_change`、`net_position`、`net_position_change`。

`average_item[]`：`date`、`company_long_avg`、`company_short_avg`。

> 实测 `CU2701.SHF` 于 2026-11-06 返回 36 条持仓、36 条均价。

---

## 4. 公司合约历史持仓

```text
GET /api/futures/positions/contract-historical
```

指定公司、指定合约的历史持仓序列，结束日固定为调用日。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约完整代码。 | — |
| `variety` | query | string | 是 | 大写品种代码。 | — |
| `company` | query | string | 是 | 期货公司名称（用 `company-list` 的 `company_name`）。 | — |
| `start_date` | query | string | 是 | 起始日期，须在调用日前一年内。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/positions/contract-historical?thscode=CU2701.SHF&variety=CU&company=方正中期期货&start_date=2026-06-01' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：`timestamp`、`start_date`、`end_date`（均按请求/调用日回填，`end_date` 为调用日）、`position_item[]`、`average_item[]`，子字段同 [公司合约日持仓](#3-公司合约日持仓)。

> 实测 2026-06-01 起返回 89 条，`end_date` 为 `2026-11-09`（调用日）。`company` 名称不匹配时未单独验证。

---

## 5. 期货公司列表

```text
GET /api/futures/positions/company-list
```

### 请求参数

无业务参数。

### 响应字段

`data.item[]`（实测 143 条）：`company_id`、`company_name`。

> 用这里的 `company_name` 原值传给 `contract-historical` 的 `company`，不要自行简称。

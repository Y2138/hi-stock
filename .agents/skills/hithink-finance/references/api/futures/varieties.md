# 期货品种端点

> 上级索引：[期货端点索引](index.md)

> 品种目录与交易属性、品种所属板块。

## 1. 品种资料

```text
GET /api/futures/varieties/list
```

期货品种目录与交易属性。

### 请求参数

无业务参数。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/varieties/list' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 92 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `variety_code` | string \| null | 品种代码，如 `CU`。 |
| `quote_code` | string \| null | 行情代码（可能小写，如 `cu`）。 |
| `name` | string \| null | 品种名称。 |
| `exchange_code` | string \| null | 交易所代码。 |
| `exchange_name` | string \| null | 交易所全称。 |
| `has_night_session` | boolean \| null | 是否有夜盘。 |
| `margin_rate` | number \| null | 保证金率。 |
| `main_contract_thscode` | string \| null | 主力合约代码；**实测可能为 `null`**。 |
| `trade_amount` | number \| null | 交易单位数量。 |
| `price_coefficient` | number \| null | 价格系数。 |
| `tick_size` | number \| null | 最小变动价位。 |
| `contract_multiplier` | number \| null | 合约乘数。 |
| `price_unit` | string \| null | 报价单位，如「元（人民币）/吨」。 |
| `trade_unit` | string \| null | 交易单位，如「吨/手」。 |
| `capital_flow` | number \| null | 资金流原值。 |
| `long_short_ratio` | number \| null | 多空比。 |
| `transaction_fee` | number \| null | 手续费。 |
| `transaction_fee_rate` | number \| null | 手续费率。 |
| `trade_sessions[]` | array | 交易时段。 |
| `trade_sessions[].start_time` | string \| null | 开始时间，原始字符串如 `090000`。 |
| `trade_sessions[].end_time` | string \| null | 结束时间。 |
| `trade_sessions[].session_type` | string \| null | `day` / `night`。 |

---

## 2. 品种板块

```text
GET /api/futures/variety-plates/list
```

品种与板块层级的对应关系。

### 请求参数

无业务参数。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/variety-plates/list' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 196 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `variety_code` | string \| null | 品种代码。 |
| `name` | string \| null | 品种名称。 |
| `plate_level` | integer \| null | 板块层级。 |
| `plate_name` | string \| null | 板块名称，如「金融」。 |

> 一个品种可对应多级板块，按 `variety_code` 聚合后才是完整板块链。

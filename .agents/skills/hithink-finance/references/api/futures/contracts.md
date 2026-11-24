# 期货合约端点

> 上级索引：[期货端点索引](index.md)

> 合约详情、目录、主连 / 主力 / 次主力、商品指数合约。

## 1. 合约详情

```text
GET /api/futures/contracts/detail
```

单个期货合约或主连的基础资料。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约或主连完整 thscode。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/contracts/detail?thscode=CU2701.SHF' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long | 数据时间（毫秒）。 |
| `thscode` | string \| null | 完整 thscode。 |
| `ticker` | string \| null | 纯代码（主连为 `au9999` 形态）。 |
| `name` | string \| null | 名称，如「沪铜2701」「沪金主连」。 |
| `variety_code` | string \| null | 品种代码，如 `CU`。 |
| `variety_name` | string \| null | 品种名称。 |
| `exchange_code` | string \| null | 交易所代码。 |
| `list_date` | string \| null | 上市日期；主连为 `null`。 |
| `end_date` | string \| null | 上市结束日期。 |
| `last_trade_date` | string \| null | 最后交易日。 |
| `last_delivery_date` | string \| null | 最后交割日。 |

> 商品指数（如 `850002.TI`）不支持本端点，返回 `code=3004`（`Capability not supported for target type`）。

---

## 2. 合约基础信息列表

```text
GET /api/futures/contracts/list
```

完整期货目录快照，按 `limit/offset` 分页，适合本地建索引或反查有效合约。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `limit` | query | integer | 否 | 单页条数，范围 1–1000。 | `100` |
| `offset` | query | integer | 否 | 分页偏移，最小 0。 | `0` |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/contracts/list?limit=1000&offset=0' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long | 数据时间（毫秒）。 |
| `total` | integer | 文档声明的合约总数；**实测响应未返回该字段**。 |
| `item` | array | 合约基础信息列表。 |

`item[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `thscode` | string \| null | 完整 thscode。 |
| `ticker` | string \| null | 纯代码；连续/加权为 `CU7777`、`SS8888` 形态。 |
| `name` | string \| null | 名称。 |
| `exchange_code` | string \| null | 交易所代码。 |
| `variety_code` | string \| null | 品种代码。 |
| `list_date` | string \| null | 上市日期；连续/加权为 `null`。 |
| `end_date` | string \| null | 结束日期。 |
| `last_trade_date` | string \| null | 最后交易日。 |
| `last_delivery_date` | string \| null | 最后交割日。 |

> 实测目录共 1141 条（`offset=0` 取满 1000，`offset=1000` 返回 141，`offset=1141` 返回空数组）。因无 `total` 字段，**终止条件按「当前页条数 < limit」判断**。目录同时包含具体合约、连续、加权和主连条目。

---

## 3. 主连列表

```text
GET /api/futures/contracts/main-continuous-list
```

各品种主连合约清单。

### 请求参数

无业务参数。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/contracts/main-continuous-list' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 88 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `thscode` | string \| null | 主连代码，如 `AUZL.SHF`。 |
| `ticker` | string \| null | 主连 ticker，如 `au9999`。 |
| `name` | string \| null | 名称，如「沪金主连」。 |
| `variety_code` | string \| null | 品种代码；实测部分条目为 `null`。 |
| `variety_name` | string \| null | 品种名称；实测部分条目为 `null`。 |
| `exchange_code` | string \| null | 交易所代码。 |
| `minute_visit_count` | integer \| null | 分时访问计数。 |
| `kline_visit_count` | integer \| null | K 线访问计数。 |
| `statistics_date` | string \| null | 统计日期。 |

---

## 4. 主力合约列表

```text
GET /api/futures/contracts/main-list
```

当前各品种主力合约清单。

### 请求参数

无业务参数。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/contracts/main-list' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 91 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `thscode` | string \| null | 主力合约完整代码，如 `IC2612.CFE`。 |
| `ticker` | string \| null | 纯代码。 |
| `name` | string \| null | 名称。 |
| `variety_code` | string \| null | 品种代码。 |
| `variety_name` | string \| null | 品种名称。 |
| `exchange_code` | string \| null | 交易所代码。 |
| `list_date` | string \| null | 上市日期。 |
| `end_date` | string \| null | 结束日期。 |
| `last_trade_date` | string \| null | 最后交易日。 |
| `last_delivery_date` | string \| null | 最后交割日。 |
| `margin_rate` | number \| null | 保证金率。 |
| `transaction_fee` | number \| null | 手续费。 |
| `transaction_fee_rate` | number \| null | 手续费率。 |

---

## 5. 次主力合约列表

```text
GET /api/futures/contracts/secondary-main-list
```

次主力合约清单，字段与主力合约一致（实测 90 条）。合法无数据返回空数组。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/contracts/secondary-main-list' \
  -H 'X-api-key: <your-api-key>'
```

---

## 6. 商品指数合约列表

```text
GET /api/futures/contracts/commodity-index-list
```

期货商品指数合约清单。

### 请求参数

无业务参数。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/contracts/commodity-index-list' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 136 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `thscode` | string \| null | 指数代码，如 `850002.TI`。 |
| `ticker` | string \| null | 纯代码，如 `850002`。 |
| `name` | string \| null | 名称。 |
| `list_date` | string \| null | 上市日期。 |
| `end_date` | string \| null | 结束日期，可为 `null`。 |

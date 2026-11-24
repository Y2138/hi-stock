# 期货行情端点

> 上级索引：[期货端点索引](index.md)

> 期货日 K 与当前交易日分时。端外只有日 K 和当日分时。

## 1. 期货日 K

```text
GET /api/futures/prices/daily
```

期货合约或期货商品指数的日 K 线。**端外（REST）只支持日 K**，分钟/周/月/季/年线仅同花顺 AI 客户端内可用。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约或商品指数完整 thscode。 | — |
| `start` | query | long | 否 | 起始毫秒时间戳，必须与 `end` 成对提供。 | — |
| `end` | query | long | 否 | 结束毫秒时间戳，不得早于 `start`。 | — |
| `time_period` | query | string | 否 | 端外仅允许 `day_1`。 | `day_1` |

> 两个时间戳都省略时返回**最近 100 根**日 K。只传一个返回 `code=1004`（`Parameter conflict: start/end`）；`start > end` 同样 `1004`。传 `min_1` 等非日线周期返回 `code=1003`（`Extended market parameters are not enabled`）。

### 请求示例

```bash
# 最近 100 根
curl 'https://fuyao.aicubes.cn/api/futures/prices/daily?thscode=CU2701.SHF' \
  -H 'X-api-key: <your-api-key>'

# 指定区间
curl 'https://fuyao.aicubes.cn/api/futures/prices/daily?thscode=CU2701.SHF&start=1767225600000&end=1767830400000' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long | 响应生成时间（毫秒）。 |
| `thscode` | string | 请求的合约代码。 |
| `interval` | string | 实际周期，端外固定 `1d`。 |
| `item` | array | K 线列表。 |

`item[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long \| null | 该根 K 线时间（毫秒，东八区交易日零点）。 |
| `open_price` | number \| null | 开盘价。 |
| `high_price` | number \| null | 最高价。 |
| `low_price` | number \| null | 最低价。 |
| `close_price` | number \| null | 收盘价。 |
| `volume` | number \| null | 成交量（手）。 |
| `turnover` | number \| null | 成交额。 |
| `open_interest` | number \| null | 持仓量。 |

> 实测：`CU2701.SHF` 默认返回 100 根；区间 2026-01-01～2026-01-08 返回 4 根；10 年窗口（2016-11-01～2026-11-09）返回 2425 根，未触发截断。价格单位为该品种报价单位（沪铜为元/吨），不是元/手。

---

## 2. 期货分时

```text
GET /api/futures/prices/intraday
```

当前交易日分时序列。**端外只支持当前交易日**，历史交易日仅 AI 客户端内可用。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约或商品指数完整 thscode。 | — |
| `session` | query | string | 否 | `pre_market` / `intraday` / `post_market`。 | `intraday` |
| `trade_date` | query | string | 否 | 端外仅允许 `0`（当前交易日）。 | — |

> 传历史交易日（如 `20261107`）返回 `code=1003`（`Extended market parameters are not enabled`）。实测 `pre_market` / `intraday` / `post_market` 在端外返回同一份当前交易日序列，不要据此判断盘中阶段。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/prices/intraday?thscode=CU2701.SHF' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long | 响应生成时间（毫秒）。 |
| `thscode` | string | 合约代码。 |
| `date` | string | 交易日期 `yyyy-MM-dd`。 |
| `session` | string | 行情阶段。 |
| `item` | array | 分时点列表。 |

`item[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long \| null | 分时点时间（毫秒）。 |
| `price` | number \| null | 价格。 |
| `volume` | number \| null | 该分钟成交量。 |
| `turnover` | number \| null | 该分钟成交额。 |

> 实测 `CU2701.SHF` 返回 466 条（含夜盘，覆盖 21:00 至次日 15:00），商品指数 `850002.TI` 返回 556 条。

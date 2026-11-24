# 期货交易日端点

> 上级索引：[期货端点索引](index.md)

> 交易日与交易时段、最近交易日交易时间轴。

## 1. 期货交易日

```text
GET /api/futures/calendar/trading-schedule
```

指定合约在日期范围内的交易日与交易时段安排。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约完整代码。 | — |
| `start_date` | query | string | 是 | 开始日期 `yyyy-MM-dd`。 | — |
| `end_date` | query | string | 是 | 结束日期，不早于开始日期。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/calendar/trading-schedule?thscode=CU2701.SHF&start_date=2026-11-02&end_date=2026-11-09' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timestamp` | long | 数据时间（毫秒）。 |
| `thscode` | string | 合约代码。 |
| `trade_dates` | array | 交易日期数组，实测按倒序返回。 |
| `regular_schedules[]` | array | 常规日程：`start_date`、`end_date`、`times[]`。 |
| `regular_schedules[].times[]` | array | `start_time`、`end_time`、`offset`、`trans_day_type`、`type`。 |
| `special_schedules[]` | array | 特殊日程：`date`、`times[]`（毫秒时间戳）。 |
| `timezone` | string | 时区，实测 `UTC+08:00`。 |
| `daylight_saving_periods[]` | array | `start`、`end`、`offset`。 |

> 夜盘跨日：实测沪铜常规日程含 `21:00:00–01:00:00`、`offset=-1`、`trans_day_type="1"`，表示该时段属于下一交易日。做日频对齐时按 `offset` 归属，不要按自然日切。

---

## 2. 交易时间轴

```text
GET /api/futures/calendar/session-timeline
```

合约最近交易日的交易阶段与交易所阶段。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约完整代码。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/calendar/session-timeline?thscode=CU2701.SHF' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data`：`timestamp`、`thscode`、`trade_date`、`timezone`（`Asia/Shanghai`）。

`trade_stages[]`：`trade_period`（如 `intraday`）、`trade_ranges[].begin_time` / `end_time`（毫秒）。

`exchange_sessions[]`：`trade_phase`（如 `continuous`、`open_auction`）、`phase_range[].begin_time` / `end_time`（毫秒）。

> 实测 `CU2701.SHF` 返回 1 个 `trade_stages`（4 段）和 2 个 `exchange_sessions`（`continuous` 4 段 + `open_auction` 1 段）。

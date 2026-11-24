# 期货仓单端点

> 上级索引：[期货端点索引](index.md)

> 历史仓单数据。

## 1. 历史仓单

```text
GET /api/futures/warehouse-receipts/historical
```

指定合约在日期范围内的仓单数据。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约完整代码。 | — |
| `start_date` | query | string | 是 | 开始日期 `yyyy-MM-dd`。 | — |
| `end_date` | query | string | 是 | 结束日期，不早于开始日期。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/warehouse-receipts/historical?thscode=CU2701.SHF&start_date=2026-10-01&end_date=2026-11-09' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | string \| null | 仓单日期。 |
| `amount` | number \| null | 仓单数量。 |
| `amount_change` | number \| null | 仓单数量变化。 |
| `equivalent_lots` | number \| null | 折合手数，实测可带小数。 |

> 实测 2026-10-01～2026-11-09 返回 23 条。

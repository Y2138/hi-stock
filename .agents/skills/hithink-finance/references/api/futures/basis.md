# 期货基差端点

> 上级索引：[期货端点索引](index.md)

> 主连最新基差与历史基差。

## 1. 主连最新基差

```text
GET /api/futures/basis/main-continuous-latest
```

各品种主连的最新基差快照。

### 请求参数

无业务参数。

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/basis/main-continuous-latest' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`（实测 145 条）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `thscode` | string \| null | 主连代码，如 `CUZL.SHF`。 |
| `ticker` | string \| null | 主连 ticker，如 `cu9999`。 |
| `name` | string \| null | 名称，如「沪铜主连」。 |
| `variety_name` | string \| null | 品种名称。 |
| `reference_site` | string \| null | 现货参考地区/来源，如「上海」「华东」。 |
| `updated_at` | string \| null | 更新时间，原始字符串如 `2026.11.09 11:03:37`。 |
| `spot_publish_date` | string \| null | 现货发布日期。 |
| `spot_indicator_id` | string \| null | 现货指标 ID，可传给历史基差。 |
| `spot_price` | number \| null | 现货价格。 |
| `converted_spot_price` | number \| null | 折算现货价格。 |
| `close_price` | number \| null | 收盘价。 |
| `settle_price` | number \| null | 结算价。 |
| `close_basis` | number \| null | 收盘基差。 |
| `settle_basis` | number \| null | 结算基差。 |
| `close_basis_rate` | number \| null | 收盘基差比例（百分比数值）。 |
| `settle_basis_rate` | number \| null | 结算基差比例（百分比数值）。 |
| `default_value` | string \| null | 是否默认口径，`Y` / `N`。 |
| `average_close_basis` | number \| null | 平均收盘基差。 |
| `average_settle_basis` | number \| null | 平均结算基差。 |

> **同一品种会返回多行**：不同 `reference_site` 对应不同现货口径，`default_value=Y` 的是默认口径。取单一结论前先按品种 + `default_value` 过滤，否则会把多条现货口径混在一起。

---

## 2. 历史基差

```text
GET /api/futures/basis/historical
```

指定合约或主连的历史基差序列。

### 请求参数

| 参数 | 位置 | 类型 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| `thscode` | query | string | 是 | 期货合约或主连完整代码。 | — |
| `spot_indicator_id` | query | string | 否 | 现货指标 ID，省略时用上游默认口径。 | — |

### 请求示例

```bash
curl 'https://fuyao.aicubes.cn/api/futures/basis/historical?thscode=CUZL.SHF' \
  -H 'X-api-key: <your-api-key>'
```

### 响应字段

`data.item[]`：`date`、`spot_price`、`converted_spot_price`、`close_price`、`settle_price`、`close_basis`、`settle_basis`、`close_basis_rate`、`settle_basis_rate`。

> 实测 `CU2701.SHF` 与 `CUZL.SHF` 都返回 1208 条，最早到 2021-11-09，说明本端点按品种回溯而非按合约存续期截断。商品指数（`850002.TI`）返回 `code=3004`。

-- 0063_每日计划确定性上下文.sql：补齐止损档位、护盘收回率和每日计划完成门禁。

ALTER TABLE pool_membership
  ADD COLUMN stop_loss_mode text
    CHECK (stop_loss_mode IS NULL OR stop_loss_mode IN ('ma5','ma10','fixed_90'));

-- 仅识别已经明确写成独立标签的旧配置；其他现有成员保持空值，等待用户确认。
UPDATE pool_membership
   SET stop_loss_mode = CASE
         WHEN tags ? '止损：MA5' OR tags ? '止损MA5'
           OR stock_character ~ '(^|·)止损[:：]?MA5($|·)' THEN 'ma5'
         WHEN tags ? '止损：MA10' OR tags ? '止损MA10'
           OR stock_character ~ '(^|·)止损[:：]?MA10($|·)' THEN 'ma10'
         WHEN tags ? '止损：买入价×0.90' OR tags ? '止损0.90'
           OR stock_character ~ '(^|·)止损[:：]?(买入价×)?0[.]90($|·)' THEN 'fixed_90'
       END
 WHERE stop_loss_mode IS NULL
   AND pool = 'short'
   AND (
     tags ?| ARRAY['止损：MA5','止损MA5','止损：MA10','止损MA10','止损：买入价×0.90','止损0.90']
     OR stock_character ~ '(^|·)止损[:：]?(MA5|MA10|(买入价×)?0[.]90)($|·)'
   );

CREATE TABLE market_stock_character_metric (
  instrument_id          bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  as_of_date              date NOT NULL,
  calculation_version     text NOT NULL,
  indicator_run_id        bigint NOT NULL UNIQUE REFERENCES market_indicator_run(id) ON DELETE CASCADE,
  input_row_count         integer NOT NULL CHECK (input_row_count BETWEEN 0 AND 252),
  defense_break_count     integer NOT NULL CHECK (defense_break_count >= 0),
  defense_recovered_count integer NOT NULL CHECK (
    defense_recovered_count >= 0 AND defense_recovered_count <= defense_break_count
  ),
  defense_recovery_ma10   double precision CHECK (
    defense_recovery_ma10 IS NULL OR (defense_recovery_ma10 >= 0 AND defense_recovery_ma10 <= 1)
  ),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, as_of_date, calculation_version)
);
CREATE INDEX market_stock_character_metric_latest
  ON market_stock_character_metric (instrument_id, as_of_date DESC, computed_at DESC);

-- 仅安排当前池成员和持仓补算，其他标的随下一次日线同步自然生成。
INSERT INTO market_indicator_dirty
  (instrument_id, freq, earliest_date, generation, reason, updated_at)
SELECT bar.instrument_id,
       'day',
       (max(bar.bar_date) - INTERVAL '6 years')::date,
       1,
       '补算护盘收回率',
       now()
  FROM market_bar bar
  JOIN market_instrument instrument ON instrument.id = bar.instrument_id AND instrument.kind = 'stock'
 WHERE bar.freq = 'day'
   AND (
     EXISTS (
       SELECT 1 FROM pool_membership membership
        WHERE membership.instrument_id = bar.instrument_id AND membership.effective_to IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM portfolio_position position
        WHERE position.instrument_id = bar.instrument_id AND position.quantity > 0
     )
   )
 GROUP BY bar.instrument_id
ON CONFLICT (instrument_id, freq) DO UPDATE SET
  earliest_date = EXCLUDED.earliest_date,
  generation = market_indicator_dirty.generation + 1,
  reason = EXCLUDED.reason,
  updated_at = now();

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 每日计划确定性完成门禁%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $daily_plan_gate$

## 每日计划确定性完成门禁

1. 本轮首先调用一次 `daily_plan_context_query(date=目标日)`；市场状态、全市场温度、七类市场结构同步、短线池试盘启动扫描、持仓止损档位与护盘收回率均以该工具的紧凑结果为准，不再用通用大结果手工拼接。
2. 上一份计划只继承尚未执行或尚未失效的动作，不继承任何数据缺口、工具不可用结论或同步失败结论；每个缺口都必须在本轮重新调用当前工具复验。
3. 市场状态只有在完整 881 一级行业全集覆盖下，综合指数 MA5、MA20、ROC5 和牛市/震荡/熊市结论全部存在时才算完成；不得用残缺板块集合定级。全市场温度同样保留覆盖计数。
4. 七类 `market_special_sync_run` 必须逐类保留实际数据日、最新同日运行、状态、完成页数与行数；`success` 且 0 页、0 行是合法空集，不得改写为同步失败。
5. 试盘启动必须使用工具返回的短线池扫描总数、完成数、匹配项和逐只数据缺口；未匹配不是未核验。持仓止损档位或护盘收回率为空时，只能引用工具明确返回的对应缺口。
6. 确认实际市场结构数据日后仍须单独调用一次 `limit_up_signal_query`，并保留候选数、有效信号数、两类分数、路线名次与确定性缺口；当前工具目录中存在的工具不得根据旧运行结论写成不可用。
7. 只有确定性工具本轮明确返回 `partial`、`unavailable`、`missing` 或逐项缺口时，最终 Markdown 才能列为数据限制；否则必须给出确定结论和覆盖计数，不得以“本轮未完成”提前结束。
$daily_plan_gate$ AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(max(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '每日计划优先使用确定性上下文并逐项复验数据缺口'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

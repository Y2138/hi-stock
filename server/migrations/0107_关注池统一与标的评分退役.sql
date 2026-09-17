-- 0107_关注池统一与标的评分退役.sql：短线/长线双池合并为单一"关注池"，移除标的评分机制。
-- 背景：全市场回测验证右侧与试盘信号不具备普适性，左侧信号因池子过小无法适配；系统改为
-- 统一"关注池"承接系统信号与用户自选，五维研究评分不再参与任何决策。
-- 变更：
--   1) pool_membership.pool 收敛为 'watch'，role 统一为 '关注'；
--   2) 移除 pool_membership.score/grade 与 market_stock_character_metric.research_score/grade；
--   3) 近期关注改为多来源条目表 pool_attention_entry，所有定时评估任务的信号统一入关注池。

-- 1) 池统一：先移除旧约束，搬数据后再收口。
ALTER TABLE pool_membership DROP CONSTRAINT pool_membership_pool_check;

-- 同一标的同一天若曾同时存在短线与长线记录，池统一后保留仍在生效的记录，
-- 删除已被替代的重复历史行，避免撞 (instrument_id, pool, effective_from) 唯一键。
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY instrument_id, effective_from
           ORDER BY (effective_to IS NULL) DESC, id DESC
         ) AS rank
    FROM pool_membership
)
DELETE FROM pool_membership membership
 USING ranked
 WHERE membership.id = ranked.id
   AND ranked.rank > 1;

UPDATE pool_membership SET pool = 'watch' WHERE pool <> 'watch';
UPDATE pool_membership SET role = '关注' WHERE role <> '关注';
ALTER TABLE pool_membership
  ADD CONSTRAINT pool_membership_pool_check CHECK (pool = 'watch');
COMMENT ON COLUMN pool_membership.pool IS '关注池标识；系统当前只有单一关注池 watch';

ALTER TABLE pool_board_preference DROP CONSTRAINT pool_board_preference_pool_check;
UPDATE pool_board_preference SET pool = 'watch' WHERE pool <> 'watch';
ALTER TABLE pool_board_preference
  ADD CONSTRAINT pool_board_preference_pool_check CHECK (pool = 'watch');

COMMENT ON COLUMN pool_membership.role IS '入池角色；池统一后固定为 关注';

-- 2) 标的评分退役：五维股性画像（股性、阶段、标签、关键位）保留，评分与等级全部移除。
ALTER TABLE pool_membership DROP COLUMN score;
ALTER TABLE pool_membership DROP COLUMN grade;
COMMENT ON TABLE market_stock_character_metric IS '标的股性指标：保留股性画像/阶段/标签，研究评分已退役';

ALTER TABLE market_stock_character_metric DROP COLUMN research_score;
ALTER TABLE market_stock_character_metric DROP COLUMN grade;

-- 3) 近期关注多来源化：每个标的每个来源一条，来源为任务 code 或 'manual'（人工）。
CREATE TABLE pool_attention_entry (
  instrument_id   bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  source_job      text NOT NULL CHECK (source_job <> ''),
  status          text NOT NULL CHECK (status IN ('qualified','approaching','manual')),
  reason          text NOT NULL CHECK (length(reason) <= 500),
  missing_signals jsonb NOT NULL DEFAULT '[]' CHECK (
    jsonb_typeof(missing_signals) = 'array'
    AND (
      status IN ('qualified','manual')
      OR missing_signals <> '[]'::jsonb
    )
    AND (
      status NOT IN ('qualified','manual')
      OR missing_signals = '[]'::jsonb
    )
  ),
  valid_from      date NOT NULL,
  valid_until     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source_job)
);

COMMENT ON TABLE pool_attention_entry IS '关注池近期关注条目：每个定时任务与人工各自维护，互不清除';
COMMENT ON COLUMN pool_attention_entry.source_job IS '关注来源：agent 任务 code，人工关注为 manual';
COMMENT ON COLUMN pool_attention_entry.status IS 'qualified=信号已成立；approaching=待补信号；manual=人工关注';
COMMENT ON COLUMN pool_attention_entry.missing_signals IS 'approaching 时逐项列出尚未成立的信号与次日确认标准';
COMMENT ON COLUMN pool_attention_entry.instrument_id IS '关注标的';
COMMENT ON COLUMN pool_attention_entry.reason IS '关注原因；人工与自动关注均为纯文本';
COMMENT ON COLUMN pool_attention_entry.valid_from IS '关注生效开始日期';
COMMENT ON COLUMN pool_attention_entry.valid_until IS '关注有效截止日期；为空表示持续有效';
COMMENT ON COLUMN pool_attention_entry.created_at IS '创建时间';
COMMENT ON COLUMN pool_attention_entry.updated_at IS '最近更新时间';

-- 存量关注全部来自每日计划自动写入（原因带"每日计划·"前缀），迁移到对应来源条目。
INSERT INTO pool_attention_entry
  (instrument_id, source_job, status, reason, missing_signals, valid_from, valid_until, created_at, updated_at)
SELECT membership.instrument_id,
       'daily_plan_flow',
       COALESCE(membership.attention_signal ->> 'status', 'qualified'),
       membership.attention_reason,
       COALESCE(membership.attention_signal -> 'missing_signals', '[]'::jsonb),
       COALESCE(membership.attention_from, CURRENT_DATE),
       membership.attention_until,
       now(),
       now()
  FROM pool_membership membership
 WHERE membership.effective_to IS NULL
   AND membership.attention_reason IS NOT NULL;

ALTER TABLE pool_membership DROP CONSTRAINT pool_attention_signal_check;
ALTER TABLE pool_membership DROP COLUMN attention_signal;
ALTER TABLE pool_membership DROP COLUMN attention_reason;
ALTER TABLE pool_membership DROP COLUMN attention_from;
ALTER TABLE pool_membership DROP COLUMN attention_until;

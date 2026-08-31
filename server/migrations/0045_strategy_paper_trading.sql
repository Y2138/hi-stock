-- 0045_strategy_paper_trading.sql：每日计划驱动的独立策略模拟账户。

CREATE TABLE strategy_paper_account (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initial_cash  numeric(18,2) NOT NULL CHECK (initial_cash > 0),
  cash          numeric(18,2) NOT NULL CHECK (cash >= 0),
  realized_pnl  numeric(18,2) NOT NULL DEFAULT 0,
  slippage_bp   numeric(8,4) NOT NULL DEFAULT 0.2 CHECK (slippage_bp >= 0 AND slippage_bp <= 100),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO strategy_paper_account (singleton, initial_cash, cash, slippage_bp)
VALUES (true, 200000, 200000, 0.2);

CREATE TABLE strategy_paper_position (
  instrument_id bigint PRIMARY KEY REFERENCES market_instrument(id),
  quantity      numeric NOT NULL CHECK (quantity > 0),
  cost_price    numeric(18,6) NOT NULL CHECK (cost_price > 0),
  opened_at     date NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_paper_signal (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id      bigint NOT NULL REFERENCES market_instrument(id),
  source_job_run_id  bigint NOT NULL REFERENCES job_run(id),
  plan_output_id     bigint REFERENCES job_run_output(id) ON DELETE SET NULL,
  execute_date       date NOT NULL,
  side               text NOT NULL CHECK (side IN ('buy','sell')),
  quantity           numeric CHECK (quantity IS NULL OR quantity > 0),
  reason             text NOT NULL CHECK (length(btrim(reason)) > 0),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','executed','rejected')),
  last_error         text,
  executed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_run_id, instrument_id),
  CHECK ((side = 'buy' AND quantity IS NOT NULL) OR side = 'sell')
);
CREATE INDEX strategy_paper_signal_pending
  ON strategy_paper_signal (execute_date, id) WHERE status = 'pending';

CREATE TABLE strategy_paper_trade (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal_id             bigint NOT NULL UNIQUE REFERENCES strategy_paper_signal(id),
  instrument_id         bigint NOT NULL REFERENCES market_instrument(id),
  trade_date            date NOT NULL,
  side                  text NOT NULL CHECK (side IN ('buy','sell')),
  quantity              numeric NOT NULL CHECK (quantity > 0),
  open_price            numeric(18,6) NOT NULL CHECK (open_price > 0),
  slippage_bp           numeric(8,4) NOT NULL,
  price                 numeric(18,6) NOT NULL CHECK (price > 0),
  amount                numeric(18,2) NOT NULL CHECK (amount > 0),
  cost_price_before     numeric(18,6),
  realized_pnl          numeric(18,2),
  cash_after            numeric(18,2) NOT NULL CHECK (cash_after >= 0),
  strategy_change_seq   bigint,
  strategy_snapshot_hash text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strategy_paper_trade_date ON strategy_paper_trade (trade_date DESC, id DESC);

COMMENT ON TABLE strategy_paper_account IS '每日计划驱动的独立模拟账户；不与真实持仓或券商资金互通';
COMMENT ON COLUMN strategy_paper_account.slippage_bp IS '成交偏移，单位 bp；0.2bp = 0.002%';
COMMENT ON TABLE strategy_paper_signal IS '每日计划通过窄权限工具写入的次日模拟成交指令';
COMMENT ON TABLE strategy_paper_trade IS '按目标交易日开盘价和固定偏移生成的模拟成交记录，不代表真实交易';

UPDATE job_definition
   SET config = config || '{"paper_trade_signal_write":true}'::jsonb,
       updated_at = now()
 WHERE code = 'daily_plan_flow'
   AND job_type = 'agent_flow'
   AND config->>'paper_trade_signal_write' IS DISTINCT FROM 'true';

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content NOT LIKE '%## 策略模拟账户信号%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         content || $paper_trading$

## 策略模拟账户信号

在最终 Markdown 前，把本次计划中可由策略机械执行的下一交易日动作写入独立模拟账户；模拟账户初始资金 200,000 元，与真实持仓完全隔离。

1. 对已调用 `pool_attention_write mark` 标为“已符合”的池内标的，只有当本次计划给出了明确、可执行且不依赖盘中再次判断的买入数量时，才调用 `paper_trade_signal_write` 写入 `buy` 信号。`execute_date` 必须是计划动作对应的下一交易日，`quantity` 必须使用计划数量，不得按剩余资金临时猜测。
2. 对本次计划明确要求下一交易日退出、且当前存在 `strategy_paper_position` 模拟持仓的标的，调用 `paper_trade_signal_write` 写入 `sell` 信号；卖出数量留空表示退出该标的全部模拟持仓。
3. “即将符合”、池外待验证候选、仍需盘中确认、缺少明确数量或只有主观建议的标的不得写入模拟交易信号。没有机械执行动作时不要调用工具。
4. 信号只在本次任务成功生成结果后生效。系统在目标交易日收盘后的行情更新中，以当日开盘价执行：买入价=`open × (1 + 0.2/10000)`，卖出价=`open × (1 - 0.2/10000)`；0.2bp 即 0.002%，不计手续费。资金不足、无模拟持仓或缺少目标日开盘价时不得伪造成交，必须保留失败或缺口记录。
5. 最终 Markdown 增加“策略模拟信号”小节，逐项列出已写入和未写入的机械动作及原因。模拟信号和成交仅用于检验策略，不代表真实交易，也不得写入 `portfolio_position` 或 `portfolio_position_change`。
$paper_trading$ AS content
    FROM current_prompt
), inserted AS (
  INSERT INTO job_prompt_revision
    (prompt_id, revision_no, content, sha256, source, base_revision_id, change_summary)
  SELECT prepared.prompt_id,
         (SELECT COALESCE(MAX(existing.revision_no), 0) + 1
            FROM job_prompt_revision existing WHERE existing.prompt_id = prepared.prompt_id),
         prepared.content,
         encode(sha256(convert_to(prepared.content, 'UTF8')), 'hex'),
         'user',
         prepared.base_revision_id,
         '每日计划增加独立策略模拟账户的结构化买卖信号'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

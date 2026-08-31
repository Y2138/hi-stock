-- 0049_strategy_paper_price_offset.sql：策略模拟成交改为每股固定偏移 0.10 元。

ALTER TABLE strategy_paper_account
  ADD COLUMN price_offset numeric(18,6);
UPDATE strategy_paper_account
   SET price_offset = 0.10,
       slippage_bp = 0;
ALTER TABLE strategy_paper_account
  ALTER COLUMN price_offset SET DEFAULT 0.10,
  ALTER COLUMN price_offset SET NOT NULL,
  ALTER COLUMN slippage_bp SET DEFAULT 0,
  ADD CONSTRAINT strategy_paper_account_price_offset_check
  CHECK (price_offset >= 0 AND price_offset <= 100);

ALTER TABLE strategy_paper_trade
  ADD COLUMN price_offset numeric(18,6);
UPDATE strategy_paper_trade
   SET price_offset = 0.10,
       slippage_bp = 0;
ALTER TABLE strategy_paper_trade
  ALTER COLUMN price_offset SET DEFAULT 0.10,
  ALTER COLUMN price_offset SET NOT NULL,
  ALTER COLUMN slippage_bp SET DEFAULT 0;

COMMENT ON COLUMN strategy_paper_account.price_offset IS '每股固定成交偏移，单位元；买入加、卖出减';
COMMENT ON COLUMN strategy_paper_account.slippage_bp IS '退役兼容字段；固定为0，不再参与成交计算';
COMMENT ON COLUMN strategy_paper_trade.price_offset IS '本笔每股固定成交偏移，单位元';
COMMENT ON COLUMN strategy_paper_trade.slippage_bp IS '退役兼容字段；固定为0，不再参与成交计算';

CREATE TEMP TABLE strategy_paper_position_rebuild (
  instrument_id bigint PRIMARY KEY,
  quantity      numeric NOT NULL,
  cost_price    numeric(18,6) NOT NULL,
  opened_at     date NOT NULL
) ON COMMIT DROP;

DO $rebuild$
DECLARE
  trade_row record;
  old_quantity numeric;
  old_cost numeric(18,6);
  new_quantity numeric;
  trade_price numeric(18,6);
  trade_amount numeric(18,2);
  trade_realized numeric(18,2);
  account_cash numeric(18,2);
  account_realized numeric(18,2) := 0;
BEGIN
  SELECT initial_cash INTO account_cash
    FROM strategy_paper_account WHERE singleton = true FOR UPDATE;

  FOR trade_row IN
    SELECT id, instrument_id, trade_date, side, quantity, open_price
      FROM strategy_paper_trade
     ORDER BY trade_date, id
  LOOP
    trade_price := round(trade_row.open_price + CASE trade_row.side WHEN 'buy' THEN 0.10 ELSE -0.10 END, 6);
    IF trade_price <= 0 THEN
      RAISE EXCEPTION '模拟成交 % 固定偏移后的价格必须大于0', trade_row.id;
    END IF;
    trade_amount := round(trade_row.quantity * trade_price, 2);
    SELECT quantity, cost_price INTO old_quantity, old_cost
      FROM strategy_paper_position_rebuild
     WHERE instrument_id = trade_row.instrument_id;

    IF trade_row.side = 'buy' THEN
      trade_realized := NULL;
      account_cash := round(account_cash - trade_amount, 2);
      IF old_quantity IS NULL THEN
        INSERT INTO strategy_paper_position_rebuild (instrument_id, quantity, cost_price, opened_at)
        VALUES (trade_row.instrument_id, trade_row.quantity, trade_price, trade_row.trade_date);
      ELSE
        new_quantity := old_quantity + trade_row.quantity;
        UPDATE strategy_paper_position_rebuild
           SET quantity = new_quantity,
               cost_price = round((old_quantity * old_cost + trade_amount) / new_quantity, 6)
         WHERE instrument_id = trade_row.instrument_id;
      END IF;
      old_cost := NULL;
    ELSE
      IF old_quantity IS NULL OR old_quantity <> trade_row.quantity THEN
        RAISE EXCEPTION '模拟卖出成交 % 缺少可重建的完整持仓', trade_row.id;
      END IF;
      trade_realized := round(trade_row.quantity * (trade_price - old_cost), 2);
      account_cash := round(account_cash + trade_amount, 2);
      account_realized := round(account_realized + trade_realized, 2);
      DELETE FROM strategy_paper_position_rebuild WHERE instrument_id = trade_row.instrument_id;
    END IF;

    UPDATE strategy_paper_trade
       SET price_offset = 0.10,
           slippage_bp = 0,
           price = trade_price,
           amount = trade_amount,
           cost_price_before = old_cost,
           realized_pnl = trade_realized,
           cash_after = account_cash
     WHERE id = trade_row.id;
    old_quantity := NULL;
    old_cost := NULL;
  END LOOP;

  DELETE FROM strategy_paper_position;
  INSERT INTO strategy_paper_position (instrument_id, quantity, cost_price, opened_at)
  SELECT instrument_id, quantity, cost_price, opened_at
    FROM strategy_paper_position_rebuild;
  UPDATE strategy_paper_account
     SET cash = account_cash,
         realized_pnl = account_realized,
         price_offset = 0.10,
         slippage_bp = 0,
         updated_at = now()
   WHERE singleton = true;
END
$rebuild$;

WITH current_prompt AS (
  SELECT prompt.id AS prompt_id,
         prompt.current_revision_id AS base_revision_id,
         revision.content
    FROM job_prompt prompt
    JOIN job_prompt_revision revision ON revision.id = prompt.current_revision_id
   WHERE prompt.code = 'daily_plan_flow'
     AND prompt.status = 'active'
     AND revision.content LIKE '%0.2bp 即 0.002%%'
), prepared AS (
  SELECT prompt_id,
         base_revision_id,
         replace(
           content,
           '买入价=`open × (1 + 0.2/10000)`，卖出价=`open × (1 - 0.2/10000)`；0.2bp 即 0.002%，不计手续费。',
           '买入价=`open + 0.10`，卖出价=`open - 0.10`；偏移为每股固定 0.10 元，不计手续费。'
         ) AS content
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
         '策略模拟成交改为每股固定偏移0.10元'
    FROM prepared
  RETURNING prompt_id, id
)
UPDATE job_prompt prompt
   SET current_revision_id = inserted.id, updated_at = now()
  FROM inserted
 WHERE prompt.id = inserted.prompt_id;

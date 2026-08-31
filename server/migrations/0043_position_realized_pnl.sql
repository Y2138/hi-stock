-- 0043_position_realized_pnl.sql：以历史基线 + 卖出事件维护累计已实现盈亏，不恢复账户快照链路。

ALTER TABLE portfolio_position_change
  ADD COLUMN cost_price_before numeric,
  ADD COLUMN realized_pnl numeric;

COMMENT ON COLUMN portfolio_position_change.cost_price_before IS
  '卖出事件发生前的持仓成本；无法从历史事件可靠还原时为空';
COMMENT ON COLUMN portfolio_position_change.realized_pnl IS
  '本笔卖出已实现毛盈亏（数量×成交价与卖出前成本之差），未计手续费和税费';

CREATE TABLE portfolio_realized_pnl_baseline (
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  amount             numeric NOT NULL,
  through_created_at timestamptz NOT NULL,
  source             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE portfolio_realized_pnl_baseline IS
  '累计已实现盈亏的一次性历史基线；运行时增量只读取其后卖出事件';

INSERT INTO portfolio_realized_pnl_baseline (singleton, amount, through_created_at, source)
SELECT true,
       COALESCE((SELECT closed_pnl FROM portfolio_account_state WHERE id = true), 0),
       COALESCE((SELECT updated_at FROM portfolio_account_state WHERE id = true), '-infinity'::timestamptz),
       CASE WHEN EXISTS (SELECT 1 FROM portfolio_account_state WHERE id = true)
            THEN 'portfolio_account_state.closed_pnl'
            ELSE 'empty'
       END;

CREATE TEMP TABLE position_replay_state (
  instrument_id bigint PRIMARY KEY,
  quantity      numeric,
  cost_price    numeric,
  known         boolean NOT NULL DEFAULT false,
  invalidated   boolean NOT NULL DEFAULT false
) ON COMMIT DROP;

DO $$
DECLARE
  event_row record;
  state_row record;
  next_quantity numeric;
BEGIN
  FOR event_row IN
    SELECT id, instrument_id, kind, quantity, price
      FROM portfolio_position_change
     ORDER BY id
  LOOP
    INSERT INTO position_replay_state (instrument_id)
    VALUES (event_row.instrument_id)
    ON CONFLICT (instrument_id) DO NOTHING;

    SELECT * INTO state_row
      FROM position_replay_state
     WHERE instrument_id = event_row.instrument_id;

    IF event_row.kind = 'note' THEN
      IF NOT state_row.known AND event_row.quantity > 0 AND event_row.price IS NOT NULL THEN
        UPDATE position_replay_state
           SET quantity = event_row.quantity, cost_price = event_row.price,
               known = true, invalidated = false
         WHERE instrument_id = event_row.instrument_id;
      END IF;
    ELSIF event_row.kind = 'buy' THEN
      IF event_row.quantity > 0 AND event_row.price IS NOT NULL THEN
        IF state_row.known AND state_row.quantity > 0 THEN
          UPDATE position_replay_state
             SET cost_price = (quantity * cost_price + event_row.quantity * event_row.price)
                              / (quantity + event_row.quantity),
                 quantity = quantity + event_row.quantity
           WHERE instrument_id = event_row.instrument_id;
        ELSIF state_row.known OR NOT state_row.invalidated THEN
          UPDATE position_replay_state
             SET quantity = event_row.quantity, cost_price = event_row.price,
                 known = true, invalidated = false
           WHERE instrument_id = event_row.instrument_id;
        END IF;
      END IF;
    ELSIF event_row.kind = 'sell' THEN
      IF state_row.known
         AND state_row.quantity > 0
         AND state_row.cost_price IS NOT NULL
         AND event_row.quantity > 0
         AND event_row.price IS NOT NULL
         AND event_row.quantity <= state_row.quantity THEN
        UPDATE portfolio_position_change
           SET cost_price_before = state_row.cost_price,
               realized_pnl = round(event_row.quantity * (event_row.price - state_row.cost_price), 2)
         WHERE id = event_row.id;

        next_quantity := state_row.quantity - event_row.quantity;
        UPDATE position_replay_state
           SET quantity = next_quantity,
               cost_price = CASE WHEN next_quantity = 0 THEN NULL ELSE state_row.cost_price END,
               known = true, invalidated = false
         WHERE instrument_id = event_row.instrument_id;
      ELSE
        UPDATE position_replay_state
           SET quantity = NULL, cost_price = NULL, known = false, invalidated = true
         WHERE instrument_id = event_row.instrument_id;
      END IF;
    ELSIF event_row.kind = 'adjust' THEN
      IF event_row.quantity > 0 AND event_row.price IS NOT NULL THEN
        UPDATE position_replay_state
           SET quantity = event_row.quantity, cost_price = event_row.price,
               known = true, invalidated = false
         WHERE instrument_id = event_row.instrument_id;
      ELSIF state_row.known THEN
        UPDATE position_replay_state
           SET quantity = COALESCE(event_row.quantity, quantity),
               cost_price = COALESCE(event_row.price, cost_price)
         WHERE instrument_id = event_row.instrument_id;
      END IF;
    END IF;
  END LOOP;
END $$;

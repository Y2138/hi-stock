-- 0198_策略信号写入路由.sql
-- 单策略写入链路切换开关（主管定：一次只切一条链路，先只开 events_only）。
--
-- 三档语义：
--   legacy      现状：事件表不写，池与通知由旧链路写。
--   events_only 事件、观察计划、outcome 写新表；池与通知完全不动，仍由旧链路唯一写入。
--   full        池与通知也交给新链路。本轮不开放，需另一次验收并先补证据字段。
--
-- 切换与回滚都只是一条 UPDATE：改 mode 并把 generation + 1，不需要重启进程。
-- 没有记录的策略一律按 legacy 处理，不隐式改变任何现有行为。

CREATE TABLE signal_live_route (
  strategy_code text PRIMARY KEY,
  mode          text NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'events_only', 'full')),
  generation    bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
  reason        text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE signal_live_route IS '单策略写入链路开关；一次只切一条链路，切换与回滚都是 UPDATE，不重启';
COMMENT ON COLUMN signal_live_route.strategy_code IS '策略编码；没有记录的策略按 legacy 处理';
COMMENT ON COLUMN signal_live_route.mode IS 'legacy=只走旧链路，events_only=事件/计划/结果写新表但池通知不动，full=池通知也给新链路（本轮不开放）';
COMMENT ON COLUMN signal_live_route.generation IS '路由代次；每次切换或回滚加 1，用于确认本轮冻结的是哪一版开关';
COMMENT ON COLUMN signal_live_route.reason IS '切换原因，回滚时写清触发了什么';
COMMENT ON COLUMN signal_live_route.updated_at IS '最近一次切换时间';

-- 试点策略先显式建一行 legacy，切换前能在库里看到它，不用靠「查不到就默认」猜。
INSERT INTO signal_live_route (strategy_code, mode, reason)
VALUES ('two_year_reversal', 'legacy', '切换前默认：新链路尚未开启写入')
ON CONFLICT (strategy_code) DO NOTHING;

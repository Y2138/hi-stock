-- 关注池特别关注：用户在池页面逐只标记的保留级关注。
-- 每日计划对账不清退特别关注标的的关注条目与池成员身份；关注条目按交易日续期
-- 并注明保留原因，仅用户手动取消后恢复常规对账。

ALTER TABLE pool_membership ADD COLUMN special_attention boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pool_membership.special_attention IS '用户手动标记的特别关注；为真时每日计划对账不清退关注条目与成员身份，仅用户手动取消';

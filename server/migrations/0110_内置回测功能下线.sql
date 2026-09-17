-- 0110_内置回测功能下线.sql：回测执行完全迁出系统，改为仓库内本地脚本；系统只保留策略正文与任务。
-- server/backtest 的纯计算内核（contracts/input/short-rules）保留供本地脚本复用，
-- 与回测运行相关的台账、输入冻结、事件与净值表全部删除。

DROP TABLE backtest_event;
DROP TABLE backtest_equity_daily;
DROP TABLE backtest_run_comparison;
DROP TABLE backtest_run_source;
DROP TABLE backtest_run;
DROP TABLE backtest_input_chunk;
DROP TABLE backtest_input_set;

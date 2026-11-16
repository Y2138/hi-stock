-- 铜宏观因子可获得时间口径：只替换《铜左侧启动策略》「三、数据边界」里的滞后描述，其余正文不动。
-- 对应同步实现：server/datasource/copper-macro-service.ts。
-- 新期次按上游实际发布期次与首次观测时间写入点时值；仅首次建库/历史缺口使用「月末+45 天」
-- 合成发布时间并标记 synthetic_initial_published_at；历史修订按实际抓取时间记录。

WITH current AS (
  SELECT id,
         replace(
           content,
           'OECD CLI按报告月末后45日作为保守可获得时间，修订值按新发布时间写入。',
           'OECD CLI 以上游实际发布的期次为准：新期次在上游可获取后，按首次观测时间写入点时值；仅首次建库与历史缺口使用「报告月末后 45 日」的保守可获得时间，并按 `synthetic_initial_published_at` 标记；历史修订按实际抓取时间记录。'
         ) AS content
    FROM strategy_document
   WHERE code='copper_left_launch_strategy'
), updated AS (
  SELECT id,content,encode(sha256(convert_to(content,'UTF8')),'hex') AS sha256 FROM current
)
UPDATE strategy_document document
   SET content=updated.content,sha256=updated.sha256,updated_at=now()
  FROM updated WHERE document.id=updated.id;

// 合成 881 一级行业等权指数：填补真实 881 序列（供应商最早 2021-09-13）之前的行业环境数据。
//
// 背景：扶摇指数 K 线接口对 881 板块最早只到 2021-09-13（实测 2016/2018/2020 三段请求均返回空），
// 长窗训练（2016-2021）的行业动量闸门、熔断恢复与综合指数因子缺环境序列。
//
// 方法（研究近似，非官方指数复刻）：
//   1. 取 hithink 881 一级行业的当前成分（membership effective_to IS NULL，点时未证）；
//   2. 成分个股前复权日线（volume>0、adjustment='forward'）的 open/high/low/close 相对前收比率，
//      剔除复权链坏行（|close_ret|>35% 或 high/low 比率非正）；
//   3. 行业日序列 = 成分等权平均；指数自 1000 起累乘（等权，与真实 881 自由流通加权口径不同）；
//      open/high/low 按同窗平均比率累乘并钳制为合法 OHLC；行业某日无有效成分收益按零收益补行；
//   4. 落库为独立合成板块：code 881xxx.SY、kind='board'，只登记 market_instrument 与 market_bar，
//      不登记 market_board（与业务板块查询天然隔离），不触碰真实 881 hithink 行；重跑按主键 upsert 幂等。
//
// 校准（--calibrate）：重叠期（2021-09-13 后）逐板块比较合成与真实 881 的日收益相关系数，
// 输出全体中位数与最差值，作为合成方法可信度的证据。
//
// 用法：
//   npm run market:industry-synthesize -- --dry-run        # 只统计与校准，不写库
//   npm run market:industry-synthesize                      # 合成 2015-01-01 → 今天
//   npm run market:industry-synthesize -- --calibrate       # 写库并输出重叠期校准报告
import { loadConfig } from "../server/config.js";
import { closePool, getPool } from "../server/db/client.js";

interface ParsedArgs { flags: Map<string, string[]> }
function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) { flags.set(arg.slice(2, eq), [arg.slice(eq + 1)]); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(key, [next]); i += 1; }
    else flags.set(key, ["true"]);
  }
  return { flags };
}
function one(flags: Map<string, string[]>, key: string): string | undefined {
  return flags.get(key)?.[0];
}

interface AggRow {
  board_code: string;
  bar_date: string;
  close_ret: number;
  open_ret: number | null;
  high_ret: number | null;
  low_ret: number | null;
}

interface SyntheticBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < 10) return null;
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const dryRun = one(parsed.flags, "dry-run") !== undefined;
  const calibrate = one(parsed.flags, "calibrate") !== undefined;
  const start = one(parsed.flags, "start") ?? "2015-01-01";
  const end = one(parsed.flags, "end") ?? new Date().toISOString().slice(0, 10);

  const { databaseUrl } = loadConfig();
  const pool = getPool(databaseUrl);
  try {
    // 1) 当前成分 + 名称
    const boards = await pool.query<{ board_code: string; board_name: string; members: number }>(
      `SELECT i.code AS board_code, i.name AS board_name, count(*)::int AS members
       FROM market_board b
       JOIN market_instrument i ON i.id = b.instrument_id
       JOIN market_board_membership m ON m.board_instrument_id = b.instrument_id AND m.effective_to IS NULL
       JOIN market_instrument mi ON mi.id = m.member_instrument_id
       WHERE b.active AND b.source='hithink' AND b.board_type='industry' AND i.code LIKE '881%'
         AND mi.code ~ '^[0-9]{6}[.](SH|SZ)$'
       GROUP BY i.code, i.name HAVING count(*) >= 5 ORDER BY i.code`,
    );
    console.log(`881 一级行业 ${boards.rows.length} 个（成分 ≥5 只）`);
    if (!boards.rows.length) throw new Error("没有可用行业成分，先执行板块目录与成分同步");

    // 2) SQL 聚合成分等权日比率
    const agg = await pool.query<AggRow>(
      `WITH members AS (
         SELECT b.instrument_id AS board_id, m.member_instrument_id
         FROM market_board b
         JOIN market_board_membership m ON m.board_instrument_id = b.instrument_id AND m.effective_to IS NULL
         JOIN market_instrument i ON i.id = b.instrument_id
         WHERE b.active AND b.source='hithink' AND b.board_type='industry' AND i.code LIKE '881%'
       ), stock_ret AS (
         SELECT b.instrument_id, b.bar_date,
                b.close / NULLIF(lag(b.close) OVER w, 0) - 1 AS close_ret,
                b.open  / NULLIF(lag(b.close) OVER w, 0) - 1 AS open_ret,
                b.high  / NULLIF(lag(b.close) OVER w, 0) - 1 AS high_ret,
                b.low   / NULLIF(lag(b.close) OVER w, 0) - 1 AS low_ret
         FROM market_bar b
         WHERE b.freq='day' AND b.volume > 0 AND b.adjustment='forward' AND b.bar_date >= $1 AND b.bar_date <= $2
           AND b.instrument_id IN (SELECT member_instrument_id FROM members)
         WINDOW w AS (PARTITION BY b.instrument_id ORDER BY b.bar_date)
       )
       SELECT m2.board_code, s.bar_date::text AS bar_date,
              avg(s.close_ret)::float8 AS close_ret,
              avg(s.open_ret)::float8 AS open_ret,
              avg(s.high_ret)::float8 AS high_ret,
              avg(s.low_ret)::float8 AS low_ret
       FROM stock_ret s
       JOIN (SELECT i2.code AS board_code, mm.member_instrument_id
             FROM market_board b2
             JOIN market_instrument i2 ON i2.id = b2.instrument_id
             JOIN market_board_membership mm ON mm.board_instrument_id = b2.instrument_id AND mm.effective_to IS NULL
             WHERE b2.active AND b2.source='hithink' AND b2.board_type='industry' AND i2.code LIKE '881%'
               AND mm.member_instrument_id IN (SELECT id FROM market_instrument WHERE code ~ '^[0-9]{6}[.](SH|SZ)$')) m2
         ON m2.member_instrument_id = s.instrument_id
       WHERE s.close_ret IS NOT NULL AND s.close_ret BETWEEN -0.35 AND 0.35
         AND (s.high_ret IS NULL OR s.high_ret BETWEEN -0.5 AND 1)
         AND (s.low_ret IS NULL OR s.low_ret BETWEEN -0.5 AND 1)
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [start, end],
    );
    console.log(`成分有效聚合行 ${agg.rows.length}（${start} ~ ${end}）`);

    // 3) 逐行业累乘合成 OHLC；全市场日历对齐，行业缺日按零收益补行
    const calendar = [...new Set(agg.rows.map(row => row.bar_date))].sort();
    const byBoard = new Map<string, AggRow[]>();
    for (const row of agg.rows) {
      let list = byBoard.get(row.board_code);
      if (!list) { list = []; byBoard.set(row.board_code, list); }
      list.push(row);
    }
    const synthesized = new Map<string, SyntheticBar[]>();
    for (const board of boards.rows) {
      const code = board.board_code;
      const rows = byBoard.get(code) ?? [];
      if (!rows.length) continue;
      // 序列统一从全局日历首日开始：首个有效聚合日之前按零收益补平线，
      // 保证每个板块在完整日历上逐日有行（回测环境输入对板块缺行零容忍）。
      const firstDate = calendar[0]!;
      const rets = new Map(rows.map(row => [row.bar_date, row]));
      const bars: SyntheticBar[] = [];
      let index = 1000;
      let started = false;
      for (const date of calendar) {
        if (date < firstDate) continue;
        const ret = rets.get(date);
        if (!started) { started = true; index = 1000; }
        const prev = index;
        const closeRet = ret?.close_ret ?? 0;
        const open = ret?.open_ret != null ? prev * (1 + ret.open_ret) : prev;
        const highHint = ret?.high_ret != null ? prev * (1 + ret.high_ret) : prev;
        const lowHint = ret?.low_ret != null ? prev * (1 + ret.low_ret) : prev;
        const close = prev * (1 + closeRet);
        index = close;
        const high = Math.max(open, close, highHint);
        const low = Math.max(0.01 * prev, Math.min(open, close, lowHint));
        bars.push({ date, open, high, low, close });
      }
      synthesized.set(code, bars);
    }
    const totalRows = [...synthesized.values()].reduce((sum, bars) => sum + bars.length, 0);
    const firstAll = calendar[0] ?? "-";
    const lastAll = calendar.at(-1) ?? "-";
    console.log(`合成 ${synthesized.size} 个行业序列，共 ${totalRows} 根（${firstAll} ~ ${lastAll}）`);

    // 4) 校准：重叠期真实 881 vs 合成日收益相关
    if (calibrate) {
      const real = await pool.query<{ code: string; date: string; ret: number }>(
        `SELECT i.code, b.bar_date::text AS date, b.close / NULLIF(lag(b.close) OVER w, 0) - 1 AS ret
         FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
         JOIN market_board bd ON bd.instrument_id = i.id
         WHERE bd.active AND bd.source='hithink' AND bd.board_type='industry' AND i.code LIKE '881%' AND b.freq='day'
         WINDOW w AS (PARTITION BY b.instrument_id ORDER BY b.bar_date)`,
      );
      const realByBoard = new Map<string, Map<string, number>>();
      for (const row of real.rows) {
        const ret = Number(row.ret);
        if (!Number.isFinite(ret)) continue;
        let m = realByBoard.get(row.code);
        if (!m) { m = new Map(); realByBoard.set(row.code, m); }
        m.set(row.date, ret);
      }
      const correlations: number[] = [];
      const perBoard: Array<{ board: string; corr: number | null; n: number }> = [];
      for (const [boardCode, bars] of synthesized) {
        const realMap = realByBoard.get(boardCode);
        if (!realMap) continue;
        const xs: number[] = [];
        const ys: number[] = [];
        let prev: number | null = null;
        for (const bar of bars) {
          const r = realMap.get(bar.date);
          if (r === undefined) { prev = null; continue; }
          if (prev !== null) { xs.push(bar.close / prev - 1); ys.push(r); }
          prev = bar.close;
        }
        const corr = pearson(xs, ys);
        if (corr !== null) correlations.push(corr);
        perBoard.push({ board: boardCode, corr, n: xs.length });
      }
      perBoard.sort((a, b) => (a.corr ?? 9) - (b.corr ?? 9));
      console.log("最差10行业:", perBoard.slice(0, 10).map(e => `${e.board}(r=${e.corr?.toFixed(2)},n=${e.n})`).join(" "));
      if (correlations.length) {
        correlations.sort((a, b) => a - b);
        const median = correlations[correlations.length >> 1]!;
        console.log(`校准：重叠期 ${correlations.length} 个行业日收益相关系数 中位 ${median.toFixed(3)}，最差 ${correlations[0]!.toFixed(3)}，最好 ${correlations.at(-1)!.toFixed(3)}`);
      } else {
        console.log("校准：没有可比较的重叠期数据（真实881尚未入库？）");
      }
    }

    if (dryRun) { console.log("dry-run：不写库。"); return; }

    // 5) 落库：合成仪器 + 合成板块 + upsert 日线
    let written = 0;
    for (const board of boards.rows) {
      const bars = synthesized.get(board.board_code);
      if (!bars?.length) continue;
      const syntheticCode = board.board_code.replace(/\.TI$/, ".SY");
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, 'board')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [syntheticCode, `${board.board_name}（等权合成）`],
      );
      const instrumentId = instrument.rows[0]!.id;
      // 不登记 market_board：合成板块只作为研究输入存在，业务板块查询（列表/成分/结构）走 market_board，
      // 不加 source 过滤也能天然隔离；回测输入侧按 881%.SY 代码模式直查 market_instrument。
      const BATCH = 2000;
      for (let offset = 0; offset < bars.length; offset += BATCH) {
        const chunk = bars.slice(offset, offset + BATCH);
        const values: unknown[] = [];
        const placeholders = chunk.map((bar, index) => {
          const base = index * 7;
          values.push(instrumentId, bar.date, bar.open, bar.high, bar.low, bar.close, "synthetic");
          return `($${base + 1}, $${base + 2}::date, '1970-01-01 00:00:00+00'::timestamptz, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 'day', 'none', $${base + 7})`;
        }).join(", ");
        await pool.query(
          `INSERT INTO market_bar (instrument_id, bar_date, bar_time, open, high, low, close, freq, adjustment, channel)
           VALUES ${placeholders}
           ON CONFLICT (instrument_id, freq, bar_date, bar_time) DO UPDATE
             SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
                 adjustment = EXCLUDED.adjustment, channel = EXCLUDED.channel, fetched_at = now()`,
          values,
        );
        written += chunk.length;
      }
    }
    console.log(`写入完成：${written} 根合成日线。`);
  } finally {
    await closePool();
  }
}

await main();

// 前复权计算内核：从原始成交价与复权事件生成一致的前复权序列。
//
// 背景：扶摇行情接口的 adjust=forward 与全市场 dump 的 qfq 是两套算法，且生产库中
// 已存的前复权值按各 bar 拉取时点计算，存在锚点漂移（后续分红不会改写更早的 bar）。
// 因此前复权必须由本仓库统一计算，锚点显式传入，保证同一批数据只有一套口径。
//
// 口径（经与生产库 565 只标的 16.4 万行逐行核对，96% 精确复现，剩余差异为生产漂移）：
//   把锚点 A 之前（含当日）的除权事件按 ex_date 升序记为 e_1..e_n；
//   对交易日 d，取第一个满足 e_k.ex_date > d 的 k（即 d 之后的事件），令前缀股本积
//     P_0 = 1，P_j = Π_{i<j} (1 + e_i.bonus + e_i.rights_ratio)
//   则 forward(d) = (raw(d) × P_k − Σ_{i≥k} cash_i × P_i) / P_n
//   其中 cash_i = e_i.dividend − e_i.rights_ratio × e_i.rights_price。
// 直观含义：现金分红与配股缴款，先按其之后发生的送转等比放大，再从原价中扣除，最后整体除以全部送转股本因子。

export interface AdjustmentEvent {
  /** 除权除息日 YYYY-MM-DD */
  ex_date: string;
  /** 每股现金分红 */
  dividend: number;
  /** 每股送转比例（0.3 = 每 10 股送转 3 股） */
  bonus: number;
  /** 每股配股比例 */
  rights_ratio: number;
  /** 配股价 */
  rights_price: number;
}

export interface RawPoint {
  date: string;
  close: number;
}

/**
 * 计算单只标的在给定锚点下的前复权收盘价。
 *
 * @param raw    原始成交价序列（顺序不限）
 * @param events 复权事件全集（含锚点之后的事件；本函数按锚点过滤）
 * @param anchor 锚点交易日 YYYY-MM-DD
 * @returns date → 前复权收盘价
 *
 * 锚点语义：锚点当日收盘价等于原始收盘价，更早历史价按锚点前已发生的除权向下调整。
 * 传入不同锚点会得到不同的前复权序列——这是前复权的固有性质，调用方必须固定锚点。
 */
export function computeForwardCloses(
  raw: RawPoint[],
  events: AdjustmentEvent[],
  anchor: string,
): Map<string, number> {
  const evs = events
    .filter((event) => event.ex_date <= anchor)
    .sort((a, b) => (a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0));
  const n = evs.length;
  // 前缀股本积：prefix[j] = Π_{i<j} (1 + bonus_i + rights_i)
  const prefix = new Array<number>(n + 1);
  prefix[0] = 1;
  for (let i = 0; i < n; i += 1) {
    const event = evs[i]!;
    prefix[i + 1] = prefix[i]! * (1 + event.bonus + event.rights_ratio);
  }
  // 后缀现金流：suffix[j] = Σ_{i≥j} cash_i × prefix[i]
  const suffix = new Array<number>(n + 1);
  suffix[n] = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const event = evs[i]!;
    const cash = event.dividend - event.rights_ratio * event.rights_price;
    suffix[i] = suffix[i + 1]! + cash * prefix[i]!;
  }
  const totalFactor = prefix[n]!;

  const points = [...raw].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const result = new Map<string, number>();
  let k = 0; // 第一个 ex_date > 当前日期的下标的候选；points 升序时单调不减
  for (const point of points) {
    while (k < n && evs[k]!.ex_date <= point.date) k += 1;
    const adjusted = (point.close * prefix[k]! - suffix[k]!) / totalFactor;
    result.set(point.date, Number.isFinite(adjusted) ? Math.round(adjusted * 1e6) / 1e6 : point.close);
  }
  return result;
}

/**
 * 计算「交易所前收盘」序列：上一交易日原始收盘价，若当日除权则按公司行为折算为除权参考价。
 * 这是涨跌停与真实涨跌幅的官方基准，不能用当日 close/prevClose 比例的简单套用代替。
 *
 * @param raw    原始成交价序列（按 date 升序，close 为原始收盘）
 * @param events 复权事件全集（按 ex_date 匹配当日事件）
 * @returns date → 交易所前收盘；首日无前收盘时为 null
 */
export function computeOfficialPrevCloses(
  raw: RawPoint[],
  events: AdjustmentEvent[],
): Map<string, number | null> {
  const points = [...raw].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byDate = new Map<string, AdjustmentEvent[]>();
  for (const event of events) {
    const list = byDate.get(event.ex_date) ?? [];
    list.push(event);
    byDate.set(event.ex_date, list);
  }
  const result = new Map<string, number | null>();
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    if (i === 0) {
      result.set(point.date, null);
      continue;
    }
    const prevRaw = points[i - 1]!.close;
    const sameDay = byDate.get(point.date) ?? [];
    if (sameDay.length === 0) {
      result.set(point.date, prevRaw);
      continue;
    }
    const cash = sameDay.reduce((sum, e) => sum + e.dividend - e.rights_ratio * e.rights_price, 0);
    const factor = sameDay.reduce((product, e) => product * (1 + e.bonus + e.rights_ratio), 1);
    const reference = (prevRaw - cash) / factor;
    result.set(point.date, Number.isFinite(reference) ? Math.round(reference * 1e6) / 1e6 : prevRaw);
  }
  return result;
}



import { canonicalJson, type StandardBacktestPlan, type StandardDay, type StandardDayResult, type StandardEquity } from "./contracts.js";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const notional = (price: number, quantity: number) => Number((BigInt(Math.round(price * 1_000_000)) * BigInt(quantity) + 5000n) / 10000n);
/** 从上次结算和成交独立核对现金/成本/持股，不能信任工作器自报收益。 */
export function verifySettlement(plan: StandardBacktestPlan, day: StandardDay, result: StandardDayResult, previous: StandardEquity | null, lastSeq: number, priorRealized: Record<string,number> = {}): Record<string,number> {
  const fail = (): never => { throw new Error("LEDGER_MISMATCH"); };
  if (!result || Buffer.byteLength(canonicalJson(result)) > 2 * 1024 * 1024 || !Array.isArray(result.events) || result.events.length > 1000) fail();
  if (day.date < plan.start) { if (result.equity !== null || result.events.length) fail(); return {}; }
  let cash = previous?.cash_cents ?? Math.round(plan.initial_cash * 100);
  let fees = previous?.fees_cents ?? 0;
  const realized={...priorRealized};
  const closing=new Map<string,number>();
  const holdings = new Map((previous?.positions ?? []).map(p => [p.code, { quantity: p.quantity, cost: p.cost_cents }]));
  for (const event of result.events) {
    if (event.seq !== ++lastSeq || event.date !== day.date || typeof event.reason !== "string" || event.reason.length > 300 || !["signal","suppressed","order","rejected","expired","fill","closed","risk_trigger","risk_recover"].includes(event.type) || (event.code !== null && !plan.codes.includes(event.code))) fail();
    if(event.type==='closed'){
      if(!event.code || !closing.has(event.code) || event.details.pnl_cents!==closing.get(event.code))fail();
      closing.delete(event.code!);delete realized[event.code!];continue;
    }
    if (event.type !== "fill") continue;
    const d = event.details;
    if (!event.code || !integer(d.quantity) || d.quantity === 0 || d.quantity % 100 || !integer(d.gross_cents) || typeof d.price !== "number" || d.price <= 0 || !Number.isSafeInteger(Math.round(d.price * 1_000_000))) fail();
    const quantity = d.quantity as number, gross = d.gross_cents as number;
    if (notional(d.price as number, quantity) !== gross || !["buy","sell"].includes(String(d.side))) fail();
    const commission = Math.max(Math.round(plan.costs.minimum_commission * 100), Math.round(gross * (plan.costs.commission_bps / 10000)));
    const tax = d.side === "sell" ? Math.round(gross * (plan.costs.sell_tax_bps / 10000)) : 0;
    if (d.commission_cents !== commission || d.tax_cents !== tax || d.fees_cents !== commission + tax) fail();
    fees += commission + tax;
    const code = event.code!;
    if (d.side === "buy") {
      if (holdings.has(code)) fail();
      realized[code]=0; holdings.set(code, {quantity, cost: gross + commission + tax}); cash -= gross + commission + tax;
    } else {
      const p = holdings.get(code);
      if (!p || quantity > p.quantity || !integer(d.allocated_cost_cents) || d.allocated_cost_cents > p.cost) fail();
      const position = p!;
      const expectedCost = Number((BigInt(position.cost) * BigInt(quantity) + BigInt(position.quantity) / 2n) / BigInt(position.quantity));
      if (d.allocated_cost_cents !== expectedCost) fail();
      realized[code]=(realized[code]??0)+gross-commission-tax-expectedCost;
      position.quantity -= quantity; position.cost -= expectedCost;
      if (!position.quantity) { if (position.cost !== 0) fail(); holdings.delete(code);closing.set(code,realized[code]!); }
      cash += gross - commission - tax;
    }
    if (!integer(cash) || !integer(fees)) fail();
  }
  if(closing.size)fail();
  const eq = result.equity;
  if (!eq || eq.date !== day.date || eq.cash_cents !== cash || eq.fees_cents !== fees || !Array.isArray(eq.positions) || eq.positions.length !== holdings.size) fail();
  let market = 0;
  const seen = new Set<string>();
  for (const p of eq!.positions) {
    const held = holdings.get(p.code), bar = day.bars.find(b => b.code === p.code);
    if (!held || seen.has(p.code)) fail();
    seen.add(p.code);
    if (bar) {
      if (p.quantity !== held!.quantity || p.cost_cents !== held!.cost || p.close !== bar.close) fail();
    } else {
      // 停牌估值：收盘价与持仓数量必须与上一结算完全一致，不得伪造新价。
      const prior = previous?.positions.find(q => q.code === p.code);
      if (!prior || p.close !== prior.close || p.quantity !== held!.quantity || p.cost_cents !== held!.cost) fail();
    }
    market += notional(p.close, p.quantity);
  }
  const equity = cash + market;
  const prior = previous?.equity_cents ?? Math.round(plan.initial_cash * 100);
  if (!integer(market) || !integer(equity) || eq!.market_value_cents !== market || eq!.equity_cents !== equity || eq!.daily_return !== (prior === 0 ? 0 : equity / prior - 1) || !Number.isFinite(eq!.drawdown) || eq!.drawdown < 0 || eq!.drawdown > 1 || typeof eq!.paused !== "boolean") fail();
  return realized;
}

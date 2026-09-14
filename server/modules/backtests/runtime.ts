import crypto from "node:crypto";
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { contentHash, canonicalJson, STANDARD_ENGINE_VERSION, validateStandardPlan, type StandardDay, type StandardDayResult, type StandardEvent, type StandardEquity } from "../../backtest/contracts.js";
import { standardBuildHash } from "../../backtest/build.js";
import { verifySettlement } from "../../backtest/settlement.js";
import { StartStandardBacktestSchema, validateRuntimeInput, type StartStandardBacktestInput, type StandardRunStatus, type StandardPage, type StandardComparison } from "../../backtest/runtime-contract.js";
import type { FrozenStandardInput } from "./service.js";
export function isStandardBacktestEnabled(): boolean { return ["true", "1", "on"].includes((process.env.STANDARD_BACKTEST_ENABLED ?? "false").toLowerCase()); }
const validId = (id: string) => { if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error("回测编号非法"); };
const active = ["queued", "preparing", "running"];
const STATUS_SELECT = `r.id::text,r.name,r.engine_type,r.execution_status,r.phase,r.progress,r.quality_status,r.evidence_status,r.replay_status,
 r.plan_sha256,r.execution_plan,r.metrics_json,r.data_gaps,r.error_message,r.session_id::text,
 r.started_at,r.finished_at,r.cancel_requested_at,s.sha256 AS input_sha256`;

export async function startStandardBacktest(pool: TransactionDb, sessionId: string, raw: unknown): Promise<StandardRunStatus> {
  if (!isStandardBacktestEnabled()) throw new Error("标准回测未开启：请由维护者设置 STANDARD_BACKTEST_ENABLED=true，既有自由源码开关不受影响");
  validId(sessionId);
  const input = validateRuntimeInput<StartStandardBacktestInput>("start_standard_backtest", StartStandardBacktestSchema, raw);
  input.plan = validateStandardPlan(input.plan);
  if (contentHash(input.plan) !== input.plan_hash) throw new Error("计划已变化，请重新预检");
  input.comparison_run_ids = [...new Set(input.comparison_run_ids ?? [])].sort();
  const requestHash = contentHash(input);
  const build = await standardBuildHash();
  const runId = await inServiceTransaction(pool, async db => {
    if (!(await db.query("SELECT id FROM chat_session WHERE id=$1 AND session_type IN ('interactive','backtest','strategy_evolution')", [sessionId])).rowCount) throw new Error("标准回测须绑定交互或研究会话");
    const comparisons = input.comparison_run_ids!;
    if (comparisons.length && (await db.query("SELECT id FROM backtest_run WHERE id=ANY($1::bigint[]) AND engine_type='standard_daily' AND execution_status='success'", [comparisons])).rowCount !== comparisons.length) throw new Error("对比运行须为已完成的标准回测");
    const state = (await db.query<{change_seq: string; current_hash: string}>("SELECT change_seq::text,current_hash FROM strategy_state WHERE singleton=1")).rows[0];
    const created = await db.query<{id: string}>(`INSERT INTO backtest_run
      (name,kind,status,execution_status,progress,execution_origin,session_id,engine_type,execution_plan,plan_sha256,
       request_json,request_sha256,idempotency_key,worker_build_hash,worker_version,service_version,quality_status,evidence_status,replay_status,phase,
       hypothesis,research_outline,strategy_change_seq,strategy_snapshot_hash)
      VALUES ($1,'research','archived','queued',0,'service',$2,'standard_daily',$3,$4,$5,$6,$7,$8,$9,$9,'unchecked','research_only','unavailable','queued',$10,$10,$11,$12)
      ON CONFLICT (session_id,idempotency_key) WHERE engine_type='standard_daily' DO NOTHING RETURNING id::text`,
      [input.plan.name,sessionId,canonicalJson(input.plan),input.plan_hash,canonicalJson(input),requestHash,input.idempotency_key,build,STANDARD_ENGINE_VERSION,input.plan.hypothesis,state?.change_seq ?? null,state?.current_hash ?? null]);
    let id = created.rows[0]?.id;
    if (!id) {
      const prior = (await db.query<{id:string;request_sha256:string}>("SELECT id::text,request_sha256 FROM backtest_run WHERE session_id=$1 AND idempotency_key=$2 AND engine_type='standard_daily'",[sessionId,input.idempotency_key])).rows[0];
      if (!prior || prior.request_sha256 !== requestHash) throw new Error("幂等键已用于不同请求");
      id=prior.id;
    } else for (const compared of comparisons) await db.query("INSERT INTO backtest_run_comparison(run_id,compared_run_id,relation) VALUES($1,$2,'prior')",[id,compared]);
    return id;
  });
  return (await getStandardBacktestStatus(pool,runId))!;
}

export async function compareStandardRuns(db: Pick<pg.Pool,"query">, id: string): Promise<StandardComparison[]> {
  const rows = (await db.query<{id:string; execution_status:string; input_set_id:string|null; execution_plan:StartStandardBacktestInput["plan"]; worker_build_hash:string; relation_id:string; relation_input:string|null; relation_status:string; relation_plan:StartStandardBacktestInput["plan"]; relation_build:string}>(
    `SELECT r.id::text,r.execution_status,r.input_set_id::text,r.execution_plan,r.worker_build_hash,
       p.id::text AS relation_id,p.input_set_id::text AS relation_input,p.execution_status AS relation_status,
       p.execution_plan AS relation_plan,p.worker_build_hash AS relation_build
     FROM backtest_run r JOIN backtest_run_comparison c ON c.run_id=r.id JOIN backtest_run p ON p.id=c.compared_run_id WHERE r.id=$1`,[id])).rows;
  return rows.map(row => {
    const reasons:string[]=[];
    if(row.execution_status!=="success"||row.relation_status!=="success") reasons.push("运行尚未全部完成");
    if(!row.input_set_id||row.input_set_id!==row.relation_input) reasons.push("冻结输入集不同");
    if(row.worker_build_hash!==row.relation_build) reasons.push("内核制品不同");
    const p=row.execution_plan, q=row.relation_plan;
    const same = (key:keyof typeof p) => p && q && canonicalJson(p[key] ?? null)===canonicalJson(q[key] ?? null);
    for(const key of ["start","end","initial_cash","price_mode","costs","rule","strategies"] as const) if(!same(key)) reasons.push(`${key}口径不同`);
    const variables=["max_positions","daily_buy_limit","position_fraction","stop_loss_pct","max_holding_days","drawdown_circuit","stop_streak_circuit"] as const;
    return {run_id:row.relation_id,comparable:!reasons.length,reasons,parameter_differences:variables.filter(key=>!same(key))};
  });
}
export async function getStandardBacktestStatus(db: Pick<pg.Pool,"query">, id: string): Promise<StandardRunStatus|null> {
  validId(id);
  const row=(await db.query<StandardRunStatus & {worker_build_hash:string}>(`SELECT ${STATUS_SELECT},r.worker_build_hash FROM backtest_run r LEFT JOIN backtest_input_set s ON s.id=r.input_set_id WHERE r.id=$1 AND r.engine_type='standard_daily'`,[id])).rows[0];
  if(!row)return null;
  const {worker_build_hash,...status}=row;
  if(status.replay_status==='exact'&&worker_build_hash!==await standardBuildHash())status.replay_status='materials_only';
  return {...status,enabled:isStandardBacktestEnabled(),comparisons:await compareStandardRuns(db,id)};
}
export async function cancelStandardBacktest(db: TransactionDb,id:string,reason:string,sessionId?:string): Promise<StandardRunStatus> {
  validId(id); if(!reason.trim()||reason.length>300)throw new Error("取消原因非法");
  await inServiceTransaction(db,async client=>{
    const r=(await client.query<{execution_status:string}>("SELECT execution_status FROM backtest_run WHERE id=$1 AND engine_type='standard_daily' FOR UPDATE",[id])).rows[0];
    if(!r)throw new Error("标准回测不存在");
    if(active.includes(r.execution_status))await client.query(`UPDATE backtest_run SET execution_status='cancelled',phase='cancelled',cancel_requested_at=now(),finished_at=now(),lease_token=NULL,lease_expires_at=NULL,error_message='用户已取消',notes=$2 WHERE id=$1`,[id,`${sessionId ? `取消来源会话 ${sessionId}` : "本机取消"}：${reason.trim()}`]);
  });
  return (await getStandardBacktestStatus(db,id))!;
}
export interface ClaimedStandardRun { id:string; generation:number; lease_token:string; execution_plan:StartStandardBacktestInput["plan"]; request_json:StartStandardBacktestInput; worker_build_hash:string }
export async function claimStandardRun(pool:pg.Pool):Promise<ClaimedStandardRun|null>{
  if(!isStandardBacktestEnabled())return null;
  return inServiceTransaction(pool,async db=>{
    // 单库单执行者；事务锁防止两个应用进程同时越过并发一的检查。
    if(!(await db.query<{ok:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext(current_database()),hashtext('standard-backtest-claim')) AS ok")).rows[0]?.ok)return null;
    if((await db.query("SELECT id FROM backtest_run WHERE engine_type='standard_daily' AND execution_status IN ('preparing','running') AND lease_expires_at>clock_timestamp() LIMIT 1")).rowCount)return null;
    const id=(await db.query<{id:string}>("SELECT id::text FROM backtest_run WHERE engine_type='standard_daily' AND execution_status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0]?.id;
    if(!id)return null;
    return (await db.query<ClaimedStandardRun>(`UPDATE backtest_run SET generation=generation+1,lease_token=$2,lease_expires_at=now()+interval '30 seconds',heartbeat_at=now(),started_at=now(),execution_status='preparing',phase='preparing'
      WHERE id=$1 RETURNING id::text,generation,lease_token::text,execution_plan,request_json,worker_build_hash`,[id,crypto.randomUUID()])).rows[0]!;
  });
}
export async function heartbeatStandardRun(db:Pick<pg.Pool,"query">,run:ClaimedStandardRun,progress?:number):Promise<boolean>{
  return (await db.query(`UPDATE backtest_run SET heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds',progress=GREATEST(progress,COALESCE($4,progress))
    WHERE id=$1 AND generation=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp() AND execution_status IN ('preparing','running') AND cancel_requested_at IS NULL`,[run.id,run.generation,run.lease_token,progress ?? null])).rowCount===1;
}
async function lockLease(db:pg.PoolClient,run:ClaimedStandardRun){
  const row=(await db.query<{input_summary:Record<string,unknown>; input_set_id:string|null}>(`SELECT input_summary,input_set_id::text FROM backtest_run WHERE id=$1 AND generation=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp() AND execution_status IN ('preparing','running') AND cancel_requested_at IS NULL FOR UPDATE`,[run.id,run.generation,run.lease_token])).rows[0];
  if(!row)throw new Error("LEASE_LOST"); return row;
}
export async function attachStandardInput(pool:pg.Pool,run:ClaimedStandardRun,frozen:FrozenStandardInput):Promise<void>{
  await inServiceTransaction(pool,async db=>{
    await lockLease(db,run);
    await db.query(`UPDATE backtest_run SET input_set_id=$2,execution_status='running',phase='running',quality_status='complete',data_gaps=$3,replay_status='materials_only',input_summary=$4 WHERE id=$1`,
      [run.id,frozen.id,JSON.stringify(frozen.manifest.gaps),JSON.stringify({input_sha256:frozen.sha256,row_count:frozen.manifest.row_count,day_count:frozen.manifest.day_count,formal_count:frozen.manifest.chunks.filter(d=>d.date>=run.execution_plan.start).length,last_seq:0,output_chain:contentHash([])})]);
  });
}
export async function appendStandardDay(pool:pg.Pool,run:ClaimedStandardRun,day:StandardDay,result:StandardDayResult):Promise<void>{
  if(!result.equity){verifySettlement(run.execution_plan,day,result,null,0);return;}
  await inServiceTransaction(pool,async db=>{
    const row=await lockLease(db,run);
    const hash=contentHash(result);
    const existing=(await db.query<{sha256:string}>("SELECT sha256 FROM backtest_equity_daily WHERE run_id=$1 AND generation=$2 AND trade_date=$3",[run.id,run.generation,day.date])).rows[0];
    if(existing){if(existing.sha256!==hash)throw new Error("LEDGER_MISMATCH");return;}
    const prev=(await db.query<{payload:StandardEquity}>("SELECT payload FROM backtest_equity_daily WHERE run_id=$1 AND generation=$2 ORDER BY trade_date DESC LIMIT 1",[run.id,run.generation])).rows[0]?.payload ?? null;
    if(prev && prev.date>=day.date)throw new Error("LEDGER_MISMATCH");
    const realized=verifySettlement(run.execution_plan,day,result,prev,Number(row.input_summary.last_seq ?? 0),(row.input_summary.realized_by_code ?? {}) as Record<string,number>);
    const benchmarkBase=Number(row.input_summary.benchmark_base ?? day.benchmark?.close);
    if(run.execution_plan.benchmark_code && (!day.benchmark || day.benchmark.code!==run.execution_plan.benchmark_code || !Number.isSafeInteger(result.equity?.benchmark_equity_cents) || result.equity?.benchmark_close!==day.benchmark.close || result.equity.benchmark_return!==day.benchmark.close/benchmarkBase-1 || result.equity.benchmark_equity_cents!==Math.round(run.execution_plan.initial_cash*100*day.benchmark.close/benchmarkBase))) throw new Error("LEDGER_MISMATCH");
    if(!run.execution_plan.benchmark_code && result.equity?.benchmark_return!==undefined)throw new Error("LEDGER_MISMATCH");
    for(const event of result.events)await db.query("INSERT INTO backtest_event(run_id,generation,seq,trade_date,payload,sha256) VALUES($1,$2,$3,$4,$5,$6)",[run.id,run.generation,event.seq,event.date,canonicalJson(event),contentHash(event)]);
    await db.query("INSERT INTO backtest_equity_daily(run_id,generation,trade_date,cash_cents,equity_cents,payload,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)",[run.id,run.generation,day.date,result.equity!.cash_cents,result.equity!.equity_cents,canonicalJson(result.equity),hash]);
    const summary={...row.input_summary,realized_by_code:realized,...(day.benchmark?{benchmark_base:benchmarkBase}:{}),last_seq:result.events.at(-1)?.seq ?? row.input_summary.last_seq,output_chain:contentHash([row.input_summary.output_chain,hash])};
    await db.query("UPDATE backtest_run SET input_summary=$2 WHERE id=$1",[run.id,JSON.stringify(summary)]);
  });
}
export async function completeStandardRun(pool:pg.Pool,run:ClaimedStandardRun,workerMetrics:Record<string,number|null>):Promise<void>{
  if(await standardBuildHash()!==run.worker_build_hash)throw new Error("WORKER_BUILD_CHANGED");
  await inServiceTransaction(pool,async db=>{
    const row=await lockLease(db,run);
    const equities=(await db.query<{payload:StandardEquity}>("SELECT payload FROM backtest_equity_daily WHERE run_id=$1 AND generation=$2 ORDER BY trade_date",[run.id,run.generation])).rows.map(r=>r.payload);
    if(!equities.length||equities.length!==Number(row.input_summary.formal_count))throw new Error("LEDGER_MISMATCH");
    const initial=Math.round(run.execution_plan.initial_cash*100);
    let peak=initial,maxDrawdown=0;
    for(const eq of equities){peak=Math.max(peak,eq.equity_cents); const dd=(peak-eq.equity_cents)/peak;if(eq.drawdown!==dd)throw new Error("LEDGER_MISMATCH");maxDrawdown=Math.max(maxDrawdown,dd);}
    const closed=(await db.query<{n:number;wins:number}>(`SELECT count(*)::int AS n,count(*) FILTER(WHERE (payload->'details'->>'pnl_cents')::numeric>0)::int AS wins
      FROM backtest_event WHERE run_id=$1 AND generation=$2 AND payload->>'type'='closed'`,[run.id,run.generation])).rows[0]!;
    const last=equities.at(-1)!;
    const metrics={total_return:last.equity_cents/initial-1,max_drawdown:maxDrawdown,trade_count:closed.n,win_rate:closed.n?closed.wins/closed.n:null,
      fees_cents:last.fees_cents,final_equity_cents:last.equity_cents,open_position_count:last.positions.length};
    for(const [key,value] of Object.entries(metrics))if(workerMetrics[key]!==value)throw new Error("LEDGER_MISMATCH");
    const extendedMetrics={...metrics,...(last.benchmark_return!==undefined?{benchmark_return:last.benchmark_return,excess_return:metrics.total_return-last.benchmark_return}:{})};
    const conclusion=`# 标准日频研究结论\n\n采用注册规则或组合、固定标的集、收盘决策与后续开盘执行。\n\n- 正式结算日：${equities.length}\n- 完全闭环批次：${closed.n}\n- 终点未平仓标的：${last.positions.length}\n- 收益率：${(metrics.total_return*100).toFixed(4)}%\n- 最大回撤：${(maxDrawdown*100).toFixed(4)}%\n\n**仅研究证据**：当前费用、价格制度、公司行为与样本历史资格未完整验证；不能作为整套生产策略收益证明。终点按持仓估值，不虚构平仓。`;
    await db.query(`UPDATE backtest_run SET execution_status='success',phase='completed',progress=100,finished_at=now(),lease_token=NULL,lease_expires_at=NULL,
      metrics_json=$2,conclusion_md=$3,output_sha256=$4,replay_status='exact',evidence_status='research_only' WHERE id=$1`,[run.id,JSON.stringify(extendedMetrics),conclusion,row.input_summary.output_chain]);
  });
}
export async function failStandardRun(pool:pg.Pool,run:ClaimedStandardRun,code:string,rejected=false,gaps:unknown[]=[]):Promise<void>{
  const safeCodes=["DATA_MISSING","INPUT_CHANGED","WORKER_BUILD_CHANGED","WORKER_FAILED","WORKER_TIMEOUT","WORKER_STOPPED","LEDGER_MISMATCH","LEASE_LOST"];
  const safe=safeCodes.includes(code)?code:"WORKER_FAILED";
  await pool.query(`UPDATE backtest_run SET execution_status=$4,phase=$4,finished_at=now(),lease_token=NULL,lease_expires_at=NULL,error_message=$5,
    quality_status=CASE WHEN $4='rejected' THEN 'incomplete' ELSE quality_status END,data_gaps=CASE WHEN jsonb_array_length($6::jsonb)>0 THEN $6::jsonb ELSE data_gaps END
    WHERE id=$1 AND generation=$2 AND lease_token=$3 AND execution_status IN ('preparing','running')`,[run.id,run.generation,run.lease_token,rejected?'rejected':'failed',safe,JSON.stringify(gaps)]);
}
export async function expireStandardLeases(pool:pg.Pool):Promise<void>{
  await pool.query(`UPDATE backtest_run SET execution_status='failed',phase='failed',finished_at=now(),error_message='LEASE_LOST',lease_token=NULL,lease_expires_at=NULL
    WHERE engine_type='standard_daily' AND execution_status IN ('preparing','running') AND (lease_expires_at IS NULL OR lease_expires_at<=now())`);
}
export async function getStandardRunPage<T extends StandardEvent|StandardEquity>(db:Pick<pg.Pool,"query">,id:string,kind:'events'|'equity',after:string|undefined,limit=100):Promise<StandardPage<T>>{
  validId(id);if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("分页大小应为1—200");
  if(after && (kind==='events'?!/^\d{1,9}$/.test(after):!/^\d{4}-\d{2}-\d{2}$/.test(after)))throw new Error("分页游标非法");
  const table=kind==='events'?'backtest_event':'backtest_equity_daily';
  const cursor=kind==='events'?'seq':'trade_date';
  const rows=(await db.query<{payload:T;cursor:string}>(`SELECT e.payload,e.${cursor}::text AS cursor FROM ${table} e JOIN backtest_run r ON r.id=e.run_id
    WHERE r.id=$1 AND r.engine_type='standard_daily' AND e.generation=r.generation AND ($2::${kind==='events'?'integer':'date'} IS NULL OR e.${cursor}>$2::${kind==='events'?'integer':'date'})
    ORDER BY e.${cursor} LIMIT $3`,[id,after??null,limit+1])).rows;
  const selected:typeof rows=[];let bytes=0;
  for(const row of rows.slice(0,limit)){
    const size=Buffer.byteLength(JSON.stringify(row.payload));
    if(selected.length && bytes+size>256*1024)break;
    if(size>256*1024)throw new Error("单条结果超过响应预算");
    selected.push(row);bytes+=size;
  }
  return {items:selected.map(r=>r.payload),next_cursor:rows.length>selected.length?selected.at(-1)?.cursor??null:null};
}

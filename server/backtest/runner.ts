import type pg from 'pg';
import { standardBuildHash } from './build.js';
import { createStandardWorker } from './executor.js';
import { freezeStandardBacktestInput, readFrozenStandardInput, StandardBacktestPreflightError } from '../modules/backtests/service.js';
import { appendStandardDay, attachStandardInput, claimStandardRun, completeStandardRun, expireStandardLeases, failStandardRun, heartbeatStandardRun } from '../modules/backtests/runtime.js';
/** 单机默认并发一；数据库领取锁与租约同时保护多应用进程。 */
export class StandardBacktestRunner{
  private timer:NodeJS.Timeout|null=null;
  private current:Promise<void>|null=null;
  private controller:AbortController|null=null;
  private stopping=false;
  constructor(private readonly pool:pg.Pool){}
  start(){this.stopping=false;if(!this.timer){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},2000);this.timer.unref();void this.tick().catch(()=>{});}}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.controller?.abort();await this.current;}
  async tick():Promise<void>{
    if(this.stopping)return;
    if(this.current)return this.current;
    const task=this.run();this.current=task;
    try{await task;}finally{if(this.current===task)this.current=null;}
  }
  private async run(){
    await expireStandardLeases(this.pool);
    if(this.stopping)return;
    const run=await claimStandardRun(this.pool);if(!run)return;
    if(this.stopping){await failStandardRun(this.pool,run,"WORKER_STOPPED");return;}
    const controller=new AbortController();this.controller=controller;
    let beating=false;
    const heartbeat=setInterval(()=>{if(beating)return;beating=true;void heartbeatStandardRun(this.pool,run).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort()).finally(()=>{beating=false;});},2000);
    let timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},30*60_000);
    let worker:ReturnType<typeof createStandardWorker>|null=null;
    try{
      if(await standardBuildHash()!==run.worker_build_hash)throw new Error('WORKER_BUILD_CHANGED');
      const frozen=await freezeStandardBacktestInput(this.pool,run.execution_plan,{plan_hash:run.request_json.plan_hash,input_hash:run.request_json.input_hash},controller.signal);
      await attachStandardInput(this.pool,run,frozen);
      worker=createStandardWorker(controller.signal);await worker.init(run.execution_plan);
      let count=0;let benchmarkBase:number|null=null;
      for await(const day of readFrozenStandardInput(this.pool,frozen.id,frozen.sha256)){
        if(controller.signal.aborted)throw new Error('WORKER_STOPPED');
        const result=await worker.next(day);
        if(result.equity&&day.benchmark){
          benchmarkBase??=day.benchmark.close;
          result.equity.benchmark_close=day.benchmark.close;
          result.equity.benchmark_equity_cents=Math.round(run.execution_plan.initial_cash*100*day.benchmark.close/benchmarkBase);
          result.equity.benchmark_return=day.benchmark.close/benchmarkBase-1;
        }
        await appendStandardDay(this.pool,run,day,result);count++;
        if(count%20===0&&!await heartbeatStandardRun(this.pool,run,Math.min(99,Math.floor(count/frozen.manifest.day_count*99))))throw new Error('LEASE_LOST');
      }
      if(count!==frozen.manifest.day_count)throw new Error('LEDGER_MISMATCH');
      await completeStandardRun(this.pool,run,await worker.finish());
    }catch(error){
      const preflight=error instanceof StandardBacktestPreflightError;
      const message=timedOut?'WORKER_TIMEOUT':(error as Error).message;
      const changed=/输入已变化/.test(message);
      await failStandardRun(this.pool,run,preflight?'DATA_MISSING':changed?'INPUT_CHANGED':message,preflight||changed,preflight?error.report.manifest.gaps:[]);
    }finally{
      clearInterval(heartbeat);clearTimeout(timeout);await worker?.close();this.controller=null;
    }
  }
}

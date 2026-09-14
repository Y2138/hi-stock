import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, type StandardBacktestPlan, type StandardDay, type StandardDayResult } from './contracts.js';
/** 只执行固定受信任模块，不是自由代码沙箱；无数据库或供应商环境变量。 */
export function createStandardWorker(signal:AbortSignal){
  const child=fork(fileURLToPath(new URL('./engine-worker.ts',import.meta.url)),[],{
    execArgv:['--max-old-space-size=512','--import','tsx'],
    env:{PATH:process.env.PATH??'',TZ:'Asia/Shanghai',NODE_ENV:'production'},stdio:['ignore','ignore','ignore','ipc'],
  });
  let seq=0,closed=false;
  let pending:{id:number;resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}|null=null;
  const fail=(code:string)=>{if(pending){clearTimeout(pending.timer);pending.reject(new Error(code));pending=null;}};
  const abort=()=>{closed=true;fail('WORKER_STOPPED');child.kill('SIGKILL');};
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  child.on('error',()=>{closed=true;fail('WORKER_FAILED');});
  child.on('exit',()=>{closed=true;fail('WORKER_FAILED');signal.removeEventListener('abort',abort);});
  child.on('message',(raw:unknown)=>{
    const m=raw as {id:number;ok:boolean;value?:unknown};
    try{if(!pending||!m||m.id!==pending.id||m.ok!==true||Buffer.byteLength(canonicalJson(m))>2*1024*1024)throw new Error();}
    catch{fail('WORKER_FAILED');child.kill('SIGKILL');return;}
    const p=pending!;pending=null;clearTimeout(p.timer);p.resolve(m.value);
  });
  const request=(kind:string,data:Record<string,unknown>={}):Promise<unknown>=>new Promise((resolve,reject)=>{
    if(closed||signal.aborted||pending){reject(new Error('WORKER_STOPPED'));return;}
    const id=++seq;
    const timer=setTimeout(()=>{fail('WORKER_TIMEOUT');child.kill('SIGKILL');},30_000);
    pending={id,resolve,reject,timer};child.send({id,kind,...data},error=>{if(error)fail('WORKER_FAILED');});
  });
  return {
    init:(plan:StandardBacktestPlan)=>request('init',{plan}),
    next:async(day:StandardDay)=>await request('day',{day}) as StandardDayResult,
    finish:async()=>await request('finish') as Record<string,number|null>,
    async close(){signal.removeEventListener('abort',abort);fail('WORKER_STOPPED');if(!closed&&child.pid&&child.exitCode===null&&child.signalCode===null)await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGKILL');});},
  };
}

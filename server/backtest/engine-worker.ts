import { createPortfolioEngine } from "./portfolio-engine.js";
import type { StandardEngine } from "./contracts.js";
let engine:StandardEngine|null=null;
let expected=1;
process.on('disconnect',()=>process.exit(0));
process.on('message',(message:unknown)=>{
  const m=message as {id:number;kind:string;plan?:Parameters<typeof createPortfolioEngine>[0];day?:Parameters<StandardEngine['next']>[0]};
  try{
    if(!m||m.id!==expected++)throw new Error('WORKER_PROTOCOL');
    let value:unknown;
    if(m.kind==='init'&&!engine&&m.plan){engine=createPortfolioEngine(m.plan);value={ready:true};}
    else if(m.kind==='day'&&engine&&m.day)value=engine.next(m.day);
    else if(m.kind==='finish'&&engine){value=engine.finish();engine=null;}
    else throw new Error('WORKER_PROTOCOL');
    process.send?.({id:m.id,ok:true,value});
  }catch{process.send?.({id:m?.id,ok:false,error:'WORKER_FAILED'});}
});

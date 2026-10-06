// Moderate, read-only polling, scoped to the mounted printer card. Scheduling
// after each completed query avoids overlap and a backlog of full diagnostics.
export function createPrinterPresenceMonitor<T>({query,receive,error,shouldQuery,schedule,unschedule}:{
  query:()=>Promise<T>;receive:(value:T)=>void;error?:(error:unknown)=>void;shouldQuery:()=>boolean;
  schedule?:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;
  unschedule?:(id:ReturnType<typeof setTimeout>)=>void;
}) {
  const scheduleNext=schedule??((fn,ms)=>setTimeout(fn,ms));const cancel=unschedule??clearTimeout;
  let stopped=false;let timer:ReturnType<typeof setTimeout>|null=null;
  const next=()=>{if(!stopped)timer=scheduleNext(()=>void tick(),8000);};
  const tick=async()=>{
    timer=null;if(stopped)return;
    try{if(shouldQuery()){const value=await query();if(!stopped)receive(value);}}catch(failure){if(!stopped)error?.(failure);}
    finally{next();}
  };
  next();return {stop(){stopped=true;if(timer!==null)cancel(timer);timer=null;}};
}

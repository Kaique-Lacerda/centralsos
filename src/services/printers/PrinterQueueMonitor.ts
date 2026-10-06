import type { QueueMonitorEvent } from '../../types/printer-diagnostic';

export interface QueueMonitorDependencies<T> {
  query:()=>Promise<T>;receive:(value:T)=>void;error:(error:unknown)=>void;busy:(busy:boolean)=>void;
  subscribe:(receive:(event:QueueMonitorEvent)=>void)=>Promise<()=>void>;
  mode:(mode:'native'|'polling'|'manual',detail?:string)=>void;
  schedule?:(callback:()=>void,ms:number)=>ReturnType<typeof setInterval>;
  unschedule?:(timer:ReturnType<typeof setInterval>)=>void;
}
export function createPrinterQueueMonitor<T>(deps:QueueMonitorDependencies<T>) {
  let active=true;let pending=false;let running:Promise<void>|null=null;let stopNative:(()=>void)|null=null;
  let timer:ReturnType<typeof setInterval>|null=null;
  const schedule=deps.schedule??setInterval;const unschedule=deps.unschedule??clearInterval;
  const fallback=(detail?:string)=>{if(!active)return;if(timer===null)timer=schedule(()=>{void refresh();},3000);deps.mode('polling',detail);};
  const refresh=():Promise<void>=>{
    if(!active)return Promise.resolve();
    if(running){pending=true;return running;}
    running=(async()=>{do {pending=false;if(active)deps.busy(true);
      try{const value=await deps.query();if(active)deps.receive(value);}catch(error){if(active)deps.error(error);}
      finally{if(active)deps.busy(false);}
    }while(active&&pending);})().finally(()=>{running=null;});return running;
  };
  void deps.subscribe(event=>{if(!active)return;if(event.mode==='polling')fallback(event.detail??undefined);else if(event.mode==='native'){if(timer!==null){unschedule(timer);timer=null;}deps.mode('native');if(event.changed)void refresh();}})
    .then(stop=>{if(active)stopNative=stop;else stop();}).catch(error=>fallback(String(error)));
  void refresh();
  return {refresh,stop(){active=false;pending=false;if(timer!==null){unschedule(timer);timer=null;}stopNative?.();}};
}

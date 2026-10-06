// Full diagnostics also read EnumJobs. Serialize them with live queue queries.
export function createPrinterQueryCoordinator() {
  const pending=new Map<string,Promise<unknown>>();
  return function query<T>(name:string,read:()=>Promise<T>):Promise<T> {
    const key=name.toLocaleLowerCase('en-US');
    const previous=pending.get(key)??Promise.resolve();
    const current=previous.catch(()=>{}).then(read);pending.set(key,current);
    const cleanup=()=>{if(pending.get(key)===current)pending.delete(key);};
    void current.then(cleanup,cleanup);return current;
  };
}

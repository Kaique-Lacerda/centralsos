import type { MachineEnvironment } from '../../types';
const KEY='central-sos:machine-environment';
export const LocalConfigService={load():MachineEnvironment|null{try{const v=localStorage.getItem(KEY);return v?JSON.parse(v) as MachineEnvironment:null}catch{return null}},save(v:MachineEnvironment){localStorage.setItem(KEY,JSON.stringify(v))},clear(){localStorage.removeItem(KEY)}};

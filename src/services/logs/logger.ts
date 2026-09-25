import type { LogLevel } from '../../types';
export const logger={write(level:LogLevel,message:string){const entry={level,message,timestamp:new Date().toISOString()};console.info('[CENTRAL SOS]',entry);return entry}};

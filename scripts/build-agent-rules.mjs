import {build} from 'esbuild';
import {resolve} from 'node:path';
if(!process.env.CENTRAL_SOS_RULES_OUTPUT) throw Error('OUT_DIR obrigatório: execute através do Cargo.');
await build({entryPoints:[resolve(import.meta.dirname,'../src/agent/RulesRuntime.ts')],bundle:true,platform:'neutral',format:'iife',globalName:'CentralAgentRules',target:'es2022',outfile:process.env.CENTRAL_SOS_RULES_OUTPUT,legalComments:'none'});

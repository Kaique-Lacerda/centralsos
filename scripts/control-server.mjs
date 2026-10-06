import { createServer } from 'node:http';
import { build } from 'esbuild';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
await build({entryPoints:['server/control/HttpApi.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'.control-build/server.mjs'});
const {handleControlApi} = await import(pathToFileURL(resolve('.control-build/server.mjs')).href);
createServer(handleControlApi).listen(1431,'127.0.0.1',()=>console.log('Backend development: http://127.0.0.1:1431 (loopback only, external TLS required).'));

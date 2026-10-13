import { createServer } from 'node:https';
import { readFile,writeFile,mkdtemp,mkdir } from 'node:fs/promises';
import { join,resolve,extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { load } from '../tests/control/load.mjs';
import { postgresFixture } from '../tests/integration/postgres-fixture.mjs';

// Explicit local real-data preview. Does not connect to any existing database.
// Certificate files must be supplied; HTTPS and all application protections remain enabled.
let fixture;
let stage='configuration';
try {
    if (!process.env.CONTROL_TEST_POSTGRES_BIN || !process.env.CATALOG_PREVIEW_TLS_KEY || !process.env.CATALOG_PREVIEW_TLS_CERT) throw new Error('PREVIEW_CONFIGURATION_REQUIRED');
    const {CatalogAuthentication,CatalogService,PrivateBlobStorage,rotateCredential,digest,createCatalogHandler}=await load('tests/catalog/entry.ts');
    const {migrateCatalogSql}=await load('server/catalog/Migrations.ts');
    stage='postgres';fixture=await postgresFixture(process.env.CONTROL_TEST_POSTGRES_BIN);const pool=fixture.createPool();
    stage='migration';
    await migrateCatalogSql(pool,await readFile('server/catalog/migrations/001_catalog.sql','utf8'),true);
    const root=join(process.env.LOCALAPPDATA??resolve('.control-build'),'CentralSOS','Privado');await mkdir(root,{recursive:true});
    const credentials=await mkdtemp(join(root,'catalog-preview-'));
    stage='credential-file-acl';
    if(process.platform==='win32') {
        const identity=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true,stdio:'pipe',encoding:'utf8'});
        const sid=/S-1-5-21-\d+-\d+-\d+-\d+/.exec(identity)?.[0];
        if(!sid)throw new Error('PREVIEW_IDENTITY_UNAVAILABLE');
        execFileSync('icacls.exe',[credentials,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{windowsHide:true,stdio:'pipe'});
    }
    stage='credential-bootstrap';
    const client=await pool.connect();
    try {
        await client.query('BEGIN');
        for(const role of ['admin','technician']){
            const password=randomBytes(24).toString('base64url');
            await rotateCredential(client,role,password,{role:'admin',tokenHash:digest('preview-bootstrap')});
            await writeFile(join(credentials,role+'.password'),password,{mode:0o600});
        }
        await client.query('COMMIT');
    } finally {client.release();}
    const origin='https://localhost:1442',auth=new CatalogAuthentication(pool,randomBytes(32).toString('hex'));
    const handler=createCatalogHandler(()=>({pool,auth,catalog:new CatalogService(pool,new PrivateBlobStorage()),origin}));
    const rootFiles=resolve('dist/web'),mimes={'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.html':'text/html'};
    stage='https';const server=createServer({key:await readFile(process.env.CATALOG_PREVIEW_TLS_KEY),cert:await readFile(process.env.CATALOG_PREVIEW_TLS_CERT)},async(req,res)=>{
        try{
            const path=new URL(req.url??'/',origin).pathname;
            if(path.startsWith('/api/catalog/')){await handler(req,res);return;}
            if(path.startsWith('/api/')){res.statusCode=404;res.end();return;}
            const relative=path.startsWith('/assets/')?path.slice(1):'index.html';
            if(relative.includes('..')||relative.includes('\\')){res.statusCode=404;res.end();return;}
            const file=join(rootFiles,relative);res.setHeader('Content-Type',mimes[extname(file)]??'application/octet-stream');res.end(await readFile(file));
        }catch{res.statusCode=500;res.end('Preview request failed');}
    });
    server.listen(1442,'127.0.0.1',()=>console.log(JSON.stringify({event:'catalog.preview_ready',url:origin+'/catalog',credentialsDirectory:credentials,postgres:fixture.version,storage:'private-blob'})));
    async function stop(){await new Promise(ok=>server.close(ok));await fixture.close();process.exit();}
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
}catch(error){console.error(JSON.stringify({event:'catalog.preview_failed',stage,code:'PREVIEW_CONFIGURATION_OR_START_FAILED',reason:['EACCES','EPERM','ENOENT','23505','42601'].includes(error?.code)?error.code:undefined}));await fixture?.close();process.exitCode=1;}

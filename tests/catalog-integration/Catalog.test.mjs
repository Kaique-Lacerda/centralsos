import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { load } from '../control/load.mjs';
import { postgresFixture } from '../integration/postgres-fixture.mjs';
const { migrateCatalogSql }=await load('server/catalog/Migrations.ts');
const { CatalogAuthentication,rotateCredential,digest,CatalogService,createCatalogHandler,PrivateBlobStorage }=await load('tests/catalog/entry.ts');
const sql=await readFile('server/catalog/migrations/001_catalog.sql','utf8');
test('PostgreSQL real: autenticação, persistência e fluxo do catálogo', {skip:!process.env.CONTROL_TEST_POSTGRES_BIN?'Defina CONTROL_TEST_POSTGRES_BIN; nunca usa banco existente.':false},async t=>{
    // Allow slow local Windows fsync without relaxing PostgreSQL durability or application timeouts.
    const fixture=await postgresFixture(process.env.CONTROL_TEST_POSTGRES_BIN,{commandTimeout:120000,waitSeconds:90}),pool=fixture.createPool();
    const passwords={admin:randomBytes(24).toString('base64url'),technician:randomBytes(24).toString('base64url')};
    const assets=new Map();let signs=0;
    const realBlob=process.env.CATALOG_TEST_REAL_BLOB==='1',bytes=Buffer.from('504b0506'+'00'.repeat(18),'hex');
    const blob=realBlob?new PrivateBlobStorage():null;
    const expectedHash=realBlob?createHash('sha256').update(bytes).digest('hex'):digest('fixture bytes');
    // Transport fixture only. PostgreSQL, sessions, authorization and mutations are real.
    const storage={upload:async(path,size,type)=>{assets.set(path,{size});return blob?blob.upload(path,size,type):'https://storage.test/upload';},verify:async(path,size,name)=>{assert.equal(assets.get(path).size,size);return blob?blob.verify(path,size,name):digest('fixture bytes');},download:async path=>{signs++;return blob?blob.download(path):'https://storage.test/signed';}};
    const auth=new CatalogAuthentication(pool,randomBytes(32).toString('hex')),catalog=new CatalogService(pool,storage);
    const server=createServer(createCatalogHandler(()=>({pool,auth,catalog,origin:'https://catalog.test'})));
    await new Promise(ok=>server.listen(0,'127.0.0.1',ok)); const base='http://127.0.0.1:'+server.address().port;
    async function request(path,method='GET',session=null,data,headers={}){
        const response=await fetch(base+'/api/catalog/'+path,{method,headers:{Origin:'https://catalog.test',...(session?{Cookie:session.cookie,'X-Catalog-CSRF':session.session.csrfToken}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
        return {status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().find(value=>!value.includes('Max-Age=0'))?.split(';')[0]};
    }
    let admin,tech,toolId,versionId;
    try {
        await t.test('migração persistida, idempotente e ledger separado do Control',async()=>{
            assert.equal((await migrateCatalogSql(pool,sql,false)).dryRun,true);
            assert.equal((await pool.query("SELECT to_regclass('catalog_tools') AS name")).rows[0].name,null);
            const applied=await migrateCatalogSql(pool,sql,true);assert.equal(applied.applied,true);assert.equal(applied.pending,false);assert.equal((await migrateCatalogSql(pool,sql,true)).applied,true);
            await assert.rejects(migrateCatalogSql(pool,sql+'\n-- changed',true),/CATALOG_MIGRATION_DIVERGENT/);
            assert.equal((await pool.query("SELECT to_regclass('control_users') AS name")).rows[0].name,null);
            const client=await pool.connect();try{await client.query('BEGIN');for(const role of ['admin','technician']) await rotateCredential(client,role,passwords[role],{role:'admin',tokenHash:digest('test-bootstrap')});await client.query('COMMIT');}finally{client.release();}
        });
        await t.test('login cria cookies seguros; técnico não recebe administrador',async()=>{
            const a=await request('login','POST',null,{role:'admin',password:passwords.admin});assert.equal(a.status,200);admin={cookie:a.cookie,session:a.data};
            const b=await request('login','POST',null,{role:'technician',password:passwords.technician});assert.equal(b.status,200);tech={cookie:b.cookie,session:b.data};
            assert.equal(tech.session.role,'technician');assert.equal((await request('login','POST',null,{role:'admin',password:passwords.technician})).status,401);
            const hashes=JSON.stringify([a.data,b.data]);assert.ok(!hashes.includes(passwords.admin));assert.ok(!hashes.includes('password_hash'));
        });
        await t.test('nega CSRF, payload inválido e operações administrativas do técnico',async()=>{
            assert.equal((await request('categories','POST',admin,{name:'X'},{Origin:'https://evil.test'})).status,403);
            assert.equal((await request('categories','POST',admin,{name:'X'},{'X-Catalog-CSRF':'wrong'})).status,403);
            assert.equal((await request('categories','POST',tech,{name:'X'})).status,403);
            assert.equal((await request('tools','POST',admin,{name:'invalid'})).status,400);
        });
        await t.test('administrador cadastra, envia, verifica; nada fica publicado automaticamente',async()=>{
            const category=await request('categories','POST',admin,{name:'Homologação'});assert.equal(category.status,201);
            const created=await request('tools','POST',admin,{name:'Ferramenta de teste',description:'Fixture do catálogo',categoryId:category.data.id,type:'Arquivo',compatibility:'Windows',tags:['teste'],requiresAdmin:false,visibility:'technicians'});assert.equal(created.status,201);toolId=created.data.id;
            const upload=await request(`tools/${toolId}/upload`,'POST',admin,{version:'1.0',fileName:'test.zip',size:22});assert.equal(upload.status,201);versionId=upload.data.versionId;
            if(realBlob){const sent=await fetch(upload.data.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Content-Type':'application/octet-stream'},body:bytes});assert.equal(sent.ok,true,'Blob privado deve aceitar upload autorizado');}
            assert.equal((await request('tools','GET',tech)).data.length,0);assert.equal((await request('categories')).status,401);
            assert.equal((await request(`versions/${versionId}/publish`,'POST',admin)).status,409);
            assert.equal((await request(`versions/${versionId}/finalize`,'POST',admin)).status,200);
            assert.equal((await request('tools','GET',tech)).data.length,0);
        });
        await t.test('publica: técnico consulta e baixa; anônimo/IDs adivinhados recebem acesso negado',async()=>{
            assert.equal((await request(`versions/${versionId}/publish`,'POST',admin)).status,200);
            const list=await request('tools','GET',tech);assert.equal(list.data[0].id,toolId);assert.equal(list.data[0].versions[0].sha256,expectedHash);
            assert.ok(!JSON.stringify(list.data).includes('object_path'));assert.ok(!JSON.stringify(list.data).includes('upload_owner'));
            const issued=await request(`versions/${versionId}/download`,'POST',tech);assert.equal(issued.status,200);assert.equal(signs,1);
            if(realBlob){const fetched=await fetch(issued.data.url);assert.equal(fetched.ok,true,'URL temporária deve baixar arquivo real');assert.equal(createHash('sha256').update(Buffer.from(await fetched.arrayBuffer())).digest('hex'),expectedHash);const permanent=new URL(issued.data.url);permanent.search='';const denied=await fetch(permanent);assert.equal(denied.ok,false,'URL sem assinatura não pode ler Blob privado');}
            assert.equal((await request('tools')).status,401);assert.equal((await request(`versions/${versionId}/download`,'POST')).status,401);
            assert.equal((await request(`versions/${randomUUID()}/download`,'POST',tech)).status,404);assert.equal(signs,1);
        });
        await t.test('despublicação impede novas emissões; histórico permanece',async()=>{
            assert.equal((await request(`versions/${versionId}/unpublish`,'POST',admin)).status,200);
            assert.equal((await request('tools','GET',tech)).data.length,0);assert.equal((await request(`versions/${versionId}/download`,'POST',tech)).status,404);assert.equal(signs,1);
            assert.ok((await request('audit','GET',admin)).data.some(row=>row.action==='version.unpublish'));
            assert.equal((await request('audit','GET',tech)).status,403);
        });
        await t.test('visibilidade pública legada exige sessão; somente administrador exclui técnico',async()=>{
            await pool.query("UPDATE catalog_tools SET visibility='public' WHERE id=$1",[toolId]);
            await request(`versions/${versionId}/publish`,'POST',admin);assert.equal((await request('tools')).status,401);assert.equal((await request(`versions/${versionId}/download`,'POST')).status,401);
            assert.equal((await request('tools','GET',tech)).data.length,1);assert.equal((await request(`versions/${versionId}/download`,'POST',tech)).status,200);
            await pool.query("UPDATE catalog_tools SET visibility='admin' WHERE id=$1",[toolId]);
            assert.equal((await request('tools','GET',tech)).data.length,0);assert.equal((await request(`versions/${versionId}/download`,'POST',tech)).status,404);
        });
        await t.test('versões não sobrescrevem arquivos; exclusão lógica mantém dados',async()=>{
            assert.equal((await request(`tools/${toolId}/upload`,'POST',admin,{version:'1.0',fileName:'test.zip',size:22})).status,409);
            assert.equal((await request(`tools/${toolId}`,'DELETE',admin)).status,200);
            assert.equal((await request(`versions/${versionId}/download`,'POST',admin)).status,404);
            assert.equal((await pool.query('SELECT count(*)::integer AS n FROM catalog_versions')).rows[0].n,1);
        });
        await t.test('senhas devem diferir; troca revoga técnico e preserva administrador',async()=>{
            assert.equal((await request('credentials','POST',admin,{role:'technician',password:passwords.admin})).status,400);
            assert.equal((await request('credentials','POST',admin,{role:'technician',password:randomBytes(24).toString('hex')})).status,200);
            assert.equal((await request('session','GET',tech)).status,401);assert.equal((await request('session','GET',admin)).status,200);
            assert.match((await pool.query("SELECT password_hash FROM catalog_credentials WHERE role='admin'")).rows[0].password_hash,/^\$argon2id\$/);
        });
        await t.test('sessão expirada/logout/revogação invalidam sessão; Control cookie não autentica catálogo',async()=>{
            assert.equal((await request('session','GET',null,undefined,{Cookie:'sos_session=anything'})).status,401);
            const expires=await auth.login('admin',passwords.admin,'isolated-expiry');const actor=await auth.authenticate(expires.cookie);await pool.query('UPDATE catalog_sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1',[actor.tokenHash]);await assert.rejects(auth.authenticate(expires.cookie),/SESSION_EXPIRED/);
            const goodbye=await auth.login('admin',passwords.admin,'isolated-logout');await auth.logout(await auth.authenticate(goodbye.cookie));await assert.rejects(auth.authenticate(goodbye.cookie),/SESSION_EXPIRED/);
            assert.equal((await request('sessions/revoke','POST',admin,{role:'admin'})).status,200);assert.equal((await request('session','GET',admin)).status,401);
        });
        await t.test('rate limit persistido: 6ª tentativa bloqueada e fontes em hash',async()=>{
            for(let i=0;i<5;i++) await assert.rejects(auth.login('admin','bad','rate-test'),/INVALID_CREDENTIAL/);
            await assert.rejects(auth.login('admin','bad','rate-test'),/LOGIN_RATE_LIMITED/);
            const limits=(await pool.query('SELECT key_hash FROM catalog_login_limits')).rows;assert.ok(limits.every(r=>/^[a-f0-9]{64}$/.test(r.key_hash)));assert.ok(!JSON.stringify(limits).includes('rate-test'));
        });
    } finally { await new Promise(ok=>server.close(ok));await fixture.close(); }
});

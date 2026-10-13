import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../control/load.mjs';
const validation = await load('server/catalog/Validation.ts');
const { requireCatalogOrigin, requireCatalogCsrf, readCatalogBody } = await load('server/catalog/HttpApi.ts');
const { digest, clearCookie } = await load('server/catalog/Authentication.ts');
const { verifyHeader } = await load('server/catalog/Storage.ts');
const { CatalogService } = await load('server/catalog/CatalogService.ts');
const { catalogPool } = await load('server/catalog/Configuration.ts');
test('Neon sslmode=require mantém TLS verificado; flags inseguras são rejeitadas', async () => {
    const pool = catalogPool({CATALOG_DATABASE_URL:'postgresql://fixture:fixture@db.example.test/catalog?sslmode=require'});
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
    assert.ok(!pool.options.connectionString.includes('sslmode'));
    await pool.end();
    for (const query of ['sslmode=disable','sslmode=require&sslmode=disable','sslrootcert=local.pem']) {
        assert.throws(() => catalogPool({CATALOG_DATABASE_URL:'postgresql://fixture:fixture@db.example.test/catalog?'+query}),/DATABASE_TLS_URL_OPTIONS_FORBIDDEN/);
    }
});
test('matriz public/technicians/admin não concede Control nem escala privilégios', () => {
    for (const [role, expected] of [[null,[false,false,false]],['technician',[true,true,false]],['admin',[true,true,true]]]) {
        assert.deepEqual(['public','technicians','admin'].map(v => validation.canRead(v,role)), expected);
    }
    assert.equal(validation.canRead('technicians','operator'),false);
    assert.equal(validation.canRead('admin','technician'),false);
});
test('senha de exemplo, curta e com quebra de linha é rejeitada', () => {
    for (const value of ['sosmr1234','short','long-enough-password\n']) assert.throws(() => validation.validatePassword(value), /PASSWORD_POLICY/);
    validation.validatePassword('sufficiently-long-test-only');
});
test('payloads estritos: nenhum hash, URL, path, role estranho ou upload arbitrário', () => {
    for (const value of [{role:'operator',password:'a'},{role:'admin',password:'a',hash:'x'}]) assert.equal(validation.loginSchema.safeParse(value).success,false);
    for (const fileName of ['../installer.exe','script.ps1','run.cmd','a.exe.zip/evil','x.zip.exe\0']) assert.equal(validation.uploadSchema.safeParse({version:'1',size:20,fileName}).success,false);
    assert.equal(validation.uploadSchema.safeParse({version:'1',size:100*1024*1024+1,fileName:'a.exe'}).success,false);
    assert.equal(validation.uploadSchema.safeParse({version:'1',size:20,fileName:'a.exe',objectPath:'secret'}).success,false);
});
test('CSRF exige Origin exata e token da sessão correta', () => {
    assert.throws(() => requireCatalogOrigin({headers:{origin:'https://evil.test'}},'https://catalog.test'), /CSRF_REJECTED/);
    assert.throws(() => requireCatalogOrigin({headers:{}},'https://catalog.test'), /CSRF_REJECTED/);
    requireCatalogOrigin({headers:{origin:'https://catalog.test'}},'https://catalog.test');
    const actor={csrfHash:digest('one-session')};
    assert.throws(() => requireCatalogCsrf({headers:{'x-catalog-csrf':'another'}},actor), /CSRF_REJECTED/);
    requireCatalogCsrf({headers:{'x-catalog-csrf':'one-session'}},actor);
    assert.match(clearCookie,/HttpOnly; Secure; SameSite=Strict/); assert.match(clearCookie,/Path=\/api;/);
});
test('técnico é rejeitado antes de qualquer acesso de escrita ao banco/storage', async () => {
    const service = new CatalogService({ connect(){throw new Error('MUST_NOT_REACH_DB');} },{});
    for(const operation of ['addCategory','editCategory','createTool','editTool','upload','finalize','publish','remove','changePassword','revoke','history']) {
        await assert.rejects(service[operation]({role:'technician'},'invalid',{}), /ACCESS_DENIED/);
    }
});
test('formato de arquivo é verificado pelos bytes, não pela extensão somente', () => {
    assert.throws(() => verifyHeader(Buffer.from('not an installer'),'example.exe'), /FILE_FORMAT_INVALID/);
    verifyHeader(Buffer.from('504b0506'+'00'.repeat(18),'hex'),'empty.zip');
    verifyHeader(Buffer.from('d0cf11e0a1b11ae1','hex'),'a.msi');
    const exe=Buffer.alloc(128); exe.write('MZ');exe.writeUInt32LE(64,60);exe.write('PE\0\0',64);verifyHeader(exe,'a.exe');
});
test('Vercel body já interpretado e limite JSON também são verificados', async () => {
    assert.deepEqual(await readCatalogBody({headers:{'content-type':'application/json'},body:{role:'technician',password:'test'}}),{role:'technician',password:'test'});
    await assert.rejects(readCatalogBody({headers:{'content-type':'application/json'},body:{value:'x'.repeat(16384)}}),/PAYLOAD_TOO_LARGE/);
    await assert.rejects(readCatalogBody({headers:{'content-type':'text/plain'},body:{}}),/INVALID_INPUT/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes,randomUUID } from 'node:crypto';
import { load } from '../control/load.mjs';
import { postgresFixture } from '../integration/postgres-fixture.mjs';
const { migrateCatalogSql } = await load('server/catalog/Migrations.ts');
const { prepareLegacyImport,importLegacyCatalog,CatalogService,CatalogAuthentication,rotateCredential,digest } = await load('tests/catalog/entry.ts');
test('PostgreSQL descartável: migração de dados legados idempotente sem mudar schema', {skip:!process.env.CONTROL_TEST_POSTGRES_BIN},async t=>{
    // Local Windows disks can need >15s for the shutdown checkpoint; keep fsync enabled.
    const fixture=await postgresFixture(process.env.CONTROL_TEST_POSTGRES_BIN,{commandTimeout:120000,waitSeconds:90}),pool=fixture.createPool();
    const manifest={schemaVersion:1,release:'tools-v0.1.0',tools:[{id:'fixture',name:'Legado fixture',description:'Fixture não operacional',version:'1',type:'utility',assetName:'test.zip',requiresAdmin:false,sha256:'a'.repeat(64)}]};
    const release={tag_name:'tools-v0.1.0',draft:false,prerelease:false,assets:[{name:'test.zip',size:22,browser_download_url:'https://github.com/Kaique-Lacerda/centralsos/releases/download/tools-v0.1.0/test.zip'}]};
    let verifies=0;const verifier=async()=>{verifies++;};
    try {
        const sql=await readFile('server/catalog/migrations/001_catalog.sql','utf8');await migrateCatalogSql(pool,sql,true);
        const before=(await pool.query('SELECT checksum FROM catalog_schema_migrations')).rows[0].checksum;
        const entries=prepareLegacyImport(manifest,release);
        await t.test('dry-run não grava nem verifica arquivos',async()=>{const plan=await importLegacyCatalog(pool,entries,false,verifier);assert.equal(plan.entries[0].state,'pending-import');assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_tools')).rows[0].n,0);assert.equal(verifies,0);});
        await t.test('apply é idempotente e não publica/republica nem sobrescreve metadados',async()=>{
            await importLegacyCatalog(pool,entries,true,verifier);assert.equal(verifies,1);
            await pool.query('UPDATE catalog_tools SET name=$2 WHERE id=$1',[entries[0].toolId,'Nome alterado pelo administrador']);
            const rerun=await importLegacyCatalog(pool,entries,true,verifier);assert.equal(rerun.entries[0].state,'already-imported');assert.equal(verifies,1);
            assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_versions')).rows[0].n,1);
            assert.equal((await pool.query('SELECT published FROM catalog_versions')).rows[0].published,false);
            assert.equal((await pool.query('SELECT name FROM catalog_tools')).rows[0].name,'Nome alterado pelo administrador');
        });
        await t.test('cadastro manual exige mapping explícito e mapping ausente não cria duplicação',async()=>{
            const duplicate=prepareLegacyImport({...manifest,tools:[{...manifest.tools[0],id:'other'}]},release);
            duplicate[0].source='https://github.com/Kaique-Lacerda/centralsos/releases/download/tools-v0.1.0/other.zip';
            const category=(await pool.query('SELECT category_id FROM catalog_tools')).rows[0].category_id;
            const toolId=randomUUID();await pool.query(`INSERT INTO catalog_tools(id,name,description,category_id,type,compatibility,requires_admin,visibility) VALUES($1,'Manual','Fixture',$2,'Arquivo','Fixture',false,'technicians')`,[toolId,category]);
            const manualManifest={...manifest,tools:[{...manifest.tools[0],id:'manual',name:'Manual',assetName:'manual.zip'}]};
            const manualRelease={...release,assets:[{name:'manual.zip',size:22,browser_download_url:'https://github.com/Kaique-Lacerda/centralsos/releases/download/tools-v0.1.0/manual.zip'}]};
            await assert.rejects(importLegacyCatalog(pool,prepareLegacyImport(manualManifest,manualRelease),true,verifier),/LEGACY_MAPPING_REQUIRED/);
            const mapped=prepareLegacyImport(manualManifest,manualRelease,{manual:toolId});await importLegacyCatalog(pool,mapped,true,verifier);
            assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_tools WHERE name=\'Manual\'')).rows[0].n,1);
            await assert.rejects(importLegacyCatalog(pool,prepareLegacyImport(manualManifest,manualRelease,{manual:randomUUID()}),true,verifier),/LEGACY_MAPPING_TARGET_MISSING/);
        });
        await t.test('divergência e verificação falha geram rollback; removidos não são restaurados',async()=>{
            await assert.rejects(importLegacyCatalog(pool,[{...entries[0],sha256:'b'.repeat(64)}],true,verifier),/LEGACY_SOURCE_DIVERGENT/);
            const newManifest={...manifest,tools:[{...manifest.tools[0],id:'failure',name:'Fail',assetName:'fail.zip'}]},newRelease={...release,assets:[{name:'fail.zip',size:22,browser_download_url:'https://github.com/Kaique-Lacerda/centralsos/releases/download/tools-v0.1.0/fail.zip'}]};
            await assert.rejects(importLegacyCatalog(pool,prepareLegacyImport(newManifest,newRelease),true,async()=>{throw new Error('HASH_FAILED');}),/HASH_FAILED/);
            assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_tools WHERE name='Fail'")).rows[0].n,0);
        });
        await t.test('origem pública tem download autorizado, sem Blob; despublicar impede nova URL e técnico não edita categoria',async()=>{
            const password=randomBytes(24).toString('base64url'),db=await pool.connect();try{for(const role of ['admin','technician']) await rotateCredential(db,role,role==='admin'?password:randomBytes(24).toString('base64url'),{role:'admin',tokenHash:digest('fixture')});}finally{db.release();}
            const auth=new CatalogAuthentication(pool,randomBytes(32).toString('hex')),login=await auth.login('admin',password,'fixture');const admin=await auth.authenticate(login.cookie);
            const service=new CatalogService(pool,{download(){throw new Error('MUST_NOT_USE_BLOB_FOR_PUBLIC_GITHUB');}});
            const tech={...admin,role:'technician'};await assert.rejects(service.editCategory(tech,randomUUID(),{name:'No'}),/ACCESS_DENIED/);
            await assert.rejects(service.download(null,entries[0].versionId),/SESSION_REQUIRED/);
            await service.publish(admin,entries[0].versionId,true);const catalog=await service.tools(admin);assert.equal(catalog[0].versions[0].source.kind,'github-release');
            const download=await service.download(admin,entries[0].versionId);assert.equal(download.public,true);assert.equal(download.url,entries[0].source);assert.equal(download.expiresInSeconds,null);
            await service.publish(admin,entries[0].versionId,false);await assert.rejects(service.download(admin,entries[0].versionId),/DOWNLOAD_DENIED/);
            await service.remove(admin,entries[0].toolId);const repeat=await importLegacyCatalog(pool,entries,true,verifier);assert.equal(repeat.entries[0].state,'removed-preserved');
            assert.equal((await pool.query('SELECT checksum FROM catalog_schema_migrations')).rows[0].checksum,before);
        });
    } finally {await fixture.close();}
});

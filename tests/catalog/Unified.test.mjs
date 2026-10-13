import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { load } from '../control/load.mjs';
const { ManagedToolCard } = await load('src/apps/web/catalog/ManagedToolCard.tsx');
const { filterManagedTools, emptyManagedFilters } = await load('src/apps/web/catalog/ManagedFilters.tsx');
const { prepareLegacyImport, legacyIdentity } = await load('server/catalog/LegacyCatalogImport.ts');
const { githubAssetReference, catalogFileSource } = await load('server/catalog/FileSource.ts');
const session = {role:'technician',csrfToken:'unit-test-only',expiresAt:'2099-01-01T00:00:00Z'};
const tool = { id:'b401c034-6370-4924-b378-cac067a734ec',name:'Ferramenta de teste',description:'Descrição teste',categoryId:'a9d28c36-37db-4c2d-8bfe-b3f16c4b5870',categoryName:'Categoria',type:'Arquivo',compatibility:'Sem execução',tags:['suporte'],requiresAdmin:false,visibility:'technicians',
    versions:[{id:'498db006-b4ed-4f75-a0d1-11428459c035',version:'fixture',fileName:'test.zip',size:22,sha256:'a'.repeat(64),published:true,approved:true,verified:true,createdAt:'2026-01-01T00:00:00Z',source:{kind:'private-blob'}}] };
test('home monta hero e somente catálogo PostgreSQL; aliases redirecionam sem segunda listagem',async()=>{
    const home=await readFile('src/apps/web/PortalPages.tsx','utf8'),router=await readFile('src/apps/web/WebRouter.tsx','utf8');
    assert.match(home,/<PortalHero resource={client} \/><ManagedCatalogPage \/>/);
    assert.doesNotMatch(home,/getGitHubToolsCatalog|loadTools|<ToolCatalog/);
    assert.match(router,/path="catalog" element={<Navigate to="\/" replace \/>}/);
    assert.match(router,/path="tools" element={<Navigate to="\/#tools" replace \/>}/);
    assert.doesNotMatch(router,/ManagedCatalogPage/);
});
test('mesmo card/título/dados para técnico e admin; somente admin tem mutadores',()=>{
    const props={tool,session,busy:false,onAction:async()=>{},onRefresh:async()=>{},onEdit(){}};
    const tech=renderToStaticMarkup(createElement(ManagedToolCard,props));
    const admin=renderToStaticMarkup(createElement(ManagedToolCard,{...props,session:{...session,role:'admin'}}));
    for(const html of [tech,admin]) {assert.match(html,/Ferramenta de teste/);assert.match(html,/Baixar Ferramenta de teste/);assert.match(html,/Detalhes e versões/);}
    assert.doesNotMatch(tech,/Editar ferramenta|Enviar nova versão|Despublicar|Remover do catálogo/);
    for(const label of ['Editar ferramenta','Enviar nova versão','Despublicar','Remover do catálogo']) assert.ok(admin.includes(label));
});
test('aprovação e remoção usam confirmação explícita dentro do card sem bloquear navegador',async()=>{
    const card=await readFile('src/apps/web/catalog/ManagedToolCard.tsx','utf8');
    assert.doesNotMatch(card,/window\.confirm/);
    assert.match(card,/setConfirmation\(\{kind:'publish',versionId:version\.id/);
    assert.match(card,/session\.role === 'admin' && confirmation/);
    assert.match(card,/Confirmar publicação/);
    assert.match(card,/Confirmar remoção/);
    assert.match(card,/const selected=confirmation; setConfirmation\(null\)/);
});
test('busca e filtros usam somente dados do backend, em AND, sem alterar inventário',()=>{
    const other={...tool,id:'ba887788-6c42-4452-aa2e-a897e373517b',name:'Outro',versions:[]};const original=JSON.stringify([tool,other]);
    assert.equal(filterManagedTools([tool,other],{...emptyManagedFilters,search:'DESCRICAO',availability:'available',category:tool.categoryId,type:tool.type,compatibility:tool.compatibility}).length,1);
    assert.deepEqual(filterManagedTools([tool,other],{...emptyManagedFilters,availability:'unavailable'}),[other]);
    assert.equal(JSON.stringify([tool,other]),original);
});
const tag='tools-v0.1.0';
const fixture={id:'legacy-fixture',name:'Legado teste',description:'Fixture somente',version:'1',type:'utility',assetName:'test.zip',requiresAdmin:false,sha256:'a'.repeat(64)};
const manifest={schemaVersion:1,release:tag,tools:[fixture]};
const release={tag_name:tag,draft:false,prerelease:false,assets:[{name:'test.zip',size:22,browser_download_url:githubAssetReference(tag,'test.zip')}]};
test('planejamento legado preserva referência/hashes e identidade determinística; nenhum estado privado fictício',()=>{
    const first=prepareLegacyImport(manifest,release),second=prepareLegacyImport(manifest,release);
    assert.deepEqual(first,second);assert.equal(first[0].toolId,legacyIdentity('tool/legacy-fixture'));
    assert.equal(first[0].source,release.assets[0].browser_download_url);assert.equal(first[0].sha256,fixture.sha256);
    assert.equal(catalogFileSource(first[0].source).public,true);
    const html=renderToStaticMarkup(createElement(ManagedToolCard,{tool:{...tool,versions:[{...tool.versions[0],source:catalogFileSource(first[0].source)}]},session,busy:false,onAction:async()=>{},onRefresh:async()=>{},onEdit(){}}));
    assert.match(html,/Arquivo público no GitHub/);
});
test('recusa duplicações, source externa, draft/prerelease, tamanho divergente e mapping inválido',()=>{
    assert.throws(()=>prepareLegacyImport({...manifest,tools:[fixture,fixture]},release),/LEGACY_MANIFEST_INVALID/);
    assert.throws(()=>prepareLegacyImport(manifest,{...release,assets:[...release.assets,...release.assets]}),/LEGACY_ASSET_AMBIGUOUS_OR_INVALID/);
    assert.throws(()=>prepareLegacyImport(manifest,{...release,assets:[{...release.assets[0],browser_download_url:'https://evil.test/test.zip'}]}),/LEGACY_ASSET_AMBIGUOUS_OR_INVALID/);
    assert.throws(()=>prepareLegacyImport(manifest,{...release,draft:true}),/LEGACY_RELEASE_INVALID/);
    assert.throws(()=>prepareLegacyImport(manifest,{...release,prerelease:true}),/LEGACY_RELEASE_INVALID/);
    assert.throws(()=>prepareLegacyImport({...manifest,tools:[{...fixture,sizeBytes:23}]},release),/LEGACY_ASSET_AMBIGUOUS_OR_INVALID/);
    assert.throws(()=>prepareLegacyImport(manifest,release,{'unknown':'b401c034-6370-4924-b378-cac067a734ec'}),/LEGACY_MANIFEST_INVALID/);
    for(const source of ['https://evil.test/x.exe','https://github.com/Kaique-Lacerda/centralsos/releases/download/v0.1.0/test.exe',githubAssetReference(tag,'test.zip')+'?extra=1','catalog/../evil']) assert.throws(()=>catalogFileSource(source),/FILE_SOURCE_INVALID/);
});

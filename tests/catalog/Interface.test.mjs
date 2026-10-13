import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from '../control/load.mjs';
const { CatalogLogin } = await load('src/apps/web/catalog/CatalogLogin.tsx');
const { ToolEditor } = await load('src/apps/web/catalog/ToolEditor.tsx');
const { VersionUpload } = await load('src/apps/web/catalog/VersionUpload.tsx');
const session={role:'admin',csrfToken:'fixture-only-not-a-secret',expiresAt:'2099-01-01T00:00:00.000Z'};

test('login simples oferece dois níveis e exige autenticação sem Google/contas/acesso público', () => {
    const html=renderToStaticMarkup(createElement(CatalogLogin,{onLogin(){}}));
    assert.equal((html.match(/type="password"/g)??[]).length,1);
    assert.equal((html.match(/type="radio"/g)??[]).length,2);
    assert.match(html,/Técnico/);assert.match(html,/Administrador/);assert.doesNotMatch(html,/Consultar ferramentas públicas/);
    assert.doesNotMatch(html,/type="email"|Google|convite|recuperar senha/i);
});
test('edição preserva dados e oferece visibilidade explícita sem expor token', () => {
    const category={id:'0c1f0336-2d12-455f-90d3-285a6a231720',name:'Categoria de teste'};
    const tool={id:'84c5fceb-ddc6-4438-8a94-3c23a72f0149',name:'Ferramenta de teste',description:'Descrição existente',categoryId:category.id,type:'Arquivo',compatibility:'Windows',tags:['teste'],requiresAdmin:false,visibility:'technicians',versions:[]};
    const html=renderToStaticMarkup(createElement(ToolEditor,{session,categories:[category],tool,onDone:async()=>{},onCancel(){}}));
    assert.match(html,/value="Ferramenta de teste"/);assert.match(html,/Descrição existente/);assert.match(html,/value="technicians" selected=""/);
    assert.match(html,/Somente administrador/);assert.match(html,/Ou criar categoria/);assert.doesNotMatch(html,/fixture-only-not-a-secret/);
});
test('envio mostra formatos e limite real; versão não vem hardcoded nem publicação automática', () => {
    const html=renderToStaticMarkup(createElement(VersionUpload,{session,toolId:'84c5fceb-ddc6-4438-8a94-3c23a72f0149',onDone:async()=>{}}));
    assert.match(html,/accept="\.exe,\.msi,\.zip"/);assert.match(html,/100 MiB/);assert.match(html,/armazenamento privado/);
    assert.match(html,/Enviar e verificar/);assert.doesNotMatch(html,/value="0\.[12]\.0"|fixture-only-not-a-secret|Publicar automaticamente/);
});

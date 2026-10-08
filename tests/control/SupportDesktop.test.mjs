import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from './load.mjs';
const { createSupportAuth, createSupportDesktopApi } = await load('src/services/control/SupportDesktopBridge.ts');
const { supportControlRequestSchema, supportAuthViewSchema } = await load('packages/contracts/control/SupportDesktop.ts');
const { SupportAuthPanel } = await load('src/apps/support/SupportControlPage.tsx');
const origin = 'https://support.example.test';
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const view = { state:'signed_out', operatorName:null, expiresAt:null, comparisonCode:null, backendOrigin:origin, message:null, intervalSeconds:5, revocationPending:false };

test('bridge de auth só invoca comandos conhecidos e devolve estado sanitizado', async () => {
    const calls=[];
    const auth = createSupportAuth(async (command,args) => { calls.push({command,args}); return view; });
    for (const action of ['status','start','poll','complete','session','logout']) await auth[action]();
    assert.deepEqual(calls.map(c=>c.command), ['support_status','support_login_start','support_login_poll','support_login_complete','support_session','support_logout']);
    assert.deepEqual(calls[3].args,{confirmed:true});
    assert.doesNotMatch(JSON.stringify(calls),/deviceCode|codeVerifier|accessToken|Authorization|url/);
    await assert.rejects(createSupportAuth(async()=>({...view,accessToken:'secret'})).status());
    assert.equal(supportAuthViewSchema.safeParse({...view,deviceCode:'secret'}).success,false);
});
test('ControlApi usa dispatcher tipado, sem URL/header/credential no IPC', async () => {
    const calls=[];
    const api = createSupportDesktopApi(origin, async(command,args)=> {calls.push({command,args});return [];});
    assert.deepEqual(await api.devices(),[]); assert.deepEqual(await api.environments(),[]);
    assert.deepEqual(calls[0],{command:'support_control',args:{request:{operation:'devices'}}});
    assert.doesNotMatch(JSON.stringify(calls),/https|Authorization|headers|token/);
    await assert.rejects(api.device('../auth/native/start'));
    await assert.rejects(api.send(id,{type:'shell',payload:{},confirmed:true}));
    assert.equal(calls.length,2);
});
test('falhas nativas não repassam mensagens sensíveis do host', async () => {
    const api = createSupportDesktopApi(origin,async()=>{throw{code:'SESSION_EXPIRED',status:401,message:'Bearer secret'};});
    await assert.rejects(api.devices(),e=>e.code==='SESSION_EXPIRED' && !e.message.includes('secret'));
    const bad = createSupportDesktopApi(origin,async()=>({accessToken:'secret'}));
    await assert.rejects(bad.devices());
    for (const badOrigin of ['http://localhost','https://user:pass@host.test','https://host.test/path','https://host.test?q=1']) assert.throws(()=>createSupportDesktopApi(badOrigin));
});
test('IPC rejeita payload inválido e endpoints genéricos; command schema mantém whitelist', () => {
    for(const request of [{operation:'http_request',url:origin},{operation:'devices',headers:{}},{operation:'send',id,command:{type:'machine.refresh',payload:{path:'cmd.exe'},confirmed:false}}]) assert.equal(supportControlRequestSchema.safeParse(request).success,false);
});
test('estados de autenticação e revogação possuem UI real sem dados simulados', () => {
    const props={busy:false,error:'',start(){},complete(){},logout(){}};
    for(const [state,text] of [['unconfigured','Backend não configurado'],['signed_out','Entrar'],['awaiting_browser','Autorize no navegador'],['awaiting_identity','Confirmar identidade'],['login_expired','Login expirado'],['session_expired','Sessão expirada'],['unauthorized','Usuário sem autorização'],['unavailable','Backend indisponível']]) {
        const html=renderToStaticMarkup(createElement(SupportAuthPanel,{...props,view:{...view,state}}));
        assert.ok(html.includes(text),state); assert.doesNotMatch(html,/accessToken|deviceCode|codeVerifier|Authorization/);
    }
    const html=renderToStaticMarkup(createElement(SupportAuthPanel,{...props,view:{...view,revocationPending:true}}));
    assert.match(html,/revogação remota falhou/); assert.match(html,/até expiração/);
});
test('Support Tauri tem identidade, permissões e build separados sem Agent/Updater/admin', async () => {
    const conf=JSON.parse(await readFile('src-tauri-support/tauri.conf.json','utf8'));
    const caps=JSON.parse(await readFile('src-tauri-support/capabilities/default.json','utf8'));
    const cargo=await readFile('src-tauri-support/Cargo.toml','utf8');
    const manifest=await readFile('src-tauri-support/windows-app-manifest.xml','utf8');
    assert.equal(conf.identifier,'br.com.centralsos.support'); assert.equal(conf.productName,'CENTRAL SOS Suporte');
    assert.equal(conf.build.frontendDist,'../dist/support'); assert.equal(conf.build.devUrl,'http://localhost:1421');
    assert.equal(conf.bundle.createUpdaterArtifacts,false); assert.equal(conf.bundle.windows.nsis.installMode,'currentUser');
    assert.match(manifest,/level="asInvoker"/); assert.doesNotMatch(manifest,/requireAdministrator/);
    assert.match(manifest,/Microsoft.Windows.Common-Controls/);
    assert.doesNotMatch(cargo,/central-sos-(?:agent|link|core|session-helper)|plugin-updater|plugin-shell|plugin-http|plugin-opener/);
    assert.deepEqual(caps.permissions,['allow-support-status','allow-support-login-start','allow-support-login-poll','allow-support-login-complete','allow-support-session','allow-support-logout','allow-support-control']);
    assert.doesNotMatch(conf.app.security.csp,/https:|\*/);
    const client=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')); assert.equal(client.identifier,'br.com.centralsos.desktop'); assert.equal(client.version,'0.2.0');
});
test('host mantém HTTPS/TLS/limite durante leitura e não oferece HTTP genérico', async () => {
    const http=await readFile('src-tauri-support/src/http.rs','utf8');
    const main=await readFile('src-tauri-support/src/main.rs','utf8');
    assert.match(http,/https_only\(true\)/); assert.match(http,/redirect\(Policy::none\(\)\)/);
    assert.match(http,/reader\s*\.take\(limit as u64 \+ 1\)/); assert.match(http,/timeout\(Duration::from_secs\(12\)\)/);
    assert.doesNotMatch(http,/danger_accept_invalid|println!|log::|cookie_store/);
    assert.doesNotMatch(main,/http_request|#\[tauri::command\]\s*(?:async )?fn[^\n]*(?:url:|headers:)/);
});
test('dev Suporte exclui o build Rust do watcher Vite sem modificar os outros produtos', async () => {
    const { resolveConfig } = await import('vite');
    const support=await resolveConfig({mode:'support'},'serve');
    assert.deepEqual(support.server.watch.ignored,['**/src-tauri-support/**']);
    for(const mode of ['client','web']) assert.equal((await resolveConfig({mode},'serve')).server.watch?.ignored,undefined);
});

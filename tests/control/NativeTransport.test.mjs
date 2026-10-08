import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from './load.mjs';
const {createControlNativeTransport}=await load('src/services/control/ControlNativeTransport.ts');
const {createControlApi}=await load('src/services/control/ControlService.ts');
const origin='https://control.example.test';
const response=(request,values={})=>({status:200,url:request.url,redirected:false,body:'[]',...values});
test('transport: API lógica neutra usa adapter Rust sem tokens/cookies no TypeScript',async()=>{
    const calls=[],adapter=async request=>{calls.push(request);return response(request);};
    const api=createControlApi(createControlNativeTransport(origin,adapter));await api.devices();
    const r=calls[0];assert.equal(r.url,origin+'/api/control/devices');assert.equal(r.authentication,'operator');assert.equal(r.followRedirects,false);assert.equal(r.maxResponseBytes,2000000);assert.equal(r.timeoutMs,12000);assert.equal(r.headers.Authorization,undefined);assert.equal(r.headers.Cookie,undefined);assert.equal(r.headers.Origin,undefined);
    await api.pair('fixture','TERMINAL',null);assert.equal(calls[1].method,'POST');assert.equal(JSON.parse(calls[1].body).profile,'TERMINAL');
});
test('transport: somente origem HTTPS canônica sem path/credenciais/query/fragment',()=>{
    for(const value of ['http://control.example.test','https://user:pass@control.example.test','https://control.example.test/path','https://control.example.test/?token=a','https://control.example.test/#x','https://control.example.test/../','https://control.example.test/%2e%2e',' https://control.example.test','not-url']) assert.throws(()=>createControlNativeTransport(value,()=>{}));
    assert.equal(typeof createControlNativeTransport(origin+'/',()=>{}),'function');
});
test('transport: paths remotos arbitrários e segredo em query são recusados antes do adapter',async()=>{
    const transport=createControlNativeTransport(origin,()=>{throw Error('adapter must not run');});
    for(const path of ['https://evil.example','//evil.example','/devices?token=a','/devices/../pairing','/auth/native/authorize','/auth/native/start','/auth/native/status','/auth/native/complete','/devices%2f']) await assert.rejects(transport(path),error=>error.code==='INVALID_PATH');
});
test('transport: redirects e troca de URL são rejeitados',async()=>{
    for(const values of [{status:302},{redirected:true},{url:'https://evil.example/api/control/devices'}]) await assert.rejects(createControlNativeTransport(origin,async r=>response(r,values))('/devices'),error=>error.code==='REDIRECT_REJECTED');
});
for(const [status,code] of [[401,'SESSION_INVALID'],[403,'FORBIDDEN'],[429,'RATE_LIMITED']]) test(`transport: HTTP ${status} estruturado e mensagem não confiável descartada`,async()=>{
    await assert.rejects(createControlNativeTransport(origin,async r=>response(r,{status,body:JSON.stringify({error:'password=DO_NOT_LEAK',code:'evil-secret'})}))('/devices'),error=>{assert.equal(error.status,status);assert.equal(error.code,code);assert.ok(!error.message.includes('DO_NOT_LEAK'));return true;});
});
test('transport: sessão expirada tem erro próprio e respostas grandes/ilegíveis são recusadas',async()=>{
    await assert.rejects(createControlNativeTransport(origin,async r=>response(r,{status:401,body:'{"code":"SESSION_EXPIRED"}'}))('/devices'),error=>error.code==='SESSION_EXPIRED');
    await assert.rejects(createControlNativeTransport(origin,async r=>response(r,{body:'x'.repeat(2000001)}))('/devices'),error=>error.code==='RESPONSE_TOO_LARGE');
    await assert.rejects(createControlNativeTransport(origin,async r=>response(r,{body:'<html>login</html>'}))('/devices'),error=>error.code==='INVALID_RESPONSE');
    await assert.rejects(createControlNativeTransport(origin,async()=>{throw Error('token=DO_NOT_LEAK');})('/devices'),error=>error.code==='CONNECTION_FAILED'&&!error.message.includes('DO_NOT_LEAK'));
});
test('transport: timeout encerra espera mesmo se adapter não responder',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const request=createControlNativeTransport(origin,()=>new Promise(()=>{}))('/devices');
    t.mock.timers.tick(12000);await assert.rejects(request,error=>error.code==='TIMEOUT');
});
test('transport: nenhum armazenamento frontend, plugin, token provider ou fallback Browser',async()=>{
    const source=await readFile('src/services/control/ControlNativeTransport.ts','utf8');
    assert.doesNotMatch(source,/localStorage|sessionStorage|@tauri-apps|tokenProvider|credentials:\s*['"]include|\bfetch\(/);
});

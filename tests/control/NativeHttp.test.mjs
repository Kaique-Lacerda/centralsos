import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, nativeHeaders, origin, environmentId, denied, proofChallenge } from './native-fixture.mjs';
const prefix='/auth/native';
const cookie=(response,name)=>[].concat(response.headers['set-cookie']??[]).find(value=>value.startsWith(name+'='))?.split(';')[0];
const field=(html,name)=>new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];

test('HTTP native: navegador externo → confirmação HTML → resgate e logout',async()=>{
    const f=fixture(),verifier='a'.repeat(43);
    const started=await request(f,prefix+'/start',{method:'POST',headers:nativeHeaders,body:{protocolVersion:1,codeChallengeMethod:'S256',codeChallenge:proofChallenge(verifier)}});
    assert.equal(started.statusCode,200); assert.equal(started.headers['cache-control'],'no-store');
    const s=started.body,proof={transactionId:s.transactionId,deviceCode:s.deviceCode,codeVerifier:verifier};
    const authorize=await request(f,prefix+'/authorize?user_code='+s.userCode);
    assert.equal(authorize.statusCode,302); assert.match(authorize.headers.location,/^https:\/\/identity\.example\.test/);
    assert.ok(!authorize.headers.location.includes(s.deviceCode));
    const exchange=f.issue(authorize.headers.location);
    assert.match(authorize.headers['set-cookie'],/HttpOnly; Secure; SameSite=Lax; Path=\//);assert.ok(!authorize.headers['set-cookie'].includes('Domain='));
    const callback=await request(f,prefix+`/callback?state=${exchange.state}&code=${exchange.code}`,{headers:{cookie:cookie(authorize,'__Host-sos-native-oidc')}});
    assert.equal(callback.statusCode,303); assert.equal(callback.headers.location,'/api/control'+prefix+'/confirm?id='+s.transactionId);
    const grantCookie=cookie(callback,'__Host-sos-native-browser');
    f.users.get('operator-a').actor.name='<img src=x onerror=alert(1)>';
    const page=await request(f,prefix+'/confirm?id='+s.transactionId,{headers:{cookie:grantCookie}});
    assert.match(page.raw,/&lt;img/); assert.ok(!page.raw.includes('<img')); assert.match(page.raw,new RegExp(s.userCode));
    assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
    const confirmation={transactionId:s.transactionId,csrfToken:field(page.raw,'csrfToken'),userCode:s.userCode,confirmed:true};
    const rejected=await request(f,prefix+'/confirm',{method:'POST',headers:{'content-type':'application/json',cookie:grantCookie,origin:'https://evil.example'},body:confirmation});
    assert.equal(rejected.statusCode,403); assert.equal(rejected.body.code,'CSRF_REJECTED');
    const confirmed=await request(f,prefix+'/confirm',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie:grantCookie,origin},body:new URLSearchParams({...confirmation,confirmed:'on'}).toString()});
    assert.equal(confirmed.statusCode,200);
    const status=await request(f,prefix+'/status',{method:'POST',headers:nativeHeaders,body:proof});
    assert.equal(status.body.operator.subject,'operator-a');
    const completed=await request(f,prefix+'/complete',{method:'POST',headers:nativeHeaders,body:{...proof,expectedSubject:status.body.operator.subject}});
    assert.equal(completed.statusCode,200); assert.equal(completed.headers.location,undefined);
    const headers={...nativeHeaders,authorization:'Bearer '+completed.body.accessToken};
    assert.equal((await request(f,prefix+'/session',{headers})).body.scope,'control');
    assert.equal((await request(f,'/environments',{headers})).body.length,1);
    assert.equal((await request(f,prefix+'/logout',{method:'POST',headers})).body.revoked,true);
    assert.equal((await request(f,'/devices',{headers})).body.code,'SESSION_REVOKED');
});
test('HTTP native: nenhum cookie/Origin, credencial Agent ou token em query é aceito',async()=>{
    const f=fixture(), c=await f.credential(),headers={...nativeHeaders,authorization:'Bearer '+c.accessToken};
    for(const patch of [{cookie:'sos_session=browser'},{origin},{authorization:'Bearer '+'a'.repeat(43)},{'x-central-sos-client':'wrong'}]) {
        const r=await request(f,'/devices',{headers:{...headers,...patch}}); assert.ok([401,403].includes(r.statusCode));
    }
    const r=await request(f,prefix+'/session?access_token='+c.accessToken,{headers}); assert.equal(r.body.code,'INVALID_REQUEST');
    assert.equal((await request(f,'/devices?access_token='+c.accessToken,{headers})).body.code,'INVALID_REQUEST');
    const noCookie=await request(f,'/devices',{headers:{...nativeHeaders,cookie:'sos_session='+c.accessToken}}); assert.equal(noCookie.statusCode,403);
    assert.equal((await request(f,prefix+'/start',{method:'POST',headers:{...nativeHeaders,cookie:'sos_session=browser'},body:{}})).body.code,'NATIVE_CONTEXT_REQUIRED');
});
test('HTTP native: TLS real ou ingresso Vercel obrigatório, header livre não basta',async()=>{
    const f=fixture(), saved=process.env.VERCEL;
    try {
        delete process.env.VERCEL;
        const insecure=await request(f,prefix+'/start',{method:'POST',headers:{...nativeHeaders,'x-forwarded-proto':'https'},body:{},encrypted:false});
        assert.equal(insecure.body.code,'NATIVE_CONTEXT_REQUIRED');
        process.env.VERCEL='1';
        const secure=await request(f,prefix+'/start',{method:'POST',headers:{...nativeHeaders,'x-forwarded-proto':'https'},body:{protocolVersion:1,codeChallengeMethod:'S256',codeChallenge:'a'.repeat(43)},encrypted:false}); assert.equal(secure.statusCode,200);
        const http=await request(f,prefix+'/start',{method:'POST',headers:{...nativeHeaders,'x-forwarded-proto':'http'},body:{},encrypted:false}); assert.equal(http.statusCode,403);
    } finally { if(saved===undefined) delete process.env.VERCEL;else process.env.VERCEL=saved; }
});
test('HTTP native: limite de payload, JSON inválido, métodos, duplicatas e open redirect',async()=>{
    const f=fixture();
    for(const [body,status] of [['{broken',400],[{padding:'x'.repeat(16385)},413]]) assert.equal((await request(f,prefix+'/start',{method:'POST',headers:nativeHeaders,body})).statusCode,status);
    assert.equal((await request(f,prefix+'/start',{headers:nativeHeaders})).statusCode,405);
    assert.equal((await request(f,prefix+'/authorize?user_code=0000-0000-0000&redirect=https://evil.example')).statusCode,400);
    assert.equal((await request(f,prefix+'/authorize?user_code=a&user_code=b')).statusCode,400);
    assert.equal((await request(f,prefix+'/confirm',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:'confirmed=on&confirmed=on'})).statusCode,400);
    const cors=await request(f,prefix+'/start',{method:'OPTIONS',headers:{origin:'https://evil.example'}});assert.ok(cors.statusCode>=400);assert.equal(cors.headers['access-control-allow-origin'],undefined);
});
test('HTTP native: confirmações de transações distintas não podem trocar identidades',async()=>{
    const f=fixture(), a=await f.start(), b=await f.start(), ba=await f.browser(a),bb=await f.browser(b);
    await assert.rejects(f.auth.confirm(ba.input,bb.grant.browser),denied('IDENTITY_MISMATCH'));
});
test('HTTP native: início limitado por peer, erros sem segredos e Retry-After explícito',async()=>{
    const f=fixture();
    for(let i=0;i<5;i++) assert.equal((await request(f,prefix+'/start',{method:'POST',headers:nativeHeaders,body:{protocolVersion:1,codeChallengeMethod:'S256',codeChallenge:'a'.repeat(43)}})).statusCode,200);
    const r=await request(f,prefix+'/start',{method:'POST',headers:nativeHeaders,body:{}});assert.equal(r.statusCode,429);assert.equal(r.headers['retry-after'],'60');assert.ok(!r.raw.includes(f.config.clientSecret));
});
test('HTTP: login/cookie Web preservados, CSRF e native Bearer sem fallback',async()=>{
    const f=fixture(), login=await request(f,'/auth/login'),exchange=f.issue(login.headers.location);
    assert.equal(login.statusCode,302);
    const callback=await request(f,`/auth/callback?code=${exchange.code}&state=${exchange.state}`,{headers:{cookie:cookie(login,'sos_oidc')}});
    assert.equal(callback.headers.location,'/control');
    const browserCookie=cookie(callback,'sos_session');
    assert.equal((await request(f,'/environments',{headers:{cookie:browserCookie}})).body.length,1);
    assert.equal((await request(f,'/environments',{headers:{...nativeHeaders,cookie:browserCookie}})).statusCode,403);
    const body={environmentId,profile:'TERMINAL',serverDeviceId:null};
    assert.equal((await request(f,'/pairing',{method:'POST',headers:{cookie:browserCookie},body})).statusCode,403);
    assert.equal((await request(f,'/pairing',{method:'POST',headers:{cookie:browserCookie,origin},body})).statusCode,200);
    const mixed=await request(f,'/devices',{headers:{cookie:browserCookie,...nativeHeaders,authorization:'Bearer '+'a'.repeat(43)}});assert.equal(mixed.statusCode,403);
    assert.equal((await request(f,prefix+'/session',{headers:{...nativeHeaders,cookie:browserCookie}})).statusCode,403);
});
test('HTTP: falha interna não vaza exceção nem dados de requisição nos logs',async()=>{
    const f=fixture({repositoryFactory:()=>({transaction:async()=>{throw Error('privateCredential_DO_NOT_LEAK');}})});
    const logs=[], saved=console.error;console.error=entry=>logs.push(entry);
    try { const r=await request(f,prefix+'/session',{headers:{...nativeHeaders,authorization:'Bearer sos_operator_'+'x'.repeat(43)}});assert.equal(r.statusCode,503);assert.ok(!r.raw.includes('DO_NOT_LEAK'));assert.ok(!JSON.stringify(logs).includes('DO_NOT_LEAK')); }
    finally {console.error=saved;}
});

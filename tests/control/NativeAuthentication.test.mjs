import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, denied, companyId, environmentId } from './native-fixture.mjs';

test('native: OIDC assinado, PKCE, nonce, confirmação explícita e resgate por posse', async () => {
    const f=fixture(), login=await f.start();
    assert.equal((await f.auth.status(login.proof)).state,'pending');
    await assert.rejects(f.auth.complete({...login.proof,expectedSubject:'operator-a'}),denied('CONFIRMATION_REQUIRED'));
    const b=await f.approve(login), response=await f.auth.complete({...login.proof,expectedSubject:'operator-a'});
    assert.match(response.accessToken,/^sos_operator_[\w-]{43}$/); assert.equal(response.scope,'control');
    assert.equal((await f.auth.authenticate(response.accessToken)).actor.id,'operator-a');
    const persisted=JSON.stringify(f.repo.state);
    for (const secret of [response.accessToken,login.started.deviceCode,login.proof.codeVerifier,b.grant.browser,b.confirmation.csrf,f.config.clientSecret]) assert.ok(!persisted.includes(secret));
    assert.equal(f.repo.state.transactions[0].oidc.verifierCipher,'');
    assert.ok(!login.started.authorizationUrl.includes(login.started.deviceCode));
});
test('native: IDs inválidos, campos extras e desafio/método inválidos são recusados', async () => {
    const f=fixture(), l=await f.start();
    await assert.rejects(f.auth.status({...l.proof,transactionId:'not-an-id'}),denied('INVALID_REQUEST'));
    await assert.rejects(f.auth.status({...l.proof,transactionId:'945493f5-23e7-4229-a996-4ba2ca784c86'}),denied('INVALID_TRANSACTION'));
    for (const patch of [{protocolVersion:2},{codeChallengeMethod:'plain'},{codeChallenge:'short'},{redirectUri:'https://evil.example'}]) await assert.rejects(f.auth.start({protocolVersion:1,codeChallengeMethod:'S256',codeChallenge:'a'.repeat(43),...patch}),denied('INVALID_REQUEST'));
});
test('native: transação expirada, consumida e replay não emitem segunda credencial', async () => {
    const f=fixture(), l=await f.start(); f.advance(300001);
    await assert.rejects(f.auth.status(l.proof),denied('TRANSACTION_EXPIRED'));
    const ready=await f.start(); await f.approve(ready); const input={...ready.proof,expectedSubject:'operator-a'};
    await f.auth.complete(input); await assert.rejects(f.auth.complete(input),denied('TRANSACTION_CONSUMED'));
    await assert.rejects(f.auth.status(ready.proof),denied('TRANSACTION_CONSUMED'));
    assert.equal(f.repo.state.sessions.length,1);
});
test('native: conhecer ID/código de conferência não substitui deviceCode nem S256', async () => {
    const f=fixture(), l=await f.start();
    await assert.rejects(f.auth.status({...l.proof,deviceCode:'a'.repeat(43)}),denied('PROOF_INVALID'));
    await assert.rejects(f.auth.status({...l.proof,codeVerifier:'b'.repeat(43)}),denied('PROOF_INVALID'));
    assert.equal(f.repo.state.transactions[0].failures,2);
});
test('native: confirmação exige identidade, cookie da transação, CSRF e checkbox', async () => {
    const f=fixture(), l=await f.start(), b=await f.browser(l);
    await assert.rejects(f.auth.confirm({...b.input,confirmed:false},b.grant.browser),denied('INVALID_REQUEST'));
    await assert.rejects(f.auth.confirm(b.input,'a'.repeat(43)),denied('IDENTITY_MISMATCH'));
    await assert.rejects(f.auth.confirm({...b.input,csrfToken:'a'.repeat(43)},b.grant.browser),denied('CSRF_REJECTED'));
    await assert.rejects(f.auth.confirm({...b.input,userCode:'0000-0000-0000'},b.grant.browser),denied('CONFIRMATION_REQUIRED'));
    await f.auth.confirm(b.input,b.grant.browser);
    await assert.rejects(f.auth.complete({...l.proof,expectedSubject:'someone-else'}),denied('IDENTITY_MISMATCH'));
    await assert.rejects(f.auth.confirm(b.input,b.grant.browser),denied('CONFIRMATION_REQUIRED'));
});
test('native: state, vínculo de navegador e callback de uso único são verificados', async () => {
    const f=fixture(), l=await f.start(), a=await f.auth.authorize(l.started.userCode), code=f.issue(a.url);
    await assert.rejects(f.auth.callback('b'.repeat(43),code.code,a.browser),denied('INVALID_TRANSACTION'));
    await assert.rejects(f.auth.callback(code.state,code.code,'c'.repeat(43)),denied('PROOF_INVALID'));
    await f.auth.callback(code.state,code.code,a.browser);
    await assert.rejects(f.auth.callback(code.state,code.code,a.browser),denied('PROOF_INVALID'));
    await assert.rejects(f.auth.authorize(l.started.userCode),denied('TRANSACTION_CONSUMED'));
});
for (const [label,overrides] of [['nonce',{nonce:'wrong'}],['issuer',{iss:'https://wrong.example'}],['audience',{aud:'wrong'}],['expiration',{exp:1}],['assinatura',{breakSignature:true}],['exp ausente',{exp:undefined}]]) test(`native: JWT real com ${label} inválido é recusado`,async()=>{
    const f=fixture(),l=await f.start(); await assert.rejects(f.browser(l,'operator-a',overrides),denied('PROOF_INVALID'));
    assert.equal(f.repo.state.sessions.length,0);
});
test('native: usuário desabilitado ou sem membership não obtém sessão', async () => {
    const f=fixture(), l=await f.start(); f.users.get('operator-a').enabled=false;
    await assert.rejects(f.browser(l),denied('PROOF_INVALID'));
    f.users.get('operator-a').enabled=true; f.users.get('operator-a').actor.memberships=[];
    await assert.rejects(f.browser(await f.start()),denied('MEMBERSHIP_REQUIRED'));
});
test('native: revalida usuário e memberships a cada operação e logout permanece disponível', async () => {
    const f=fixture(), c=await f.credential(); f.users.get('operator-a').enabled=false;
    await assert.rejects(f.auth.authenticate(c.accessToken),denied('OPERATOR_DISABLED'));
    f.users.get('operator-a').enabled=true; f.users.get('operator-a').actor.memberships=[];
    await assert.rejects(f.auth.authenticate(c.accessToken),denied('MEMBERSHIP_REQUIRED'));
    await f.auth.logout(c.accessToken); await assert.rejects(f.auth.authenticate(c.accessToken),denied('SESSION_REVOKED'));
});
test('native: usuário desabilitado após confirmação não pode concluir', async () => {
    const f=fixture(),l=await f.start(); await f.approve(l); f.users.get('operator-a').enabled=false;
    await assert.rejects(f.auth.complete({...l.proof,expectedSubject:'operator-a'}),denied('OPERATOR_DISABLED'));
});
test('native: expiração durante lookup de usuário também impede emissão',async()=>{
    const f=fixture(),l=await f.start();await f.approve(l);
    const transaction=f.repo.transaction.bind(f.repo);
    f.repo.transaction=work=>transaction(async store=>{
        const actor=store.actor;store.actor=async subject=>{const result=await actor(subject);f.advance(300001);return result;};
        return work(store);
    });
    await assert.rejects(f.auth.complete({...l.proof,expectedSubject:'operator-a'}),denied('TRANSACTION_EXPIRED'));
    assert.equal(f.repo.state.sessions.length,0);
});
test('native: expiração de sessão é estruturada, sem renovação silenciosa', async () => {
    const f=fixture(), c=await f.credential(); f.advance(8*3600000+1);
    await assert.rejects(f.auth.authenticate(c.accessToken),denied('SESSION_EXPIRED'));
});
test('native: credenciais Agent e cookies de navegador não autenticam operador', async () => {
    const f=fixture();
    for (const token of ['a'.repeat(43),'sos_session='+'b'.repeat(43),'Bearer '+'c'.repeat(43),'sos_operator_'+'d'.repeat(43)]) await assert.rejects(f.auth.authenticate(token),denied('SESSION_INVALID'));
});
test('native: viewer/operator/admin e isolamento de empresa permanecem no ControlBackend',async()=>{
    const f=fixture(),c=await f.credential();
    const admin=(await f.auth.authenticate(c.accessToken)).actor;
    const paired=await f.backend.pair(admin,environmentId,'TERMINAL',null);
    const versions={appVersion:'0.2.0',agentVersion:'0.1.0',coreVersion:'0.1.0',protocolVersion:1};
    const device=await f.backend.enroll({pairingCode:paired.code,fingerprint:'a'.repeat(64),hostname:'TEST',profile:'TERMINAL',...versions,osVersion:null,architecture:'x64'});
    await assert.rejects(f.auth.authenticate(device.credential),denied('SESSION_INVALID'));
    await assert.rejects(f.backend.poll(c.accessToken),/não autorizado/);
    await f.backend.heartbeat(device.credential,{deviceId:device.deviceId,timestamp:new Date(f.now()).toISOString(),hostname:'TEST',profile:'TERMINAL',...versions,osVersion:null,uptime:1,localIp:null,healthSummary:'ok'});
    assert.deepEqual(await f.backend.poll(device.credential),[]);
    for (const role of ['viewer','operator','admin']) {
        f.users.get('operator-a').actor.memberships=[{companyId,role}]; const {actor}=await f.auth.authenticate(c.accessToken);
        assert.equal((await f.backend.list(actor)).environments.length,1);
        if (role!=='admin') await assert.rejects(f.backend.pair(actor,environmentId,'TERMINAL',null),/não autorizado/);
        else assert.ok((await f.backend.pair(actor,environmentId,'TERMINAL',null)).code);
        if(role==='viewer') await assert.rejects(f.backend.send(actor,device.deviceId,{type:'machine.refresh',payload:{}}),/não autorizado/);
        else assert.equal((await f.backend.send(actor,device.deviceId,{type:'machine.refresh',payload:{}})).type,'machine.refresh');
    }
    f.users.get('operator-a').actor.memberships=[{companyId:'outsider',role:'admin'}]; const {actor}=await f.auth.authenticate(c.accessToken);
    assert.deepEqual((await f.backend.list(actor)).environments,[]);
    await assert.rejects(f.backend.pair(actor,environmentId,'TERMINAL',null),/autorizado/);
});
test('native: limites de tentativas sobrevivem instâncias e prova válida não desbloqueia',async()=>{
    const f=fixture(),l=await f.start();
    for(let i=0;i<5;i++) await assert.rejects(f.makeAuth().status({...l.proof,codeVerifier:'a'.repeat(43)}),denied('PROOF_INVALID'));
    await assert.rejects(f.auth.status(l.proof),denied('RATE_LIMITED'));
    for(let i=0;i<5;i++) await f.makeAuth().limit('192.0.2.1','start',5);
    await assert.rejects(f.auth.limit('192.0.2.1','start',5),denied('RATE_LIMITED'));
    assert.ok(!JSON.stringify(f.repo.state.limits).includes('192.0.2.1'));
    f.advance(60000); await f.auth.limit('192.0.2.1','start',5);
});
test('native: polling excessivo é recusado e consulta posterior retorna identidade aprovada',async()=>{
    const f=fixture(),l=await f.start(); await f.auth.status(l.proof);
    await assert.rejects(f.auth.status(l.proof),denied('RATE_LIMITED'));
    await f.approve(l); f.advance(5000);
    assert.equal((await f.auth.status(l.proof)).operator.subject,'operator-a');
});
test('native: duas instâncias concluem simultaneamente; exatamente uma emite sessão',async()=>{
    const f=fixture(),l=await f.start(); await f.approve(l); const input={...l.proof,expectedSubject:'operator-a'};
    const results=await Promise.allSettled([f.auth.complete(input),f.makeAuth().complete(input)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'TRANSACTION_CONSUMED');
    assert.equal(f.repo.state.sessions.length,1);
});
test('native: sexta sessão revoga a mais antiga, sem armazenar token em claro',async()=>{
    const f=fixture(),tokens=[];
    for(let i=0;i<6;i++){ tokens.push((await f.credential()).accessToken); f.advance(1); }
    await assert.rejects(f.auth.authenticate(tokens[0]),denied('SESSION_REVOKED'));
    assert.equal((await f.auth.authenticate(tokens[5])).actor.id,'operator-a');
    assert.equal(f.repo.state.sessions.filter(s=>!s.revoked).length,5);
});
test('native: indisponibilidade do PostgreSQL falha fechada e não vaza mensagem interna',async()=>{
    const f=fixture({repositoryFactory:()=>({transaction:async()=>{throw new Error('password=DO_NOT_LEAK');}})});
    await assert.rejects(f.start(),error=>{assert.equal(error.code,'BACKEND_UNAVAILABLE');assert.ok(!error.message.includes('DO_NOT_LEAK'));return true;});
});

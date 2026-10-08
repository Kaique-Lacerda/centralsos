import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PostgresNativeAuthRepository, emptyNativeState } from './native-fixture.mjs';
function database({failAt,missing=false}={}) {
    const calls=[];let released=false;
    const client={query:async(sql,values)=>{
        calls.push({sql,values});if(sql===failAt) throw Error('database private failure');
        if(sql.includes('FOR UPDATE')) return {rows:missing?[]:[{state:emptyNativeState()}]};
        if(sql.includes('control_users')) return {rows:[{subject:'subject',display_name:'Fixture'}]};
        if(sql.includes('control_memberships')) return {rows:[{companyId:'company',role:'viewer'}]};
        return {rows:[]};
    },release(){released=true;}};
    return {calls,pool:{connect:async()=>client},released:()=>released};
}
test('PG adapter: lock e SELECT FOR UPDATE precedem leitura/consumo/commit',async()=>{
    const d=database(),repo=new PostgresNativeAuthRepository(d.pool);
    const actor=await repo.transaction(async store=>{store.state.audit.push({timestamp:1,subject:'subject',event:'logout',outcome:'REVOKED'});return store.actor('subject');});
    assert.equal(actor.memberships[0].role,'viewer');
    const sql=d.calls.map(c=>c.sql);assert.equal(sql[0],'BEGIN');assert.match(sql[1],/pg_advisory_xact_lock/);assert.match(sql[2],/FOR UPDATE/);assert.match(sql.at(-2),/UPDATE control_native_auth_state/);assert.equal(sql.at(-1),'COMMIT');assert.equal(d.released(),true);
    assert.match(sql[3],/enabled=true/);assert.deepEqual(d.calls[3].values,['subject']);
});
test('PG adapter: falha e migração ausente geram rollback/release sem COMMIT',async()=>{
    for(const configuration of [{failAt:'SELECT state FROM control_native_auth_state WHERE id=1 FOR UPDATE'},{missing:true}]){
        const d=database(configuration);await assert.rejects(new PostgresNativeAuthRepository(d.pool).transaction(async()=>{}));
        assert.equal(d.calls.at(-1).sql,'ROLLBACK');assert.ok(!d.calls.some(c=>c.sql==='COMMIT'));assert.equal(d.released(),true);
    }
});
test('PG adapter: falha de conexão não usa armazenamento em memória',async()=>{
    await assert.rejects(new PostgresNativeAuthRepository({connect:async()=>{throw Error('offline');}}).transaction(async()=>{}),/offline/);
});
test('migration incremental: nenhuma reescrita das tabelas de usuários/Agent/domínio',async()=>{
    const migration=await readFile('server/control/migrations/002_support_native_auth.sql','utf8');
    assert.match(migration,/CREATE TABLE control_native_auth_state/);assert.match(migration,/BEGIN/);assert.match(migration,/COMMIT/);assert.doesNotMatch(migration,/DROP|TRUNCATE|ALTER TABLE control_users|central_sos_control_state/);
});

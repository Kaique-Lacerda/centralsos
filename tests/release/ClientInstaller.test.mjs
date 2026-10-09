import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, link, lstat, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { components, inspectExecutable, readExecutable, sha256, validateEmbeddedPackage, clientImageForNsis } from '../../scripts/client-package.mjs';
import { buildCompanions, stageExecutable, stageBundledClient, validatePrepared } from '../../scripts/client-bundle.mjs';

// Minimal PE resource fixture. Never executed and never used for product staging.
function pe(level) {
  const bytes = Buffer.alloc(4096); bytes.write('MZ'); bytes.writeUInt32LE(0x80,0x3c);
  bytes.write('PE\0\0',0x80); bytes.writeUInt16LE(0x8664,0x84); bytes.writeUInt16LE(1,0x86);
  bytes.writeUInt16LE(240,0x94); const optional=0x98;
  bytes.writeUInt16LE(0x20b,optional); bytes.writeUInt16LE(2,optional+68);
  bytes.writeUInt32LE(0x1000,optional+128); bytes.writeUInt32LE(0x800,optional+132);
  const section=optional+240; bytes.writeUInt32LE(0x1000,section+12); bytes.writeUInt32LE(0x800,section+16); bytes.writeUInt32LE(0x400,section+20);
  for (const [offset,id,target] of [[0,24,0x80000020],[0x20,1,0x80000040],[0x40,1033,0x60]]) {
    bytes.writeUInt16LE(1,0x400+offset+14); bytes.writeUInt32LE(id,0x400+offset+16); bytes.writeUInt32LE(target,0x400+offset+20);
  }
  const xml=`<assembly><requestedExecutionLevel level="${level}" uiAccess="false" /></assembly>`;
  bytes.writeUInt32LE(0x1080,0x460); bytes.writeUInt32LE(Buffer.byteLength(xml),0x464); bytes.write(xml,0x480);
  return bytes;
}
function packaged() {
  const images=Object.fromEntries(components.map((component,index)=>{ const bytes=pe(component.level); bytes[0x900]=index; return [component.name,bytes]; }));
  const manifest={files:components.map(component=>({name:component.name,...inspectExecutable(images[component.name],component.level)}))};
  const installer=Buffer.concat([Buffer.from('MZNullsoftInst'),...Object.values(images)]);
  return {images,manifest,installer};
}
test('pacote contém exatamente os executáveis validados; MSI não é distribuído', async()=> {
  const {images,manifest,installer}=packaged(); assert.equal(validateEmbeddedPackage(installer,images,manifest).verified,true);
  const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'));
  assert.deepEqual(config.bundle.targets,['nsis']); assert.equal(config.bundle.windows.nsis.installMode,'perMachine');
  assert.equal(config.bundle.windows.nsis.compression,'none'); assert.equal(config.bundle.windows.allowDowngrades,false);
  assert.equal(config.bundle.windows.webviewInstallMode.type,'skip'); assert.equal(config.version,'0.2.0');
});
test('PE x64 tem RT_MANIFEST real: Cliente elevado, Agent/Helper asInvoker',()=> {
  for(const component of components) assert.equal(inspectExecutable(pe(component.level),component.level).manifestLevel,component.level);
  assert.throws(()=>inspectExecutable(pe('requireAdministrator'),'asInvoker'));
  const bytes=pe('asInvoker'); bytes.writeUInt32LE(0,0x98+128); assert.throws(()=>inspectExecutable(bytes,'asInvoker'));
  bytes.write('<requestedExecutionLevel level="asInvoker" uiAccess="false" />',0x700); assert.throws(()=>inspectExecutable(bytes,'asInvoker'));
});
test('arquitetura incorreta, PE truncado, subsistema console e uiAccess são rejeitados',()=> {
  const wrong=pe('asInvoker'); wrong.writeUInt16LE(0x14c,0x84); assert.throws(()=>inspectExecutable(wrong,'asInvoker'));
  assert.throws(()=>inspectExecutable(pe('asInvoker').subarray(0,256),'asInvoker'));
  const console=pe('asInvoker'); console.writeUInt16LE(3,0x98+68); assert.throws(()=>inspectExecutable(console,'asInvoker'));
  const access=pe('asInvoker'); access.write('true ',0x480+access.subarray(0x480).toString().indexOf('false')); assert.throws(()=>inspectExecutable(access,'asInvoker'));
});
test('NSIS incompleto ou com um executável divergente é recusado',()=> {
  const {images,manifest,installer}=packaged();
  assert.throws(()=>validateEmbeddedPackage(installer.subarray(0,6000),images,manifest),/PAYLOAD/);
  const changed=Buffer.from(installer); changed[changed.length-1]=1; assert.throws(()=>validateEmbeddedPackage(changed,images,manifest),/PAYLOAD/);
  manifest.files[0].sha256='0'.repeat(64); assert.throws(()=>validateEmbeddedPackage(installer,images,manifest),/PAYLOAD/);
});
test('build Agent/Helper é release locked x64 isolado; falha impede continuar',()=> {
  const calls=[]; buildCompanions('fixture',{CARGO_TARGET_DIR:'isolated'},(exe,args,root,env)=>calls.push({exe,args,root,env}));
  assert.equal(calls.length,2); for(const call of calls) { assert.equal(call.exe,'cargo'); assert.deepEqual(call.args.slice(0,5),['build','--locked','--release','--target','x86_64-pc-windows-msvc']); assert.equal(call.env.CARGO_TARGET_DIR,'isolated'); }
  let count=0; assert.throws(()=>buildCompanions('fixture',{},()=>{count++; throw Error('build failed');})); assert.equal(count,1);
  count=0; assert.throws(()=>buildCompanions('fixture',{},()=>{if(++count===2) throw Error('helper failed');})); assert.equal(count,2);
});
test('staging antigo, incompleto, debug ou de outro source é recusado',()=> {
  const files=components.slice(1).map(c=>({name:c.name,destination:c.destination,manifestLevel:c.level,architecture:'x64',sha256:sha256(Buffer.from(c.name))}));
  const prepared={version:'0.2.0',target:'x86_64-pc-windows-msvc',fingerprint:'fresh',stage:'stage-Test01',files};
  validatePrepared(prepared,'0.2.0','fresh');
  for(const invalid of [{...prepared,version:'0.1.0'},{...prepared,target:'debug'},{...prepared,fingerprint:'stale'},{...prepared,files:files.slice(0,1)},{...prepared,files:[files[0],files[0]]}]) assert.throws(()=>validatePrepared(invalid,'0.2.0','fresh'));
});
test('hardlink de saída Cargo é copiado; staging mantém arquivo independente sem relaxar policy',async()=> {
  const parent=resolve('.installer-build'); await mkdir(parent,{recursive:true}); const dir=await mkdtemp(join(parent,'test-'));
  assert.ok(!relative(parent,dir).startsWith('..'));
  try {
    const source=join(dir,'cargo.exe'), alias=join(dir,'deps.exe'), destination=join(dir,'stage.exe');
    await writeFile(source,pe('asInvoker')); await link(source,alias);
    assert.equal((await lstat(source)).nlink,2); await assert.rejects(readExecutable(source,'asInvoker'),/IMAGE_INVALID/);
    const staged=await stageExecutable(source,destination,'asInvoker'); assert.equal((await lstat(destination)).nlink,1);
    assert.equal(staged.sha256,sha256(pe('asInvoker'))); await assert.rejects(stageExecutable(source,destination,'asInvoker'),/exist/i);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('Cliente é selado somente após patch NSIS; segundo passe idêntico é seguro e divergência falha',async()=> {
  const parent=resolve('.installer-build'); await mkdir(parent,{recursive:true}); const dir=await mkdtemp(join(parent,'test-'));
  assert.ok(!relative(parent,dir).startsWith('..'));
  try {
    const source=join(dir,'client.exe'), destination=join(dir,'sealed.exe'); const bytes=pe('requireAdministrator');
    bytes.write('__TAURI_BUNDLE_TYPE_VAR_UNK',0xa00); await writeFile(source,bytes);
    await assert.rejects(stageBundledClient(source,destination),/CLIENT_NOT_BUNDLED/);
    bytes.write('__TAURI_BUNDLE_TYPE_VAR_NSS',0xa00); await writeFile(source,bytes);
    const sealed=await stageBundledClient(source,destination); assert.equal(sealed.sha256,sha256(bytes));
    assert.deepEqual(await stageBundledClient(source,destination),sealed);
    bytes[0xb00]=1; await writeFile(source,bytes); await assert.rejects(stageBundledClient(source,destination),/STAGE_CHANGED/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('hooks usam callback MUI e selagem no compilador; não duplicam onUserAbort do template',async()=> {
  const hooks=await readFile('src-tauri/windows/client-agent-hooks.nsh','utf8');
  assert.match(hooks,/!define MUI_CUSTOMFUNCTION_ABORT SOSRollback/); assert.doesNotMatch(hooks,/Function \.onUserAbort/);
  const seal=hooks.indexOf('!system'); const embed=hooks.indexOf('payload\\package-files.nsh');
  assert.ok(seal>0&&embed>seal); assert.match(hooks,/seal.*SOS_BUILD_ROOT.*= 0/);
  const script=await readFile('scripts/client-bundle.mjs','utf8');
  assert.match(script,/export async function sealClient/); assert.match(script,/INSTALLER_CLIENT_NOT_BUNDLED/);
});
test('inspeção aceita somente a restauração exata do marcador Tauri, sem modificar o PE original',()=> {
  const original=pe('requireAdministrator'); original.write('__TAURI_BUNDLE_TYPE_VAR_UNK',0xa00);
  const nsis=Buffer.from(original); nsis.write('__TAURI_BUNDLE_TYPE_VAR_NSS',0xa00);
  assert.deepEqual(clientImageForNsis(original),nsis); assert.deepEqual(clientImageForNsis(nsis),nsis);
  assert.ok(original.includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')));
  const changed=Buffer.from(original); changed[0xb00]=1;
  assert.notEqual(sha256(clientImageForNsis(changed)),sha256(nsis));
  const ambiguous=Buffer.from(original); ambiguous.write('__TAURI_BUNDLE_TYPE_VAR_NSS',0xb00);
  assert.throws(()=>clientImageForNsis(ambiguous),/MAIN_BINARY_MISMATCH/);
  assert.throws(()=>clientImageForNsis(pe('requireAdministrator')),/MAIN_BINARY_MISMATCH/);
});
test('bootstrap pin/ACL é somente para diretórios gerenciados; não relaxa C: ou pais',async()=> {
  const hooks=await readFile('src-tauri/windows/client-agent-hooks.nsh','utf8');
  assert.match(hooks,/CreateDirectoryW/); assert.match(hooks,/O:BAG:BAD:P/); assert.match(hooks,/GetSecurityInfo/); assert.match(hooks,/GetFileInformationByHandle/); assert.match(hooks,/GetAce/);
  assert.doesNotMatch(hooks,/SetNamedSecurityInfo|SetSecurityInfo|icacls|taskkill|RMDir\s+\/r/i);
  assert.match(hooks,/0x02200000/); assert.match(hooks,/0xd0156/); assert.match(hooks,/\$PROGRAMFILES64\\CENTRAL SOS/);
});
test('NSIS chama somente operações locais fixas e preserva preferências/dados',async()=> {
  const hooks=await readFile('src-tauri/windows/client-agent-hooks.nsh','utf8'); const native=await readFile('crates/agent/src/installation/native.rs','utf8');
  for(const command of ['prepare','commit','rollback','uninstall']) assert.ok(hooks.includes(`--installer-${command}`));
  assert.match(hooks,/StrCpy \$DeleteAppDataCheckboxState 0/); assert.match(hooks,/transaction\.json/); assert.match(native,/operation_lock/);
  assert.doesNotMatch(native,/Command::new|powershell|cmd\.exe|ProgramData|vault::|Enrollment::|revoke\(/);
  assert.match(native,/current_is_installed/); assert.match(native,/remoteRevocation.*not_requested/);
  const model=await readFile('crates/agent/src/installation/tests.rs','utf8'); assert.doesNotMatch(model,/windows_service|CreateProcess|ServiceManager/);
});
test('Actions verifica pacote completo antes da publicação; updater continua assinado',async()=> {
  const workflow=await readFile('.github/workflows/release.yml','utf8');
  const inspect=workflow.indexOf('node scripts/client-bundle.mjs inspect'); const publish=workflow.indexOf('node scripts/release-publish.mjs');
  assert.ok(inspect>0&&publish>inspect); assert.match(workflow,/verify-update/); assert.match(workflow,/releaseDraft: true/);
  const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')); assert.equal(config.bundle.createUpdaterArtifacts,true);
  const script=await readFile('scripts/client-bundle.mjs','utf8'); assert.match(script,/delete env.TAURI_SIGNING_PRIVATE_KEY/); assert.match(script,/INSTALLER_SOURCE_CHANGED_DURING_BUILD/);
  assert.match(script,/INSTALLER_MAIN_BINARY_MISMATCH/); assert.match(script,/INSTALLER_TARGET_DIRECTORY_MISMATCH/);
  assert.match(script,/--remap-path-prefix/); assert.match(script,/CARGO_ENCODED_RUSTFLAGS/);
});

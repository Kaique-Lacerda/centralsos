import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = path => readFile(path, 'utf8');
test('fixed user-token launcher has atomic ownership and no shell, credential inheritance or arbitrary path', async () => {
  const source = await read('crates/link/src/session/windows/lifecycle.rs');
  for (const invariant of ['WTSQueryUserToken', 'TokenLinkedToken', 'DuplicateTokenEx', 'TokenElevation',
    'CreateProcessAsUserW', 'CREATE_SUSPENDED', 'PROC_THREAD_ATTRIBUTE_JOB_LIST', 'EXTENDED_STARTUPINFO_PRESENT',
    'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'JOB_OBJECT_LIMIT_ACTIVE_PROCESS', 'IsProcessInJob',
    'GetProcessId', 'trusted_image', 'check_image', 'CreateEnvironmentBlock(&mut env, primary.0, 0)',
    'user_environment', 'central-sos-session-helper.exe']) assert.ok(source.includes(invariant), invariant);
  assert.doesNotMatch(source, /CreateProcessWithLogon|CreateProcessWithToken|Command::new|TcpListener|powershell\.exe|cmd\.exe|SetSecurityInfo|SetNamedSecurityInfo|icacls/);
});
test('service accepts stop/shutdown/session-change and provisioning is explicit without automatic SCM installation', async () => {
  const service = await read('crates/agent/src/service.rs');
  const installer = await read('crates/agent/src/service/installer.rs');
  for (const invariant of ['ServiceControl::Stop | ServiceControl::Shutdown', 'ServiceControl::SessionChange',
    'ServiceState::StartPending', 'ServiceState::Running', 'ServiceState::Stopped', 'SESSION_CHANGE', 'service_context']) assert.ok(service.includes(invariant), invariant);
  assert.doesNotMatch(service, /create_service\(|installer_command\(\)/);
  for (const invariant of ['administrative_installer()', 'installation_images()', 'AutoStart', 'account_name: None',
    'account_password: None', 'matches_install', 'SCM_STOP_REQUIRED', 'update_failure_actions', 'service.delete()']) assert.ok(installer.includes(invariant), invariant);
});
test('helper stays asInvoker without Backend/Desktop/TCP and command IPC requires owned peer', async () => {
  const manifest = await read('crates/session-helper/app.manifest');
  const main = await read('crates/session-helper/src/main.rs');
  const collector = await read('crates/session-helper/src/collector.rs');
  const native = await read('crates/agent/src/lifecycle/native.rs');
  const command = await read('crates/agent/src/session.rs');
  const transport = await read('crates/link/src/session/windows.rs');
  assert.match(manifest, /level="asInvoker" uiAccess="false"/);
  assert.doesNotMatch(main + collector, /Transport::|reqwest|TcpListener|https?:\/\/|Command::new/);
  assert.match(command, /crate::lifecycle::exchange/);
  assert.match(native, /windows::exchange_owned\(request, permit.pid\)/);
  assert.match(transport, /authenticate_helper\(pipe.0, &fresh\)/);
  assert.match(transport, /pid != expected/);
});
test('lifecycle diagnostics contain finite states instead of identity, inventory or secrets', async () => {
  const source = await read('crates/agent/src/lifecycle/native.rs');
  const logCalls = [...source.matchAll(/logging::event\([^;]+;/g)].map(m => m[0]);
  assert.ok(logCalls.length > 0);
  for (const call of logCalls) {
    assert.match(call, /"state"/);
    assert.doesNotMatch(call, /user_sid|logon_sid|credential|payload|request|identity|pid|token/);
  }
});

test('administrative recovery retains authorization and Agent trust while install/start require Helper trust', async () => {
  const installer = await read('crates/agent/src/service/installer.rs');
  const link = await read('crates/link/src/session/windows/lifecycle.rs');
  assert.match(installer, /fn requires_helper\(command: &str\)[\s\S]*?matches!\(command, "--install-service" \| "--start-service"\)/);
  assert.match(installer, /authorize\(\)\?;\s*let agent = agent\(\)\?;/);
  assert.match(installer, /if requires_helper\(command\)\s*\{\s*Some\(images\(\)\?\)/);
  for (const required of ['installation_agent_image()', 'administrative_service_process',
    'SCM_FOREIGN_CONFIGURATION_REJECTED', 'SCM_PROCESS_IDENTITY_REJECTED', 'recover(command, Some(&checked))'])
    assert.ok(installer.includes(required), required);
  const agentOnly = link.split('pub fn installation_agent_image()')[1].split('pub struct ServiceProcess')[0];
  assert.match(agentOnly, /trusted_image\(&expected\)/);
  assert.doesNotMatch(agentOnly, /HELPER_IMAGE|CreateProcess/);
  assert.doesNotMatch(installer + link, /SetSecurityInfo\(|SetNamedSecurityInfo\(|icacls|TerminateProcess\(/);
});

test('quarantine checks Job disarm and retains handles on failure instead of unverified termination', async () => {
  const source = await read('crates/link/src/session/windows/lifecycle.rs');
  const disarm = source.split('fn disarm_job(')[1].split('fn release_handles(')[0];
  for (const required of ['job.query()', 'job.set(&limits)', 'DisarmFailure::Query',
    'DisarmFailure::Set', 'DisarmFailure::Confirm', 'LimitFlags &= !JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'])
    assert.ok(disarm.includes(required), required);
  const retire = source.split('pub fn retire(&self)')[1].split('pub fn probe(')[0];
  assert.ok(retire.indexOf('if let Err(rejected) = self.verify()') < retire.indexOf('TerminateJobObject('));
  assert.match(retire, /self\.quarantine\(\);\s*return Err\(rejected\)/);
  const drop = source.split('impl Drop for Child')[1].split('pub fn launch(')[0];
  assert.match(drop, /finish_release\(decision/);
  assert.match(drop, /retained_until_process_exit/);
  assert.match(source, /process: ManuallyDrop<Handle>/);
  assert.match(source, /job: ManuallyDrop<Handle>/);
  assert.doesNotMatch(drop, /TerminateJobObject\(|TerminateProcess\(/);
});

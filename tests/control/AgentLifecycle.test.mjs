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

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../WindowsServicePresentation.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { isPriorityWindowsService, isPriorityServiceStopped } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const service = (name, state = 'Running') => ({ name, displayName: name, state, startMode: null, status: null, pathName: null, description: null, startName: null });

test('destaca serviços prioritários conhecidos por nome interno exato', () => {
  assert.equal(isPriorityWindowsService(service('RpcSs')), true);
  assert.equal(isPriorityWindowsService(service('FirebirdServerDefaultInstance')), true);
  assert.equal(isPriorityWindowsService(service('SomeOtherService')), false);
});

test('sinaliza serviço prioritário parado sem alterar seu estado', () => {
  assert.equal(isPriorityServiceStopped(service('Spooler', 'Stopped')), true);
  assert.equal(isPriorityServiceStopped(service('Spooler', 'Running')), false);
  assert.equal(isPriorityServiceStopped(service('Spooler', 'Unknown')), false);
  assert.equal(isPriorityServiceStopped(service('Unlisted', 'Stopped')), false);
});

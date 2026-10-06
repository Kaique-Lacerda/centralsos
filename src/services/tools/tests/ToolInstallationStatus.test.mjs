import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../ToolInstallationStatus.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, external: ['../validation/types', './GitHubToolsService'] });
const { getToolInstallationStatus } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const tool = (id = 'firebird-2.5.9', name = 'Firebird', version = '2.5.9.27139') => ({ id, name, version });
const installation = (overrides = {}) => ({ firebirdServices: [], firebirdError: null, cobian: [], cobianError: null, ibconsoleExecutables: [], ibconsoleError: null, nubeContabil: [], nubeContabilError: null, ...overrides });

test('retorna estados instalado, não instalado e atualização pela detecção existente', () => {
  assert.equal(getToolInstallationStatus(tool(), installation({ firebirdServices: [{ version: '2.5.9.27139', path: 'C:\\Firebird\\fbserver.exe', architecture: 'x64' }] }), 'desktop').state, 'installed');
  assert.equal(getToolInstallationStatus(tool(), installation(), 'desktop').state, 'not-installed');
  assert.equal(getToolInstallationStatus(tool(), installation({ firebirdServices: [{ version: '2.5.8' }] }), 'desktop').state, 'update-available');
});

test('reporta indisponibilidade web e falha de consulta sem inferir instalação', () => {
  assert.equal(getToolInstallationStatus(tool(), null, 'web').state, 'unavailable');
  assert.equal(getToolInstallationStatus(tool(), null, 'desktop').state, 'error');
  assert.equal(getToolInstallationStatus(tool(), installation({ firebirdError: 'WMI negado' }), 'desktop').state, 'error');
});

test('usa consulta de IBOConsole e Nuvem Contábil sem inventar versão ausente', () => {
  const ibo = getToolInstallationStatus(tool('iboconsole', 'IBOConsole', '1.1.9.6'), installation({ ibconsoleExecutables: ['C:\\Troia\\IBConsole.exe'] }), 'desktop');
  assert.equal(ibo.state, 'installed');
  assert.equal(ibo.installedVersion, null);
  const nube = getToolInstallationStatus(tool('nuvem-contabil', 'Nuvem Contábil', '1.0.29'), installation({ nubeContabil: [{ name: 'Nuvem Contábil', version: '1.0.29', location: 'C:\\Nuvem' }] }), 'desktop');
  assert.equal(nube.installedVersion, '1.0.29');
  assert.equal(nube.installedLocation, 'C:\\Nuvem');
});

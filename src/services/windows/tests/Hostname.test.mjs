import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../Hostname.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { validateHostname } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('hostname aceita nomes NetBIOS válidos com até 15 caracteres', () => {
  assert.equal(validateHostname('SUPORTE-01').valid, true);
  assert.equal(validateHostname('123').valid, true);
});

test('hostname rejeita vazio, tamanho excessivo e caracteres/formas inválidas', () => {
  for (const value of ['', 'HOSTNAME-1234567', '-SERVIDOR', 'SERVIDOR-', 'SERVIDOR_01', 'SERVIDOR.01']) {
    assert.equal(validateHostname(value).valid, false, value);
  }
});

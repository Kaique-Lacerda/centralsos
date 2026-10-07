import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { observations, clients, actions } from './fixtures.mjs';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = await build({ stdin: { contents: `
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {StaticRouter} from 'react-router-dom/server.js';
  import {GeneralDiagnosisPanel} from './src/pages/GeneralDiagnosisPanel';
  import {createDiagnosisEngine} from './src/services/diagnosis/DiagnosisEngine';
  export {createDiagnosisEngine};
  export const render=service=>renderToStaticMarkup(<StaticRouter><GeneralDiagnosisPanel service={service} onCompliance={()=>{}}/></StaticRouter>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{
  name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|react-router-dom(?:\/.*)?)$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  },
}] });
const { createDiagnosisEngine, render } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);
test('Tela renderiza resultado real do motor, incidente correlacionado, resumo e detalhes recolhidos', async () => {
  const data = observations(); data.firebird.database.exists = true;
  const engine = createDiagnosisEngine(clients(data), actions()); await engine.run();
  const html = render(engine);
  assert.equal((html.match(/<h3>✕ Firebird indisponível<\/h3>/g) ?? []).length, 1);
  assert.match(html, /Verificar computador/); assert.match(html, /áreas inconclusivas/);
  assert.match(html, /href="\/tools\/firebird"/); assert.match(html, /Abrir Conformidade SOS/);
  assert.match(html, /Verificações saudáveis/); assert.match(html, /Detalhes técnicos e inventário/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
});
test('Renderização não inicia coleta ou correção automaticamente', () => {
  let reads = 0; let mutations = 0;
  const engine = createDiagnosisEngine(clients(observations(), { machine: async () => { reads++; throw Error('unexpected'); } }), actions({ startSpooler: async () => { mutations++; } }));
  const html = render(engine); assert.equal(reads, 0); assert.equal(mutations, 0);
  assert.match(html, /Verificar computador/); assert.doesNotMatch(html, /Diagnóstico concluído/);
});

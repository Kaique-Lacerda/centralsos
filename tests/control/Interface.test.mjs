import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { load } from './load.mjs';
const { ControlPage } = await load('src/pages/control/ControlPage.tsx');
test('Control Web renderiza fora do aviso de ferramentas Desktop, sem chamar Tauri', () => {
  const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/control' }, createElement(ControlPage)));
  assert.match(html, /CENTRAL SOS CONTROL/); assert.match(html, /Ambientes e dispositivos/); assert.match(html, /\/api\/control\/auth\/login/);
  assert.doesNotMatch(html, /Este recurso coleta dados|credential|Bearer/);
});

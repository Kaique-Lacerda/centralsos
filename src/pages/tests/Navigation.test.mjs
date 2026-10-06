import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesFromElements, Navigate } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server.js';

async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    plugins: [{
      name: 'shared-react',
      setup(builder) {
        builder.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|react-router-dom(?:\/.*)?|lucide-react)$/ },
          args => ({ path: import.meta.resolve(args.path), external: true }));
      }
    }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}

const [{ navigationItems, visibleNavigationItems }, { Shell }, { App }] = await Promise.all([
  load('../../app/navigation.ts'),
  load('../../components/Shell.tsx'),
  load('../../app/App.tsx')
]);

const expectedLabels = ['Dashboard', 'Ferramentas', 'Validação', 'Instalações', 'Download', 'Configurações'];
const expectedPaths = ['/', '/tools', '/validation', '/installations', '/download', '/settings'];

test('configuração mantém Favoritos e Suporte preservados, ocultos e inativos', () => {
  assert.equal(navigationItems.length, 8);
  for (const path of ['/favorites', '/support']) {
    const item = navigationItems.find(candidate => candidate.path === path);
    assert.ok(item);
    assert.equal(item.enabled, false);
    assert.equal(item.visible, false);
    assert.ok(item.icon);
  }
  assert.deepEqual(visibleNavigationItems.map(item => item.label), expectedLabels);
  assert.deepEqual(visibleNavigationItems.map(item => item.path), expectedPaths);
});

test('sidebar renderiza somente os seis links ativos, na ordem atual e sem espaços reservados', () => {
  const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, createElement(Shell)));
  const nav = html.match(/<nav>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(nav);
  const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.deepEqual(links.map(link => link[1]), expectedPaths);
  assert.deepEqual(links.map(link => link[2].replace(/<svg\b[\s\S]*?<\/svg>/g, '')), expectedLabels);
  assert.doesNotMatch(nav, /Favoritos|Suporte|\/favorites|\/support|display:\s*none|visibility:\s*hidden/);
});

test('rotas diretas de Favoritos e Suporte continuam registradas e redirecionam para Dashboard', () => {
  const routes = createRoutesFromElements(App().props.children)[0].children;
  for (const [path, componentName] of [['favorites', 'FavoritesPage'], ['support', 'SupportPage']]) {
    const route = routes.find(candidate => candidate.path === path);
    assert.ok(route);
    assert.equal(route.element.props.Page.name, componentName);
    const redirect = route.element.type(route.element.props);
    assert.equal(redirect.type, Navigate);
    assert.equal(redirect.props.to, '/');
    assert.equal(redirect.props.replace, true);
  }
  assert.ok(routes.some(route => route.index));
  for (const path of expectedPaths.slice(1)) assert.ok(routes.some(route => route.path === path.slice(1)));
});

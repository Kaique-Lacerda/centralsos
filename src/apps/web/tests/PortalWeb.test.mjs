import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from '../../../../tests/control/load.mjs';

const catalog = await load('src/apps/web/catalog.ts');
const downloads = await load('src/apps/web/downloads.ts');
const { DownloadActions } = await load('src/apps/web/components/DownloadActions.tsx');
const { ToolCatalog } = await load('src/apps/web/components/ToolCatalog.tsx');
const { ToolCard } = await load('src/apps/web/components/ToolCard.tsx');
const { ToolFilters } = await load('src/apps/web/components/ToolFilters.tsx');
const { loadPortalResource } = await load('src/apps/web/usePortalResource.ts');
const tag = 'tools-v0.1.0';
const prefix = 'https://github.com/Kaique-Lacerda/centralsos/releases/download/';
// Isolated test fixtures based on the published catalog. Never injected into the UI.
const tool = (id, name, description, type, architecture, assetName) => ({ id, name, description, type,
  architecture, assetName, version: '1.0.0', requiresAdmin: false, sha256: 'a'.repeat(64),
  sizeBytes: 4096, assetStatus: 'available', actualAssetName: assetName, downloadUrl: `${prefix}${tag}/${assetName}` });
const tools = [
  tool('firebird-2.5.9', 'Firebird', 'Instalador Windows de banco de dados', 'installer', 'x64', 'Firebird.exe'),
  tool('iboconsole', 'IBOConsole', 'Administração de bancos', 'utility', 'x86', 'Iboconsole.exe'),
  tool('nuvem-contabil-1.0.29', 'Nuvem Contábil', 'Envio de documentos fiscais', 'installer', null, 'nuvem.exe'),
];
const release = { tagName: tag, publishedAt: null };
const ready = { status: 'available', release, tools };
const resource = (data, overrides = {}) => ({ data, loading: false, error: '', refresh() {}, ...overrides });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const selected = filters => catalog.filterTools(tools, { ...catalog.emptyFilters, ...filters }).map(t => t.id);
const client = { status: 'available', version: 'v0.2.0', publishedAt: null,
  asset: { name: 'CENTRAL.SOS_0.2.0_x64-setup.exe', sizeBytes: 3902340,
    downloadUrl: `${prefix}v0.2.0/CENTRAL.SOS_0.2.0_x64-setup.exe` } };

test('busca por nome/descrição ignora caixa e acentos; não modifica o inventário', () => {
  assert.deepEqual(selected({ search: 'NUVEM CONTABIL' }), ['nuvem-contabil-1.0.29']);
  assert.deepEqual(selected({ search: 'administracao' }), ['iboconsole']);
  assert.equal(selected({ search: 'banco' }).length, 2);
  assert.equal(selected({ search: 'não existe' }).length, 0);
  assert.equal(tools.length, 3);
});
test('todos os filtros funcionam individualmente e em combinação AND', () => {
  assert.equal(selected({ category: 'Banco de dados' }).length, 2);
  assert.deepEqual(selected({ type: 'utility' }), ['iboconsole']);
  assert.deepEqual(selected({ architecture: 'x64' }), ['firebird-2.5.9']);
  assert.deepEqual(selected({ architecture: 'Não informada' }), ['nuvem-contabil-1.0.29']);
  assert.equal(selected({ availability: 'available' }).length, 3);
  assert.equal(selected({ availability: 'unavailable' }).length, 0);
  assert.deepEqual(selected({ category: 'Banco de dados', type: 'installer', architecture: 'x64', search: 'Windows', availability: 'available' }), ['firebird-2.5.9']);
  assert.equal(selected({ category: 'Fiscal e documentos', architecture: 'x64' }).length, 0);
  assert.equal(selected(catalog.emptyFilters).length, 3);
});
test('categoria e arquitetura desconhecidas não são inventadas; disponibilidade usa URL validada', () => {
  const unknown = { ...tools[0], id: 'desconhecida', architecture: null };
  assert.equal(catalog.categoryOf(unknown), 'Não classificada');
  assert.deepEqual(catalog.filterOptions([unknown]).architecture, ['Não informada']);
  assert.equal(catalog.filterTools([{ ...tools[0], downloadUrl: 'https://example.com/file.exe' }],
    { ...catalog.emptyFilters, availability: 'unavailable' }).length, 1);
  assert.equal(catalog.formatBytes(null), 'Não informado');
});
test('URLs oficiais exigem repositório, tag e nome exatos, sem credenciais/query/redirecionamento arbitrário', () => {
  assert.equal(downloads.toolDownloadUrl(tools[0], tag), tools[0].downloadUrl);
  for (const invalid of ['http://github.com/a', 'https://evil.example/file.exe',
    tools[0].downloadUrl.replace('centralsos', 'outro'), tools[0].downloadUrl.replace(tag, 'tools-v9.0.0'),
    tools[0].downloadUrl + '?token=fixture', tools[0].downloadUrl + '#fragment',
    tools[0].downloadUrl.replace('https://', 'https://fixture@'), tools[0].downloadUrl.replace('Firebird.exe', 'Outro.exe'),
    tools[0].downloadUrl.replace('Firebird.exe', 'dir%2FFirebird.exe'), tools[0].downloadUrl.replace(tag, 'v0.1.0-test')]) {
    assert.equal(downloads.officialAssetUrl(invalid, tools[0].assetName, tag), null, invalid);
  }
  assert.equal(downloads.toolDownloadUrl({ ...tools[0], assetStatus: 'missing' }, tag), null);
});
test('Cliente publicado possui um link direto; Suporte nunca reutiliza o mesmo instalador', () => {
  assert.equal(downloads.clientDownloadState(client).status, 'available');
  const html = render(DownloadActions, { resource: resource(client) });
  assert.equal((html.match(/href=/g) ?? []).length, 1);
  assert.match(html, /download=""/);
  assert.match(html, /Baixar Cliente/);
  assert.match(html, /Baixar Suporte/);
  assert.match(html, /Ainda não publicado/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /target=|\/download\/client|\/download\/support/);
});
test('Cliente não publicado, loading, erro, sem instalador e ambiguidade mantêm ação bloqueada', () => {
  for (const data of [null, { status: 'not-published' }, { status: 'no-installer' }, { status: 'ambiguous' }, { status: 'ambiguous-release' }]) {
    assert.equal(downloads.clientDownloadState(data).url, null);
    assert.doesNotMatch(render(DownloadActions, { resource: resource(data) }), /href=/);
  }
  assert.equal(downloads.clientDownloadState(client, true).status, 'loading');
  assert.equal(downloads.clientDownloadState(client, false, 'falha').status, 'error');
  assert.doesNotMatch(render(DownloadActions, { resource: resource(client, { error: 'falha de rede' }) }), /href=/);
  for (const name of ['CENTRAL.SOS.Suporte-setup.exe', 'CENTRAL.SOS-agent.exe', 'CENTRAL.SOS-helper.exe']) {
    assert.equal(downloads.clientDownloadState({ ...client, asset: { ...client.asset, name, downloadUrl: `${prefix}v0.2.0/${name}` } }).url, null);
  }
  assert.equal(downloads.clientDownloadState({ ...client, version: 'v0.3.0' }).url, null);
  assert.equal(downloads.clientDownloadState({ ...client, version: tag, asset: { ...client.asset,
    downloadUrl: `${prefix}${tag}/${client.asset.name}` } }).url, null);
});
test('card disponível mostra dados verdadeiros e detalhes; não afirma homologação ou execução automática', () => {
  const html = render(ToolCard, { tool: tools[0], releaseTag: tag });
  assert.match(html, /aria-label="Baixar Firebird"/);
  for (const text of ['Disponível', 'Detalhes do arquivo', 'x64', 'SHA-256 esperado', tools[0].sha256]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /target=|Homologado|instalação automática/);
});
test('asset ausente/inválido/ambíguo ou URL divergente não habilita download', () => {
  for (const assetStatus of ['missing', 'name-mismatch', 'invalid-url', 'ambiguous']) {
    const html = render(ToolCard, { tool: { ...tools[0], assetStatus }, releaseTag: tag });
    assert.doesNotMatch(html, /href=/); assert.match(html, /Indisponível/); assert.match(html, /disabled/);
  }
  assert.doesNotMatch(render(ToolCard, { tool: tools[0], releaseTag: 'tools-v0.2.0' }), /href=/);
});
test('catálogo real na home possui contagem, três cards e filtros acessíveis', () => {
  const html = render(ToolCatalog, { resource: resource(ready) });
  assert.match(html, /3 ferramentas encontradas/);
  assert.equal((html.match(/<article /g) ?? []).length, 3);
  assert.match(html, /role="search"/);
  assert.equal((html.match(/<select[ >]/g) ?? []).length, 4);
  assert.match(html, /Pesquisar por nome ou descrição/);
});
test('catálogo trata vazio, ausente, inválido, não publicado, loading e falha de rede', () => {
  for (const [data, text] of [[{ ...ready, tools: [] }, 'Nenhuma ferramenta publicada'],
    [{ status: 'manifest-missing', release }, 'Manifesto não encontrado'],
    [{ status: 'manifest-invalid', release, reason: 'fixture inválida' }, 'Manifesto inválido'],
    [{ status: 'not-published' }, 'Catálogo ainda não publicado']]) {
    const html = render(ToolCatalog, { resource: resource(data) });
    assert.ok(html.includes(text)); assert.doesNotMatch(html, /<article /);
  }
  const loading = render(ToolCatalog, { resource: resource(ready, { loading: true }) });
  assert.match(loading, /Carregando catálogo/); assert.doesNotMatch(loading, /<article /);
  const error = render(ToolCatalog, { resource: resource(ready, { error: 'Verifique a conexão' }) });
  assert.match(error, /role="alert"/); assert.match(error, /Tentar novamente/); assert.doesNotMatch(error, /<article /);
});
test('filtros ativos possuem remoção individual e limpeza de todos; opções vêm do inventário', () => {
  const html = render(ToolFilters, { tools, filters: { ...catalog.emptyFilters, search: 'banco', architecture: 'x64' }, onChange() {} });
  assert.match(html, /Remover filtro pesquisa: banco/);
  assert.match(html, /Remover filtro Arquitetura: x64/);
  assert.match(html, /Limpar filtros/);
  assert.doesNotMatch(html, /Linux|macOS|Impressão/);
});
test('StrictMode/remount compartilha requisição pendente; erro limpa pendência e permite retry', async () => {
  let calls = 0;
  const loader = async () => { calls++; return ready; };
  const first = loadPortalResource(loader, false);
  assert.equal(first, loadPortalResource(loader, false));
  assert.equal(await first, ready); assert.equal(calls, 1);
  await loadPortalResource(loader, true); assert.equal(calls, 2);
  let failures = 0;
  const broken = async () => { failures++; throw new Error('fixture'); };
  await assert.rejects(loadPortalResource(broken, false), /fixture/);
  await assert.rejects(loadPortalResource(broken, true), /fixture/);
  assert.equal(failures, 2);
});
test('estilo Web isolado, grid responsivo, foco e reduced-motion presentes', async () => {
  const css = await readFile('src/apps/web/portal.css', 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /grid-template-columns:1fr;/);
  assert.doesNotMatch(await readFile('src/apps/web/main.tsx', 'utf8'), /styles\.css/);
});
test('texto branco do CTA principal tem contraste mínimo de 4.5:1 nos extremos do gradiente', async () => {
  const css = await readFile('src/apps/web/portal.css', 'utf8');
  const colors = css.match(/\.primary-download \{ background:linear-gradient\(130deg,#([\da-f]{6}),#([\da-f]{6})/);
  assert.ok(colors);
  for (const color of colors.slice(1)) {
    const channels = color.match(/../g).map(c => parseInt(c, 16) / 255)
      .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    assert.ok(1.05 / (luminance + .05) >= 4.5, color);
  }
  assert.match(css, /\.primary-download strong, \.primary-download small \{ color:#fff; \}/);
});

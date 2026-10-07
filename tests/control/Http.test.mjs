import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';
const { createControlClient } = await load('src/services/control/ControlService.ts');
const { ControlAuthentication, cookieValue } = await load('server/control/Authentication.ts');
const { handleControlApi, readBody } = await load('server/control/HttpApi.ts');
const { limitEnrollment } = await load('server/control/EnrollmentRateLimit.ts');
test('cliente usa same-origin e timeout sem tokens administrativos no React', async () => {
  const calls = []; const client = createControlClient(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => [] }; });
  await client.devices(); assert.equal(calls[0].url, '/api/control/devices'); assert.equal(calls[0].options.credentials, 'same-origin'); assert.ok(calls[0].options.signal); assert.equal(calls[0].options.headers.Authorization, undefined);
});
test('timeout/offline é reportado ao consumidor e tentativa posterior funciona', async () => {
  let failed = true; const client = createControlClient(async () => { if (failed) throw new DOMException('Timeout fixture', 'TimeoutError'); return { ok: true, json: async () => [] }; });
  await assert.rejects(client.devices(), /Timeout/); failed = false; assert.deepEqual(await client.devices(), []);
});
test('backend sem infraestrutura recusa requisição claramente, sem fallback em memória', async () => {
  const saved = process.env.CONTROL_DATABASE_URL; delete process.env.CONTROL_DATABASE_URL;
  const res = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  try { await handleControlApi({ url: '/api/control/devices', method: 'GET', headers: {} }, res); assert.equal(res.statusCode, 503); assert.match(res.body.error, /não configurado/); }
  finally { if (saved !== undefined) process.env.CONTROL_DATABASE_URL = saved; }
});
test('auth exige configuração HTTPS e sessão persistente, sem senha assumida', async () => {
  const configuration = { issuer: 'https://id.example.test', origin: 'https://control.example.test', clientId: 'fixture', clientSecret: 'fixture', sessionSecret: 'x'.repeat(32) };
  assert.throws(() => new ControlAuthentication({}, { ...configuration, origin: 'http://example.test' }), /HTTPS/);
  assert.throws(() => new ControlAuthentication({}, { ...configuration, sessionSecret: '' }), /32/);
  const auth = new ControlAuthentication({ query: async () => ({ rows: [] }) }, configuration);
  await assert.rejects(auth.authenticate(undefined), /Entre/); await assert.rejects(auth.authenticate('sos_session=fixture'), /expirada/);
  assert.equal(cookieValue('a=1; sos_session=fixture', 'sos_session'), 'fixture');
});
test('tentativas de enrollment têm limite compartilhado sem guardar IP em claro', async () => {
  let attempts = 0; const pool = { query: async (_sql, values) => { assert.match(values[0], /^[a-f0-9]{64}$/); return { rows: [{ attempts: ++attempts }] }; } };
  for (let i = 0; i < 10; i++) await limitEnrollment(pool, '192.0.2.1');
  await assert.rejects(limitEnrollment(pool, '192.0.2.1'), /aguarde/);
});
test('Function aceita JSON já interpretado pela Vercel e stream do Node', async () => {
  const fixture = { pairingCode: 'SOS-ABCD-EFGH' };
  assert.deepEqual(await readBody({ body: fixture }), fixture);
  async function* stream() { yield Buffer.from(JSON.stringify(fixture)); }
  assert.deepEqual(await readBody(stream()), fixture);
  await assert.rejects(readBody({ body: '{broken' }), /JSON inválido/);
  await assert.rejects(readBody({ body: { large: 'x'.repeat(2_000_001) } }), /limite/);
});

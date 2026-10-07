import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from './load.mjs';
const { decodeSessionRequest, sessionHelperResponseSchema, sessionOperations, SESSION_MAX_MESSAGE_BYTES } = await load('src/control/SessionHelperContract.ts');
const { createRulesRuntime } = await load('src/agent/RulesRuntime.ts');
const { commandRequestSchema, commandDefinitions } = await load('src/control/contracts.ts');
const session = { sessionId: 1, userSid: 'S-1-5-21-1', logonSid: 'S-1-5-5-1-1' };
const fixture = operation => ({ requestId: '0f897ee6-663d-47e1-8a93-72928a0734b1', protocolVersion: 1, timestamp: 1000, expiresAt: 10000, nonce: 'abbdf679-a3b3-4fc3-a221-993d0ad2cfb4', session, operation, payload: {} });
test('IPC rejects unknown operation, invalid payload, expiry, version, size and extra fields', () => {
    const valid = fixture('session.info');
    assert.deepEqual(decodeSessionRequest(JSON.stringify(valid), 2000), valid);
    for (const [changes, code] of [
        [{ operation: 'shell.exec' }, 'SESSION_INVALID_REQUEST'], [{ operation: 'application.restart' }, 'SESSION_INVALID_REQUEST'],
        [{ payload: { path: 'cmd.exe' } }, 'SESSION_INVALID_REQUEST'], [{ payload: [] }, 'SESSION_INVALID_REQUEST'],
        [{ expiresAt: 2000 }, 'SESSION_EXPIRED'], [{ protocolVersion: 2 }, 'SESSION_PROTOCOL_MISMATCH'],
        [{ extra: 'value' }, 'SESSION_INVALID_REQUEST'], [{ expiresAt: 40000 }, 'SESSION_INVALID_REQUEST']
    ]) assert.throws(() => decodeSessionRequest(JSON.stringify({ ...valid, ...changes }), 2000), e => e.code === code);
    assert.throws(() => decodeSessionRequest(' '.repeat(SESSION_MAX_MESSAGE_BYTES + 1), 2000), e => e.code === 'SESSION_MESSAGE_TOO_LARGE');
});
test('session results have serializable discriminated contracts', () => {
    const results = [
        { operation: 'session.info', data: { session, username: 'fixture', domain: 'fixture', state: 'active' } },
        { operation: 'session.processes', data: { items: [{ pid: 12, name: 'fixture.exe' }], truncated: false, incomplete: false } },
        { operation: 'session.printers', data: { items: [{ name: 'fixture', server: null, isDefault: true }], truncated: false, incomplete: false } }
    ];
    for (const result of results) {
        const req = fixture(result.operation);
        const response = { requestId: req.requestId, protocolVersion: 1, timestamp: 2000, nonce: req.nonce, session, outcome: { status: 'completed', result } };
        assert.deepEqual(sessionHelperResponseSchema.parse(JSON.parse(JSON.stringify(response))), response);
    }
});
test('machine-safe command never contacts helper; session reads delegate only allowlisted native operation', async () => {
    const run = createRulesRuntime((operation, payload) => { assert.equal(operation, 'services'); assert.deepEqual(payload, {}); return { items: [], error: null }; });
    assert.deepEqual(await run('service.check', {}, 'TERMINAL'), { items: [], error: null });
    for (const operation of sessionOperations) {
        const calls = [];
        const sessionRun = createRulesRuntime((op, payload) => { calls.push(op); assert.deepEqual(payload, {}); return { code: 'SESSION_HELPER_UNAVAILABLE' }; });
        assert.equal((await sessionRun(operation, {}, 'SERVER')).code, 'SESSION_HELPER_UNAVAILABLE');
        assert.deepEqual(calls, [operation]);
        await assert.rejects(sessionRun(operation, { script: 'evil' }, 'SERVER'), /SESSION_INVALID_REQUEST/);
        assert.equal(commandRequestSchema.safeParse({ type: operation, payload: {} }).success, true);
        assert.equal(commandRequestSchema.safeParse({ type: operation, payload: { path: 'evil' } }).success, false);
        assert.equal(commandDefinitions[operation].requiresInteractiveUser, true);
    }
});
test('transport source enforces local-only ACL, identity, SQOS, framing and deadlines; no generic executor', async () => {
    const transport = await readFile('crates/link/src/session/windows.rs', 'utf8');
    const main = await readFile('crates/session-helper/src/main.rs', 'utf8');
    const collector = await readFile('crates/session-helper/src/collector.rs', 'utf8');
    assert.match(transport, /PIPE_REJECT_REMOTE_CLIENTS/); assert.match(transport, /FILE_FLAG_FIRST_PIPE_INSTANCE/);
    assert.match(transport, /GetNamedPipeServerProcessId/); assert.match(transport, /GetNamedPipeClientProcessId/);
    assert.match(transport, /SECURITY_IDENTIFICATION/); assert.match(transport, /SERVICE_RUNNING/);
    assert.match(transport, /trusted_image/); assert.match(transport, /CancelIoEx/);
    assert.match(main, /não aceita argumentos/); assert.match(collector, /EnumPrintersW/);
    assert.doesNotMatch(transport + main + collector, /TcpListener|Command::new|powershell\.exe|cmd\.exe|CreateProcess/);
});

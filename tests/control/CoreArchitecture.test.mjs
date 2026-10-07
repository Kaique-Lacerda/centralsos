import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';

async function rustSources(directory) {
    const sources = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) sources.push(...await rustSources(path));
        else if (entry.name.endsWith('.rs')) sources.push([path, await readFile(path, 'utf8')]);
    }
    return sources;
}

test('Core owns its sources and has no Tauri integration or source path', async () => {
    const manifest = await readFile('crates/core/Cargo.toml', 'utf8');
    assert.doesNotMatch(manifest, /src-tauri|^\s*tauri\s*=/m);
    assert.match(manifest, /^desktop = \[\]/m);
    const library = await readFile('crates/core/src/lib.rs', 'utf8');
    assert.match(library, /pub mod models;/);
    assert.match(library, /pub mod services;/);
    assert.match(library, /pub const CORE_VERSION/);
    for (const [path, source] of await rustSources('crates/core/src')) {
        assert.doesNotMatch(source, /src-tauri|\btauri::|#\[tauri::/, path);
    }
    await assert.rejects(access('src-tauri/src/core.rs'));
    await assert.rejects(access('src-tauri/src/models'));
});

test('Desktop owns IPC and local UI integration while reusing Core services', async () => {
    const services = await readFile('src-tauri/src/services/mod.rs', 'utf8');
    assert.match(services, /pub use central_sos_core::services::\*;/);
    assert.match(services, /pub mod printer_queue_monitor;/);
    assert.match(services, /pub mod windows_admin;/);
    const coreServices = await readFile('crates/core/src/services/mod.rs', 'utf8');
    assert.doesNotMatch(coreServices, /printer_queue_monitor|windows_admin/);
    const monitor = await readFile('src-tauri/src/services/printer_queue_monitor.rs', 'utf8');
    assert.match(monitor, /tauri::ipc::Channel/);
    const ipcTests = await readFile('src-tauri/src/printer_diagnostic_tests.rs', 'utf8');
    assert.match(ipcTests, /printer_diagnostics_ipc_contracts/);
    assert.match(ipcTests, /tauri::ipc::Channel/);
});

test('Agent still consumes Core by crate and not by Desktop source path', async () => {
    const manifest = await readFile('crates/agent/Cargo.toml', 'utf8');
    assert.match(manifest, /central-sos-core = \{ path = "\.\.\/core" \}/);
    assert.doesNotMatch(manifest, /src-tauri/);
    for (const [path, source] of await rustSources('crates/agent/src')) {
        assert.doesNotMatch(source, /src-tauri/, path);
    }
});

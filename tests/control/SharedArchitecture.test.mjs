import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { posix } from 'node:path';
import ts from 'typescript';
import { buildAgentRules } from '../../scripts/build-agent-rules.mjs';
import { load } from './load.mjs';

async function sources(directory, extension) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) result.push(...await sources(path, extension));
        else if (entry.name.endsWith(extension)) result.push(path);
    }
    return result;
}

function imports(path, source) {
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return ast.statements.filter(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        .filter(node => node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        .map(node => node.moduleSpecifier.text);
}

test('Cargo observa somente packages neutros e o builder; regras compiladas não dependem do frontend', async () => {
    const build = await readFile('crates/agent/build.rs', 'utf8');
    assert.doesNotMatch(build, /"src\//);
    assert.match(build, /"packages\/contracts"/);
    assert.match(build, /"packages\/agent-rules"/);
    const result = await buildAgentRules();
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.includes('packages/agent-rules/RulesRuntime.ts'));
    assert.ok(inputs.includes('packages/contracts/control/command-policy.json'));
    assert.ok(inputs.every(input => /^packages\/(contracts|agent-rules)\//.test(input)));
    assert.ok(!inputs.some(input => /PrinterCorrections|PrinterService|runMachineValidation/.test(input)));
    assert.match(result.outputFiles[0].text, /CentralAgentRules/);
});

test('imports inclusive de tipos dos packages são neutros; rules não expõem shell ou eval', async () => {
    for (const path of await sources('packages', '.ts')) {
        const source = await readFile(path, 'utf8');
        for (const specifier of imports(path, source)) {
            if (specifier.startsWith('.')) {
                const target = posix.normalize(posix.join(posix.dirname(path), specifier));
                assert.match(target, /^packages\/(contracts|agent-rules)\//, `${path}: ${specifier}`);
            } else assert.equal(specifier, 'zod', `${path}: dependência runtime não prevista`);
        }
        assert.doesNotMatch(source, /@tauri-apps|react|node:child_process|\beval\s*\(|new\s+Function\s*\(|Command::new|cmd\.exe|powershell\.exe/, path);
    }
});

test('contracts e policy únicos fora do frontend; Backend e Control importam a mesma fonte ESM', async () => {
    for (const path of ['src/agent/RulesRuntime.ts', 'src/control/contracts.ts', 'src/control/CommandPolicy.ts', 'src/control/command-policy.json', 'src/control/SessionHelperContract.ts', 'src/types/machine.ts', 'src/types/printer-diagnostic.ts']) {
        await assert.rejects(access(path));
    }
    const policies = (await sources('packages', '.json')).filter(path => path.endsWith('/command-policy.json'));
    assert.deepEqual(policies, ['packages/contracts/control/command-policy.json']);
    assert.deepEqual((await sources('src', '.json')).filter(path => path.endsWith('/command-policy.json')), []);
    const matrix = JSON.parse(await readFile(policies[0], 'utf8'));
    const { commandDefinitions } = await load('packages/contracts/control/CommandPolicy.ts');
    assert.deepEqual(commandDefinitions, matrix);
    assert.equal(Object.keys(matrix).length, 9);
    assert.equal(matrix['printer.auto_fix'].requiresInteractiveUser, true);
    const sharedNames = new Set(['CommandType', 'DeviceProfile', 'RemoteCommand', 'RemoteCommandResult',
        'CommandDefinition', 'commandDefinitions', 'commandRequestSchema', 'heartbeatSchema',
        'enrollmentSchema', 'MachineSnapshot', 'PrinterDiagnosticSnapshot', 'ValidationResult']);
    for (const path of [...await sources('src', '.ts'), ...await sources('src', '.tsx')]) {
        const ast = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
        for (const statement of ast.statements) {
            const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
            for (const declaration of declarations) {
                if (declaration.name && ts.isIdentifier(declaration.name)) {
                    assert.ok(!sharedNames.has(declaration.name.text), `${path}: cópia de ${declaration.name.text}`);
                }
            }
        }
    }
    const link = await readFile('crates/link/src/policy.rs', 'utf8');
    assert.match(link, /include_str!\("\.\.\/\.\.\/\.\.\/packages\/contracts\/control\/command-policy\.json"\)/);
    for (const path of ['server/control/ControlBackend.ts', 'server/control/HttpApi.ts', 'server/control/Repository.ts', 'src/services/control/ControlService.ts', 'src/pages/control/ControlPage.tsx']) {
        const paths = imports(path, await readFile(path, 'utf8')).map(specifier => posix.normalize(posix.join(posix.dirname(path), specifier)));
        assert.ok(paths.some(target => /^packages\/contracts\/control\/contracts(?:\.js)?$/.test(target)), path);
        assert.ok(!paths.some(target => target.startsWith('src/control/')), path);
    }
});

test('frontend preserva adaptadores locais e apresentação, consumindo as mesmas regras', async () => {
    for (const path of ['src/services/printers/PrinterService.ts', 'src/services/printers/PrinterActionClient.ts', 'src/services/printers/PrinterCorrections.ts', 'src/services/printers/PrinterPresentation.ts', 'src/services/validation/runMachineValidation.ts', 'src/services/validation/installation/InstallationSnapshotService.ts']) await access(path);
    const corrections = await readFile('src/services/printers/PrinterCorrections.ts', 'utf8');
    assert.ok(imports('src/services/printers/PrinterCorrections.ts', corrections).includes('../../../packages/agent-rules/printers/PrinterDiagnosticRecord'));
    assert.doesNotMatch(corrections, /function\s+diagnosticRecord/);
    assert.match(await readFile('src/services/printers/PrinterService.ts', 'utf8'), /@tauri-apps\/api\/core/);
    assert.match(await readFile('src/services/validation/runMachineValidation.ts', 'utf8'), /packages\/agent-rules\/validation\/ValidationEngine/);
});

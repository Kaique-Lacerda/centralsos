import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
test('entrypoints Control/Agent compilam e resolvem ESM nativo do Node', async () => {
  const directory = resolve('.control-build', `esm-${randomUUID()}`); await mkdir(directory, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), 'api/control.ts', 'api/agent.ts', 'api/control/[...path].ts', 'api/agent/[...path].ts', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--resolveJsonModule', '--strict', '--skipLibCheck', '--rootDir', '.', '--outDir', directory], { stdio: 'pipe' });
  await writeFile(resolve(directory, 'package.json'), '{"type":"module"}');
  for (const folder of ['control', 'agent']) {
    for (const entry of [`api/${folder}.js`, `api/${folder}/[...path].js`]) {
      const output = resolve(directory, entry);
      assert.match(await readFile(output, 'utf8'), /HttpApi\.js/);
      const handler = (await import(pathToFileURL(output).href)).default; assert.equal(typeof handler, 'function');
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
test('Function catalog compila em NodeNext e resolve imports .js em ESM real', async () => {
    const directory=resolve('.control-build','catalog-esm-'+randomUUID());await mkdir(directory,{recursive:true});
    execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'api/catalog.ts','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--rootDir','.','--outDir',directory],{stdio:'pipe'});
    await writeFile(resolve(directory,'package.json'),'{"type":"module"}');
    const output=resolve(directory,'api/catalog.js');assert.match(await readFile(output,'utf8'),/HttpApi\.js/);
    assert.equal(typeof (await import(pathToFileURL(output).href)).default,'function');
});

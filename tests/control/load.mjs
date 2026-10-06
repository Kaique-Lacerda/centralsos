import { build } from 'esbuild';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function load(entry) {
  const bundle = await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external', loader: { '.css': 'empty' }, write: false });
  const directory = resolve('.control-build'); await mkdir(directory, { recursive: true });
  const file = resolve(directory, `test-${randomUUID()}.mjs`);
  await writeFile(file, bundle.outputFiles[0].contents);
  try { return await import(pathToFileURL(file).href); } finally { await unlink(file); }
}

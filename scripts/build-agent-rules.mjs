import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const neutralRoots = ['packages/contracts/', 'packages/agent-rules/'];

/** The same build graph is inspected by architectural tests and embedded by Cargo. */
export async function buildAgentRules({ outfile } = {}) {
    const result = await build({
        absWorkingDir: root,
        entryPoints: ['packages/agent-rules/RulesRuntime.ts'],
        bundle: true, platform: 'neutral', format: 'iife', globalName: 'CentralAgentRules',
        target: 'es2022', legalComments: 'none', write: false, metafile: true
    });
    for (const input of Object.keys(result.metafile.inputs)) {
        const source = relative(root, resolve(root, input)).split(sep).join('/');
        if (!neutralRoots.some(directory => source.startsWith(directory))) {
            throw new Error(`Agent Rules dependem de fonte não neutra: ${source}`);
        }
    }
    if (outfile) await writeFile(outfile, result.outputFiles[0].contents);
    return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.env.CENTRAL_SOS_RULES_OUTPUT) throw new Error('OUT_DIR obrigatório: execute através do Cargo.');
    await buildAgentRules({ outfile: process.env.CENTRAL_SOS_RULES_OUTPUT });
}

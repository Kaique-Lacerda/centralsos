export type UpdatePolicy = 'MANUAL' | 'AUTO' | 'MAINTENANCE_WINDOW';
export function compareVersions(a: string, b: string): number { const parse = (v: string) => { if (!/^\d+\.\d+\.\d+$/.test(v))
    throw Error('Versão semver inválida.'); return v.split('.').map(Number); }; const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++)
    if (x[i] !== y[i])
        return x[i] > y[i] ? 1 : -1; return 0; }
export function parseLatestManifest(value: unknown) { if (!value || typeof value !== 'object')
    throw Error('latest.json inválido.'); const m = value as Record<string, unknown>; if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version) || !m.platforms || typeof m.platforms !== 'object')
    throw Error('Contrato de atualização incompleto.'); const p = (m.platforms as Record<string, unknown>)['windows-x86_64']; if (!p || typeof p !== 'object')
    throw Error('Asset Windows x64 ausente.'); const entry = p as Record<string, unknown>; if (typeof entry.url !== 'string' || new URL(entry.url).protocol !== 'https:' || typeof entry.signature !== 'string' || !entry.signature.trim())
    throw Error('Atualização exige URL HTTPS e assinatura.'); return { version: m.version, url: entry.url, signature: entry.signature }; }

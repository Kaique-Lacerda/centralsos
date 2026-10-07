export type UpdatePolicy = 'MANUAL' | 'AUTO' | 'MAINTENANCE_WINDOW';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isVersion = (value: string) => VERSION.test(value) && !/\s/.test(value);

export function applicationVersion(tag: unknown): string | null {
    return typeof tag === 'string' && tag.startsWith('v') && isVersion(tag.slice(1)) ? tag.slice(1) : null;
}

export function compareVersions(a: string, b: string): number {
    if (!isVersion(a) || !isVersion(b)) throw Error('Versão semver inválida.');
    const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface UpdateManifest {
    version: string;
    notes?: string;
    pub_date?: string;
    platforms: Record<string, { url: string; signature: string }>;
}

export function validateLatestManifest(value: unknown): UpdateManifest {
    if (!isRecord(value) || typeof value.version !== 'string' || !isVersion(value.version)
        || !isRecord(value.platforms) || !isRecord(value.platforms['windows-x86_64'])) {
        throw Error('Contrato de atualização incompleto.');
    }
    if (value.notes !== undefined && typeof value.notes !== 'string') throw Error('Notas de atualização inválidas.');
    if (value.pub_date !== undefined && (typeof value.pub_date !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.pub_date)
        || Number.isNaN(Date.parse(value.pub_date)))) throw Error('Data de atualização inválida.');
    for (const entry of Object.values(value.platforms)) {
        if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.signature !== 'string' || !entry.signature.trim()) {
            throw Error('Atualização exige URL HTTPS e assinatura.');
        }
        const url = new URL(entry.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Atualização exige URL HTTPS e assinatura.');
    }
    return value as unknown as UpdateManifest;
}

// Preserve the existing Windows projection used by the UI/tests.
export function parseLatestManifest(value: unknown) {
    const manifest = validateLatestManifest(value);
    return { version: manifest.version, ...manifest.platforms['windows-x86_64'] };
}

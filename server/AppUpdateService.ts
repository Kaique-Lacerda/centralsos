import { applicationVersion, compareVersions, isRecord, validateLatestManifest, type UpdateManifest } from '../src/services/updater/UpdateContract.js';

export const APPLICATION_REPOSITORY = 'Kaique-Lacerda/centralsos';
export const APPLICATION_API = `https://api.github.com/repos/${APPLICATION_REPOSITORY}`;
const DOWNLOAD_PREFIX = `https://github.com/${APPLICATION_REPOSITORY}/releases/download/`;
const MAX_PAGES = 20;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
export type UpdateFetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
    ok: boolean; status: number; text(): Promise<string>;
}>;
export class AppUpdateError extends Error {
    constructor(readonly statusCode: number, message: string) { super(message); this.name = 'AppUpdateError'; }
}

export function selectStableApplicationRelease(releases: unknown[]): Record<string, unknown> | null {
    let chosen: Record<string, unknown> | null = null;
    let ambiguous = false;
    for (const value of releases) {
        if (!isRecord(value) || value.draft === true || value.prerelease === true) continue;
        const version = applicationVersion(value.tag_name);
        if (version === null) continue;
        const order = chosen ? compareVersions(version, applicationVersion(chosen.tag_name)!) : 1;
        if (order > 0) { chosen = value; ambiguous = false; }
        else if (order === 0) ambiguous = true;
    }
    if (ambiguous) throw new AppUpdateError(502, 'Há Releases de aplicativo ambíguas para a maior versão.');
    return chosen;
}

export function releasedAsset(release: Record<string, unknown>, name: string): Record<string, unknown> {
    const assets = Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
    const found = assets.filter(asset => asset.name === name);
    if (found.length !== 1) throw new AppUpdateError(502, `A Release precisa conter exatamente um ${name}.`);
    const asset = found[0];
    const prefix = `${APPLICATION_API}/releases/assets/`;
    if (typeof asset.url !== 'string' || !asset.url.startsWith(prefix) || !/^\d+$/.test(asset.url.slice(prefix.length))) {
        throw new AppUpdateError(502, 'Asset fora do endpoint oficial do repositório.');
    }
    return asset;
}

export function validateReleaseUpdate(value: unknown, release: Record<string, unknown>): UpdateManifest {
    let manifest: UpdateManifest;
    try { manifest = validateLatestManifest(value); }
    catch { throw new AppUpdateError(502, 'latest.json não possui um contrato Tauri válido e assinado.'); }
    if (manifest.version !== applicationVersion(release.tag_name)) throw new AppUpdateError(502, 'Versão do latest.json diverge da tag da Release.');
    for (const [platform, entry] of Object.entries(manifest.platforms)) {
        const prefix = `${DOWNLOAD_PREFIX}${release.tag_name}/`;
        if (!entry.url.startsWith(prefix) || new URL(entry.url).search) throw new AppUpdateError(502, 'O updater deve apontar para um asset da mesma versão do aplicativo.');
        let name: string;
        try { name = decodeURIComponent(entry.url.slice(prefix.length)); }
        catch { throw new AppUpdateError(502, 'Nome do asset de atualização inválido.'); }
        if (!name || name.includes('/') || name.includes('\\')) throw new AppUpdateError(502, 'Nome do asset de atualização inválido.');
        const asset = releasedAsset(release, name);
        if (asset.browser_download_url !== entry.url) throw new AppUpdateError(502, 'URL de atualização não corresponde ao asset publicado.');
        releasedAsset(release, `${name}.sig`);
        if (platform === 'windows-x86_64' && !name.toLowerCase().endsWith('.exe')) throw new AppUpdateError(502, 'O updater Windows x64 deve usar o instalador NSIS.');
    }
    return manifest;
}

async function request(url: string, fetcher: UpdateFetcher, accept = 'application/vnd.github+json'): Promise<string | null> {
    let response;
    try { response = await fetcher(url, { headers: { Accept: accept, 'User-Agent': 'CENTRAL-SOS-Updater', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) }); }
    catch { throw new AppUpdateError(502, 'Não foi possível consultar os artefatos de atualização no GitHub.'); }
    if (response.status === 404) return null;
    if (!response.ok) throw new AppUpdateError(502, `GitHub respondeu com HTTP ${response.status}.`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new AppUpdateError(502, 'Artefato de atualização excede o limite permitido.');
    return text;
}
function json(text: string): unknown {
    try { return JSON.parse(text); } catch { throw new AppUpdateError(502, 'GitHub retornou JSON inválido.'); }
}

export async function loadApplicationUpdate(fetcher: UpdateFetcher = globalThis.fetch): Promise<UpdateManifest | null> {
    const releases: unknown[] = [];
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const text = await request(`${APPLICATION_API}/releases?per_page=100&page=${page}`, fetcher);
        if (text === null) return null;
        const items = json(text);
        if (!Array.isArray(items)) throw new AppUpdateError(502, 'GitHub retornou uma lista de Releases inválida.');
        releases.push(...items);
        if (items.length < 100) { complete = true; break; }
    }
    if (!complete) throw new AppUpdateError(502, 'Não foi possível examinar todas as Releases com segurança.');
    const release = selectStableApplicationRelease(releases);
    if (!release) return null;
    const asset = releasedAsset(release, 'latest.json');
    const text = await request(asset.url as string, fetcher, 'application/octet-stream');
    if (text === null) throw new AppUpdateError(502, 'latest.json não está disponível na Release selecionada.');
    const manifest = validateReleaseUpdate(json(text), release);
    // Compare metadata to the real uploaded .sig files; cryptographic verification remains mandatory in Tauri.
    const verifiedSignatures = new Set<string>();
    for (const entry of Object.values(manifest.platforms)) {
        const name = decodeURIComponent(new URL(entry.url).pathname.split('/').at(-1)!);
        const signatureAsset = releasedAsset(release, `${name}.sig`);
        const identity = `${signatureAsset.url}\n${entry.signature.trim()}`;
        if (verifiedSignatures.has(identity)) continue;
        const signature = await request(signatureAsset.url as string, fetcher, 'application/octet-stream');
        if (signature?.trim() !== entry.signature.trim()) throw new AppUpdateError(502, 'Assinatura do latest.json diverge do asset .sig publicado.');
        verifiedSignatures.add(identity);
    }
    return manifest;
}

import { fetchGitHubResponse, GITHUB_REPOSITORY_API } from '../releases/GitHubReleaseService';

const RELEASES_API = `${GITHUB_REPOSITORY_API}/releases?per_page=100`;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MANIFEST_NAME = 'tools-manifest.json';
const MANIFEST_ACCEPT = 'application/octet-stream';
const EXPECTED_DOWNLOAD_PREFIX = 'https://github.com/Kaique-Lacerda/centralsos/releases/download/';

export interface ToolsReleaseSummary {
  tagName: string;
  publishedAt: string | null;
}

export interface ToolManifestEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  type: string;
  assetName: string;
  sizeBytes?: number | null;
  requiresAdmin: boolean;
  architecture?: string | null;
  sha256: string;
}

export interface CatalogTool extends ToolManifestEntry {
  architecture: string | null;
  sha256: string;
  sizeBytes: number | null;
  assetStatus: 'available' | 'missing' | 'name-mismatch' | 'invalid-url' | 'ambiguous';
  actualAssetName: string | null;
  downloadUrl: string | null;
}

export type GitHubToolsLookup =
  | { status: 'not-published' }
  | { status: 'manifest-missing'; release: ToolsReleaseSummary }
  | { status: 'manifest-invalid'; release: ToolsReleaseSummary; reason: string }
  | { status: 'available'; release: ToolsReleaseSummary; tools: CatalogTool[] };

interface GithubReleaseAsset {
  name?: unknown;
  url?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  assets?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

type ParsedTagVersion = [string, string, string];

let cached: { value: GitHubToolsLookup; expiresAt: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseTagVersion(tag: string): ParsedTagVersion | null {
  const match = /^tools-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) return null;
  return [match[1], match[2], match[3]];
}

function compareVersionPart(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

function compareVersions(left: ParsedTagVersion, right: ParsedTagVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const compared = compareVersionPart(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function selectToolsRelease(releases: readonly unknown[]): (GithubRelease & { tag_name: string }) | null {
  const candidates = releases
    .filter(isRecord)
    .map(release => release as GithubRelease)
    .filter((release): release is GithubRelease & { tag_name: string } =>
      stringValue(release.tag_name)
      && release.draft !== true
      && parseTagVersion(release.tag_name) !== null
    );

  candidates.sort((left, right) => {
    return compareVersions(parseTagVersion(right.tag_name)!, parseTagVersion(left.tag_name)!);
  });
  return candidates[0] ?? null;
}

function parseManifest(payload: unknown, releaseTag: string): { valid: true; tools: ToolManifestEntry[] } | { valid: false; reason: string } {
  if (!isRecord(payload)) return { valid: false, reason: 'O manifesto precisa ser um objeto JSON.' };
  if (payload.schemaVersion !== 1) return { valid: false, reason: 'Versão de schema do manifesto não suportada.' };
  if (payload.release !== releaseTag) return { valid: false, reason: `O manifesto declara ${String(payload.release ?? 'nenhuma release')}, mas foi carregado de ${releaseTag}.` };
  if (!Array.isArray(payload.tools)) return { valid: false, reason: 'O manifesto não contém uma lista de ferramentas válida.' };

  const tools: ToolManifestEntry[] = [];
  const ids = new Set<string>();
  for (const [index, value] of payload.tools.entries()) {
    if (!isRecord(value)) return { valid: false, reason: `A ferramenta na posição ${index + 1} não é um objeto válido.` };
    const requiredStrings = ['id', 'name', 'description', 'version', 'type', 'assetName', 'sha256'] as const;
    for (const field of requiredStrings) {
      if (!stringValue(value[field])) return { valid: false, reason: `A ferramenta na posição ${index + 1} não possui ${field} válido.` };
    }
    const entry = value as unknown as ToolManifestEntry;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(entry.id)) return { valid: false, reason: `O id "${entry.id}" contém caracteres inválidos.` };
    if (ids.has(entry.id)) return { valid: false, reason: `O id "${entry.id}" está duplicado no manifesto.` };
    ids.add(entry.id);
    if (entry.assetName !== entry.assetName.split(/[\\/]/).pop()) return { valid: false, reason: `O asset de ${entry.name} deve ser informado apenas pelo nome do arquivo.` };
    if (!/^[a-f\d]{64}$/i.test(entry.sha256)) return { valid: false, reason: `O SHA-256 de ${entry.name} deve conter 64 caracteres hexadecimais.` };
    if (typeof value.requiresAdmin !== 'boolean') return { valid: false, reason: `requiresAdmin de ${entry.name} deve ser booleano.` };
    if (value.architecture !== undefined && value.architecture !== null && !stringValue(value.architecture)) return { valid: false, reason: `architecture de ${entry.name} deve ser texto ou nulo.` };
    if (value.sizeBytes !== undefined && value.sizeBytes !== null && (typeof value.sizeBytes !== 'number' || !Number.isFinite(value.sizeBytes) || value.sizeBytes < 0)) {
      return { valid: false, reason: `sizeBytes de ${entry.name} deve ser um número não negativo ou nulo.` };
    }
    tools.push({ ...entry, sha256: entry.sha256.toLowerCase() });
  }
  return { valid: true, tools };
}

function validManifestAssetUrl(value: unknown): value is string {
  if (!stringValue(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'api.github.com'
      && url.pathname.startsWith('/repos/Kaique-Lacerda/centralsos/releases/assets/')
      && /^\d+$/.test(url.pathname.split('/').at(-1) ?? '');
  } catch {
    return false;
  }
}

function validDownloadUrl(value: unknown): value is string {
  if (!stringValue(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/Kaique-Lacerda/centralsos/releases/download/')
      && url.href.startsWith(EXPECTED_DOWNLOAD_PREFIX);
  } catch {
    return false;
  }
}

function resolveTools(manifestTools: ToolManifestEntry[], assets: GithubReleaseAsset[]): CatalogTool[] {
  return manifestTools.map(tool => {
    const named = assets.filter(asset => asset.name === tool.assetName);
    const sizeFromManifest = typeof tool.sizeBytes === 'number' ? tool.sizeBytes : null;
    if (named.length > 1) return { ...tool, architecture: tool.architecture ?? null, sizeBytes: sizeFromManifest, assetStatus: 'ambiguous', actualAssetName: tool.assetName, downloadUrl: null };
    if (named.length === 0) {
      const expectedLower = tool.assetName.toLowerCase();
      const expectedStem = expectedLower.replace(/\.[^.]+$/, '').replace(/[._ ]+/g, '-');
      const nearMatches = assets.filter(asset => {
        if (!stringValue(asset.name)) return false;
        const actualLower = asset.name.toLowerCase();
        if (actualLower === expectedLower) return true;
        if (actualLower.split('.').pop() !== expectedLower.split('.').pop()) return false;
        const actualStem = actualLower.replace(/\.[^.]+$/, '').replace(/[._ ]+/g, '-');
        return actualStem.startsWith(`${expectedStem}-`) || expectedStem.startsWith(`${actualStem}-`);
      });
      const mismatch = nearMatches.length === 1 ? nearMatches[0] : null;
      return {
        ...tool,
        architecture: tool.architecture ?? null,
        sizeBytes: sizeFromManifest,
        assetStatus: mismatch ? 'name-mismatch' : 'missing',
        actualAssetName: stringValue(mismatch?.name) ? mismatch.name : null,
        downloadUrl: null
      };
    }

    const asset = named[0];
    if (!validDownloadUrl(asset.browser_download_url)) {
      return { ...tool, architecture: tool.architecture ?? null, sizeBytes: sizeFromManifest, assetStatus: 'invalid-url', actualAssetName: tool.assetName, downloadUrl: null };
    }
    return {
      ...tool,
      architecture: tool.architecture ?? null,
      sizeBytes: typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : sizeFromManifest,
      assetStatus: 'available',
      actualAssetName: asset.name as string,
      downloadUrl: asset.browser_download_url
    };
  });
}

export function validateToolsManifest(payload: unknown, releaseTag: string): { valid: true; tools: ToolManifestEntry[] } | { valid: false; reason: string } {
  return parseManifest(payload, releaseTag);
}

export async function getGitHubToolsCatalog(options: {
  refresh?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
} = {}): Promise<GitHubToolsLookup> {
  const now = options.now ?? Date.now;
  if (!options.refresh && cached && cached.expiresAt > now()) return cached.value;
  const fetcher = options.fetcher ?? fetch;
  const releasesResponse = await fetchGitHubResponse(RELEASES_API, { fetcher });
  if (releasesResponse.status === 404) {
    const result: GitHubToolsLookup = { status: 'not-published' };
    cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
    return result;
  }
  const releaseList: unknown = await releasesResponse.json();
  if (!Array.isArray(releaseList)) throw new Error('O GitHub retornou uma lista de Releases inválida.');
  const selected = selectToolsRelease(releaseList);
  if (!selected) {
    const result: GitHubToolsLookup = { status: 'not-published' };
    cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
    return result;
  }

  const release: ToolsReleaseSummary = {
    tagName: selected.tag_name,
    publishedAt: typeof selected.published_at === 'string' && !Number.isNaN(Date.parse(selected.published_at)) ? selected.published_at : null
  };
  const assets = Array.isArray(selected.assets) ? selected.assets.filter(isRecord) as GithubReleaseAsset[] : [];
  const manifests = assets.filter(asset => asset.name === MANIFEST_NAME);
  if (manifests.length !== 1 || !validManifestAssetUrl(manifests[0]?.url)) {
    const result: GitHubToolsLookup = manifests.length === 0
      ? { status: 'manifest-missing', release }
      : { status: 'manifest-invalid', release, reason: 'A Release não possui exatamente um asset de manifesto válido.' };
    cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
    return result;
  }

  const manifestResponse = await fetchGitHubResponse(manifests[0].url, { fetcher, accept: MANIFEST_ACCEPT });
  if (manifestResponse.status === 404) {
    const result: GitHubToolsLookup = { status: 'manifest-missing', release };
    cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
    return result;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await manifestResponse.text());
  } catch {
    const result: GitHubToolsLookup = { status: 'manifest-invalid', release, reason: 'O asset tools-manifest.json não contém JSON válido.' };
    cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
    return result;
  }
  const parsed = parseManifest(payload, selected.tag_name);
  if (!parsed.valid) {
    const result: GitHubToolsLookup = { status: 'manifest-invalid', release, reason: parsed.reason };
    cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
    return result;
  }

  const result: GitHubToolsLookup = { status: 'available', release, tools: resolveTools(parsed.tools, assets) };
  cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
  return result;
}

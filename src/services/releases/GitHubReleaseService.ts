const RELEASE_API = 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/latest';
const CACHE_TTL_MS = 5 * 60 * 1000;
const setupIndicators = ['setup', 'installer', 'nsis'];
const auxiliaryIndicators = ['uninstall', 'updater', 'update', 'helper', 'bootstrap', 'portable'];

export interface WindowsInstallerAsset {
  name: string;
  downloadUrl: string;
  sizeBytes: number | null;
}

export type WindowsReleaseLookup =
  | { status: 'available'; version: string | null; publishedAt: string | null; asset: WindowsInstallerAsset }
  | { status: 'not-published' }
  | { status: 'no-installer' }
  | { status: 'ambiguous' };

interface ReleaseAssetCandidate {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface ReleaseCandidate {
  tag_name?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

let cached: { value: WindowsReleaseLookup; expiresAt: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function normalizeAsset(asset: ReleaseAssetCandidate): WindowsInstallerAsset | null {
  if (typeof asset.name !== 'string' || !asset.name.toLowerCase().endsWith('.exe') || !validDownloadUrl(asset.browser_download_url)) return null;
  return {
    name: asset.name,
    downloadUrl: asset.browser_download_url,
    sizeBytes: typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size >= 0 ? asset.size : null
  };
}

export function selectWindowsInstaller(assets: readonly unknown[]): WindowsInstallerAsset | 'none' | 'ambiguous' {
  const executables = assets.filter(isRecord).map(asset => normalizeAsset(asset)).filter((asset): asset is WindowsInstallerAsset => asset !== null);
  if (executables.length === 0) return 'none';
  if (executables.length === 1) return executables[0];

  const likelyInstallers = executables.filter(asset => {
    const name = asset.name.toLowerCase();
    return !auxiliaryIndicators.some(indicator => name.includes(indicator));
  });
  for (const indicator of setupIndicators) {
    const preferred = likelyInstallers.filter(asset => asset.name.toLowerCase().includes(indicator));
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return 'ambiguous';
  }
  if (likelyInstallers.length === 1) return likelyInstallers[0];
  return 'ambiguous';
}

export function parseLatestWindowsRelease(payload: unknown): WindowsReleaseLookup {
  if (!isRecord(payload)) return { status: 'not-published' };
  const release = payload as ReleaseCandidate;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const selected = selectWindowsInstaller(assets);
  if (selected === 'none') return { status: 'no-installer' };
  if (selected === 'ambiguous') return { status: 'ambiguous' };
  return {
    status: 'available',
    version: typeof release.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : null,
    publishedAt: typeof release.published_at === 'string' && !Number.isNaN(Date.parse(release.published_at)) ? release.published_at : null,
    asset: selected
  };
}

export async function getLatestWindowsRelease(options: {
  refresh?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
} = {}): Promise<WindowsReleaseLookup> {
  const now = options.now ?? Date.now;
  if (!options.refresh && cached && cached.expiresAt > now()) return cached.value;

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (response.status === 404) {
    const empty: WindowsReleaseLookup = { status: 'not-published' };
    cached = { value: empty, expiresAt: now() + CACHE_TTL_MS };
    return empty;
  }
  if (!response.ok) throw new Error(`GitHub respondeu com HTTP ${response.status}.`);

  const result = parseLatestWindowsRelease(await response.json());
  cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
  return result;
}

export const GITHUB_REPOSITORY_API = 'https://api.github.com/repos/Kaique-Lacerda/centralsos';
const RELEASES_API = `${GITHUB_REPOSITORY_API}/releases`;
const RELEASES_PER_PAGE = 100;
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
  | { status: 'ambiguous-release' }
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
  draft?: unknown;
}

interface ApplicationRelease extends ReleaseCandidate {
  tag_name: string;
}

type ApplicationReleaseSelection =
  | { status: 'selected'; release: ApplicationRelease }
  | { status: 'not-published' }
  | { status: 'ambiguous' };

let cached: { value: WindowsReleaseLookup; expiresAt: number } | null = null;

export async function fetchGitHubResponse(
  url: string,
  options: { fetcher?: typeof fetch; accept?: string } = {}
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    headers: { Accept: options.accept ?? 'application/vnd.github+json' }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub respondeu com HTTP ${response.status}.`);
  }
  return response;
}

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

function parseApplicationTag(tag: string): [string, string, string] | null {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  return match ? [match[1], match[2], match[3]] : null;
}

function compareVersionPart(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

function compareApplicationVersions(left: [string, string, string], right: [string, string, string]): number {
  for (let index = 0; index < left.length; index += 1) {
    const compared = compareVersionPart(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function selectApplicationRelease(releases: readonly unknown[]): ApplicationReleaseSelection {
  const candidates = releases
    .filter(isRecord)
    .map(release => release as ReleaseCandidate)
    .filter((release): release is ApplicationRelease =>
      typeof release.tag_name === 'string'
      && release.draft !== true
      && parseApplicationTag(release.tag_name) !== null
    )
    .map(release => ({ release, version: parseApplicationTag(release.tag_name)! }));

  if (candidates.length === 0) return { status: 'not-published' };
  let greatest = candidates[0].version;
  for (const candidate of candidates.slice(1)) {
    if (compareApplicationVersions(candidate.version, greatest) > 0) greatest = candidate.version;
  }
  const matches = candidates.filter(candidate => compareApplicationVersions(candidate.version, greatest) === 0);
  if (matches.length !== 1) return { status: 'ambiguous' };
  return { status: 'selected', release: matches[0].release };
}

function parseWindowsRelease(release: ApplicationRelease): WindowsReleaseLookup {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const selected = selectWindowsInstaller(assets);
  if (selected === 'none') return { status: 'no-installer' };
  if (selected === 'ambiguous') return { status: 'ambiguous' };
  return {
    status: 'available',
    version: release.tag_name,
    publishedAt: typeof release.published_at === 'string' && !Number.isNaN(Date.parse(release.published_at)) ? release.published_at : null,
    asset: selected
  };
}

export function parseLatestWindowsRelease(payload: unknown): WindowsReleaseLookup {
  if (!Array.isArray(payload)) return { status: 'not-published' };
  const selection = selectApplicationRelease(payload);
  if (selection.status === 'not-published') return { status: 'not-published' };
  if (selection.status === 'ambiguous') return { status: 'ambiguous-release' };
  return parseWindowsRelease(selection.release);
}

async function fetchApplicationReleases(fetcher?: typeof fetch): Promise<unknown[]> {
  const releases: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const url = `${RELEASES_API}?per_page=${RELEASES_PER_PAGE}&page=${page}`;
    const response = await fetchGitHubResponse(url, { fetcher });
    if (response.status === 404) return releases;
    const pageReleases: unknown = await response.json();
    if (!Array.isArray(pageReleases)) throw new Error('O GitHub retornou uma lista de Releases inválida.');
    releases.push(...pageReleases);
    if (pageReleases.length < RELEASES_PER_PAGE) return releases;
  }
}

export async function getLatestWindowsRelease(options: {
  refresh?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
} = {}): Promise<WindowsReleaseLookup> {
  const now = options.now ?? Date.now;
  if (!options.refresh && cached && cached.expiresAt > now()) return cached.value;

  const releases = await fetchApplicationReleases(options.fetcher);
  const result = parseLatestWindowsRelease(releases);
  cached = { value: result, expiresAt: now() + CACHE_TTL_MS };
  return result;
}

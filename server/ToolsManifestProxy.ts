const REPOSITORY_API = 'https://api.github.com/repos/Kaique-Lacerda/centralsos';
const MANIFEST_NAME = 'tools-manifest.json';
const RELEASE_ASSET_PREFIX = `${REPOSITORY_API}/releases/assets/`;
const TOOLS_TAG_PATTERN = /^tools-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ManifestFetchResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ManifestFetcher = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<ManifestFetchResponse>;

export class ToolsManifestProxyError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ToolsManifestProxyError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeFetch(url: string, init: { headers: Record<string, string> }): Promise<ManifestFetchResponse> {
  const fetchFunction = (globalThis as unknown as { fetch?: ManifestFetcher }).fetch;
  if (typeof fetchFunction !== 'function') {
    return Promise.reject(new ToolsManifestProxyError(502, 'O servidor não possui suporte a fetch.'));
  }
  return fetchFunction(url, init);
}

function isReleaseAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.startsWith(RELEASE_ASSET_PREFIX)
    && /^\d+$/.test(value.slice(RELEASE_ASSET_PREFIX.length));
}

export async function loadToolsManifestFromRelease(
  tag: string,
  fetcher: ManifestFetcher = nativeFetch
): Promise<unknown> {
  if (!TOOLS_TAG_PATTERN.test(tag)) {
    throw new ToolsManifestProxyError(400, 'Tag de Release de ferramentas inválida.');
  }

  let releaseResponse: ManifestFetchResponse;
  try {
    releaseResponse = await fetcher(`${REPOSITORY_API}/releases/tags/${tag}`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
  } catch {
    throw new ToolsManifestProxyError(502, 'Não foi possível consultar a Release no GitHub.');
  }
  if (releaseResponse.status === 404) {
    throw new ToolsManifestProxyError(404, 'Release de ferramentas não encontrada.');
  }
  if (!releaseResponse.ok) {
    throw new ToolsManifestProxyError(502, 'O GitHub não conseguiu retornar a Release de ferramentas.');
  }

  let release: unknown;
  try {
    release = await releaseResponse.json();
  } catch {
    throw new ToolsManifestProxyError(502, 'O GitHub retornou dados inválidos para a Release.');
  }
  if (!isRecord(release) || release.tag_name !== tag || release.draft === true) {
    throw new ToolsManifestProxyError(404, 'Release de ferramentas publicada não encontrada.');
  }

  const assets = Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
  const manifests = assets.filter(asset => asset.name === MANIFEST_NAME);
  if (manifests.length !== 1 || !isReleaseAssetUrl(manifests[0]?.url)) {
    throw new ToolsManifestProxyError(404, 'A Release não contém exatamente um tools-manifest.json válido.');
  }

  let assetResponse: ManifestFetchResponse;
  try {
    assetResponse = await fetcher(manifests[0].url, {
      headers: { Accept: 'application/octet-stream' }
    });
  } catch {
    throw new ToolsManifestProxyError(502, 'Não foi possível baixar o manifesto da Release no servidor.');
  }
  if (!assetResponse.ok) {
    throw new ToolsManifestProxyError(502, 'O GitHub não conseguiu retornar o manifesto da Release.');
  }

  try {
    return JSON.parse(await assetResponse.text());
  } catch {
    throw new ToolsManifestProxyError(502, 'O asset tools-manifest.json não contém JSON válido.');
  }
}

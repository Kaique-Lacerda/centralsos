import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadReleaseModule, projectVersion } from './release-config.mjs';

export async function publishVerifiedRelease(environment, fetcher = fetch) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_REPOSITORY !== 'Kaique-Lacerda/centralsos' || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '') || !environment.GITHUB_TOKEN || !environment.RELEASE_TAG) {
    throw Error('Publicação permitida somente no workflow do main.');
  }
  const { APPLICATION_API, loadApplicationUpdate } = await loadReleaseModule('server/AppUpdateService.ts');
  const { tag } = await projectVersion(process.cwd(), environment.RELEASE_TAG);
  const headers = { Authorization: `Bearer ${environment.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const releaseResponse = await fetcher(`${APPLICATION_API}/releases/tags/${tag}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!releaseResponse.ok) throw Error(`GitHub respondeu com HTTP ${releaseResponse.status}.`);
  const release = await releaseResponse.json();
  if (release.tag_name !== tag || release.draft !== true || release.prerelease !== false || release.target_commitish !== environment.GITHUB_SHA || !Number.isSafeInteger(release.id)) {
    throw Error('Draft/commit/tag divergentes; publicação recusada.');
  }
  // GitHub draft assets may use an untagged-* download path. Tauri Action rewrites
  // latest.json to the final tag URL. Normalize that metadata only in this draft
  // view; requests still use the real authenticated asset API URLs.
  const publishedView = { ...release, draft: false, assets: Array.isArray(release.assets) ? release.assets.map(asset => ({
    ...asset, browser_download_url: typeof asset.browser_download_url === 'string'
      ? asset.browser_download_url.replace(/^https:\/\/github\.com\/Kaique-Lacerda\/centralsos\/releases\/download\/untagged-[^/]+\//,
          `https://github.com/Kaique-Lacerda/centralsos/releases/download/${tag}/`)
      : asset.browser_download_url
  })) : release.assets };
  // Reuse exactly the production validator, exposing just this draft to it in memory.
  const manifest = await loadApplicationUpdate(async (url, init) => {
    if (url === `${APPLICATION_API}/releases?per_page=100&page=1`) return { ok: true, status: 200, text: async () => JSON.stringify([publishedView]) };
    return fetcher(url, { ...init, headers: { ...init.headers, Authorization: headers.Authorization } });
  });
  if (!manifest) throw Error('Updater manifest não validado.');
  const published = await fetcher(`${APPLICATION_API}/releases/${release.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }), signal: AbortSignal.timeout(15000)
  });
  if (!published.ok) throw Error(`GitHub recusou publicação com HTTP ${published.status}.`);
  const result = await published.json();
  if (result.tag_name !== tag || result.draft !== false || result.prerelease !== false) throw Error('GitHub não confirmou a publicação esperada.');
  return result.html_url;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(await publishVerifiedRelease(process.env)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

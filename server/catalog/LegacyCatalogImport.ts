import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { validateToolsManifest } from '../../src/services/tools/GitHubToolsService.js';
import { loadToolsManifestFromRelease } from '../ToolsManifestProxy.js';
import { CatalogError, id } from './Validation.js';
import { githubAssetReference, legacyRepository } from './FileSource.js';
import { verifyHeader } from './Storage.js';
import { audit, digest } from './Authentication.js';

export function legacyIdentity(key: string) {
    const bytes = createHash('sha256').update('central-sos/catalog/legacy/' + legacyRepository + '/' + key).digest().subarray(0,16);
    bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const entrySchema = z.object({ legacyId:z.string().min(1).max(120), name:z.string().min(1).max(120), description:z.string().min(1).max(2000),
    version:z.string().min(1).max(60), type:z.string().min(1).max(60), compatibility:z.string().min(1).max(160), requiresAdmin:z.boolean(),
    assetName:z.string(), size:z.number().int().positive().max(100*1024*1024), sha256:z.string().regex(/^[a-f0-9]{64}$/), source:z.string(), toolId:z.uuid(),versionId:z.uuid() }).strict();
export type LegacyEntry = z.infer<typeof entrySchema>;
export function prepareLegacyImport(manifest: unknown, release: unknown, mapping: unknown = {}): LegacyEntry[] {
    const value = release as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{name:string;size:number;browser_download_url:string}> };
    if (!value || value.draft !== false || value.prerelease !== false || !value.tag_name || !Array.isArray(value.assets)) throw new CatalogError('LEGACY_RELEASE_INVALID');
    const parsed = validateToolsManifest(manifest,value.tag_name);
    const mappings = z.record(z.string().min(1).max(120),z.uuid()).safeParse(mapping);
    if (!parsed.valid || !mappings.success || Object.keys(mappings.data).some(key => !parsed.tools.some(tool => tool.id === key))) throw new CatalogError('LEGACY_MANIFEST_INVALID');
    const ids = new Set<string>(), sources = new Set<string>();
    return parsed.tools.map(tool => {
        const source = githubAssetReference(value.tag_name!,tool.assetName);
        const assets = value.assets!.filter(asset => asset.name === tool.assetName);
        if (ids.has(tool.id) || sources.has(source) || assets.length !== 1 || assets[0].browser_download_url !== source
            || (tool.sizeBytes != null && tool.sizeBytes !== assets[0].size)) throw new CatalogError('LEGACY_ASSET_AMBIGUOUS_OR_INVALID');
        ids.add(tool.id); sources.add(source);
        const row = entrySchema.safeParse({ legacyId:tool.id,name:tool.name,description:tool.description,version:tool.version,
            type:tool.type === 'installer' ? 'Instalador' : tool.type === 'utility' ? 'Utilitário' : tool.type,
            compatibility:tool.architecture ? `Arquitetura: ${tool.architecture}` : 'Arquitetura não informada no manifesto',
            requiresAdmin:tool.requiresAdmin,assetName:tool.assetName,size:assets[0].size,sha256:tool.sha256.toLowerCase(),source,
            toolId:mappings.data[tool.id] ?? legacyIdentity('tool/'+tool.id),versionId:legacyIdentity('asset/'+source) });
        if (!row.success) throw new CatalogError('LEGACY_MANIFEST_INVALID'); return row.data;
    });
}
export async function loadLegacyImport(tag: string, mapping: unknown = {}) {
    githubAssetReference(tag,'validation.zip');
    const response = await fetch(`https://api.github.com/repos/${legacyRepository}/releases/tags/${tag}`,{ headers:{ Accept:'application/vnd.github+json' },signal:AbortSignal.timeout(30000) });
    if (!response.ok) throw new CatalogError('LEGACY_RELEASE_UNAVAILABLE');
    return prepareLegacyImport(await loadToolsManifestFromRelease(tag),await response.json(),mapping);
}
export async function verifyLegacyAsset(entry: LegacyEntry) {
    let url = entry.source;
    for (let redirect=0;redirect<5;redirect++) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['github.com','release-assets.githubusercontent.com'].includes(parsed.hostname)) throw new CatalogError('LEGACY_REDIRECT_REJECTED');
        const response = await fetch(url,{ redirect:'manual',signal:AbortSignal.timeout(60000) });
        if ([301,302,303,307,308].includes(response.status)) {
            const location = response.headers.get('location'); await response.body?.cancel();
            if (!location) throw new CatalogError('LEGACY_ASSET_UNAVAILABLE'); url = new URL(location,url).href; continue;
        }
        if (!response.ok || !response.body) throw new CatalogError('LEGACY_ASSET_UNAVAILABLE');
        const reader = response.body.getReader(), hash = createHash('sha256'); let bytes=0,header=Buffer.alloc(0);
        try {
            while (true) {
                const part = await reader.read(); if (part.done) break;
                bytes += part.value.byteLength; if (bytes>entry.size) throw new CatalogError('LEGACY_SIZE_MISMATCH');
                if (header.length<65536) header = Buffer.concat([header,Buffer.from(part.value).subarray(0,65536-header.length)]);
                hash.update(part.value);
            }
        } finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
        if (bytes!==entry.size || hash.digest('hex')!==entry.sha256) throw new CatalogError('LEGACY_HASH_OR_SIZE_MISMATCH');
        verifyHeader(header,entry.assetName); return;
    }
    throw new CatalogError('LEGACY_REDIRECT_REJECTED');
}
// Explicit administrative data migration. Never called by the portal or server startup.
// Existing schema/ledger is retained; source is an immutable official reference in object_path.
export async function importLegacyCatalog(pool: Pool, entries: LegacyEntry[], apply = false, verifier = verifyLegacyAsset) {
    if (apply) {
        const preflight = await importLegacyCatalog(pool,entries,false,verifier);
        for (const entry of entries) if (preflight.entries.some(row => row.versionId===entry.versionId && row.state==='pending-import')) await verifier(entry);
    }
    const db = await pool.connect();
    const result: Array<{legacyId:string;toolId:string;versionId:string;state:string;assetName:string;version:string;sha256:string;size:number;source:string}> = [];
    try {
        await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(827351920)');
        for (const input of entries) {
            const parsed = entrySchema.safeParse(input); if (!parsed.success) throw new CatalogError('LEGACY_MANIFEST_INVALID');
            const entry = parsed.data; id(entry.toolId); id(entry.versionId);
            const match = /^https:\/\/github\.com\/Kaique-Lacerda\/centralsos\/releases\/download\/([^/]+)\/([^/]+)$/.exec(entry.source);
            if (!match || githubAssetReference(match[1],entry.assetName)!==entry.source || entry.versionId!==legacyIdentity('asset/'+entry.source)) throw new CatalogError('LEGACY_SOURCE_INVALID');
            const tool = (await db.query('SELECT id,deleted_at FROM catalog_tools WHERE id=$1',[entry.toolId])).rows[0];
            if (!tool && entry.toolId!==legacyIdentity('tool/'+entry.legacyId)) throw new CatalogError('LEGACY_MAPPING_TARGET_MISSING');
            const bySource = (await db.query('SELECT id,tool_id,sha256,size,file_name FROM catalog_versions WHERE object_path=$1',[entry.source])).rows[0];
            if (bySource && (bySource.tool_id!==entry.toolId || bySource.id!==entry.versionId || bySource.sha256?.trim()!==entry.sha256 || Number(bySource.size)!==entry.size || bySource.file_name!==entry.assetName)) throw new CatalogError('LEGACY_SOURCE_DIVERGENT');
            if (!tool && (await db.query('SELECT id FROM catalog_tools WHERE lower(name)=lower($1)',[entry.name])).rowCount) throw new CatalogError('LEGACY_MAPPING_REQUIRED');
            if (!bySource && (await db.query('SELECT id FROM catalog_versions WHERE tool_id=$1 AND version=$2',[entry.toolId,entry.version])).rowCount) throw new CatalogError('LEGACY_VERSION_CONFLICT');
            const state = tool?.deleted_at ? 'removed-preserved' : bySource ? 'already-imported' : 'pending-import';
            result.push({legacyId:entry.legacyId,toolId:entry.toolId,versionId:entry.versionId,state,assetName:entry.assetName,version:entry.version,sha256:entry.sha256,size:entry.size,source:entry.source});
            if (!apply || state!=='pending-import') continue;
            if (!tool) {
                const categoryName='Ferramentas legadas';
                const category = await db.query(`INSERT INTO catalog_categories(id,name) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[legacyIdentity('category/'+categoryName),categoryName]);
                await db.query(`INSERT INTO catalog_tools(id,name,description,category_id,type,compatibility,tags,requires_admin,visibility) VALUES($1,$2,$3,$4,$5,$6,'[]',$7,'technicians')`,[entry.toolId,entry.name,entry.description,category.rows[0].id,entry.type,entry.compatibility,entry.requiresAdmin]);
            }
            await db.query(`INSERT INTO catalog_versions(id,tool_id,version,file_name,size,object_path,content_type,upload_owner,upload_expires_at,sha256,verified,approved,published) VALUES($1,$2,$3,$4,$5,$6,'application/octet-stream',$7,now(),$8,true,false,false)`,
                [entry.versionId,entry.toolId,entry.version,entry.assetName,entry.size,entry.source,digest('catalog-legacy-administration'),entry.sha256]);
            await audit(db,'admin',digest('catalog-legacy-administration'),'legacy.import',entry.versionId);
        }
        await db.query(apply?'COMMIT':'ROLLBACK'); return { dryRun:!apply,entries:result };
    } catch (failure) { await db.query('ROLLBACK').catch(()=>undefined); throw failure; }
    finally { db.release(); }
}

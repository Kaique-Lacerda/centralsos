import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CatalogCategory, CatalogTool, CatalogVersion, CatalogAudit } from '../../packages/contracts/catalog/index.js';
import { audit, rotateCredential, type CatalogActor } from './Authentication.js';
import { CatalogError, canRead, requireAdmin, requireSession, toolSchema, uploadSchema, categorySchema, credentialSchema, parse } from './Validation.js';
import type { CatalogStorage } from './Storage.js';
import { catalogFileSource } from './FileSource.js';

export class CatalogService {
    constructor(private readonly pool: Pool, private readonly storage: CatalogStorage) {}
    private async transaction<T>(actor: CatalogActor | null, work: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            // Small first release: serialize mutations and credential rotation to make revocation deterministic.
            await db.query('SELECT pg_advisory_xact_lock(827351920)');
            if (actor) {
                const r = await db.query(`SELECT s.role FROM catalog_sessions s JOIN catalog_credentials c ON c.role=s.role AND c.epoch=s.epoch AND c.enabled
                    WHERE s.token_hash=$1 AND s.expires_at>now() FOR SHARE OF c`, [actor.tokenHash]);
                if (r.rows[0]?.role !== actor.role) throw new CatalogError('SESSION_EXPIRED', 401);
            }
            const result = await work(db); await db.query('COMMIT'); return result;
        } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { db.release(); }
    }
    async categories(actor: CatalogActor | null): Promise<CatalogCategory[]> {
        requireSession(actor);
        return (await this.pool.query(`SELECT c.id,c.name FROM catalog_categories c WHERE $1='admin' OR EXISTS(
            SELECT 1 FROM catalog_tools t JOIN catalog_versions v ON v.tool_id=t.id WHERE t.category_id=c.id AND t.deleted_at IS NULL
            AND v.published AND (t.visibility='public' OR (t.visibility='technicians' AND $1='technician'))) ORDER BY c.name`, [actor?.role ?? null])).rows;
    }
    async tools(actor: CatalogActor | null): Promise<CatalogTool[]> {
        requireSession(actor);
        const role = actor?.role ?? null;
        const rows = (await this.pool.query(`SELECT t.*,c.name AS category_name FROM catalog_tools t JOIN catalog_categories c ON c.id=t.category_id
            WHERE t.deleted_at IS NULL AND ($1='admin' OR t.visibility='public' OR (t.visibility='technicians' AND $1='technician'))
            AND ($1='admin' OR EXISTS(SELECT 1 FROM catalog_versions v WHERE v.tool_id=t.id AND v.published)) ORDER BY t.name`, [role])).rows;
        const versions = (await this.pool.query(`SELECT v.id,v.tool_id,v.version,v.file_name,v.size,v.sha256,v.verified,v.approved,v.published,v.created_at,v.object_path
            FROM catalog_versions v JOIN catalog_tools t ON t.id=v.tool_id WHERE t.id=ANY($1::uuid[]) AND ($2='admin' OR v.published) ORDER BY v.created_at DESC`, [rows.map(r => r.id), role])).rows;
        return rows.map(row => ({ id: row.id, name: row.name, description: row.description, categoryId: row.category_id,
            categoryName: row.category_name, type: row.type, compatibility: row.compatibility, tags: row.tags,
            requiresAdmin: row.requires_admin, visibility: row.visibility,
            versions: versions.filter(v => v.tool_id === row.id).map(v => this.version(v)) }));
    }
    private version(v: Record<string, any>): CatalogVersion {
        return { id: v.id, version: v.version, fileName: v.file_name, size: Number(v.size), sha256: v.sha256?.trim() ?? null,
            verified: v.verified, approved: v.approved, published: v.published, createdAt: v.created_at.toISOString(), source: catalogFileSource(v.object_path) };
    }
    async addCategory(actor: CatalogActor, input: unknown) {
        requireAdmin(actor.role); const data = parse(categorySchema, input), categoryId = randomUUID();
        return this.transaction(actor, async db => {
            await db.query('INSERT INTO catalog_categories(id,name) VALUES($1,$2)', [categoryId, data.name]);
            await audit(db, actor.role, actor.tokenHash, 'category.create', categoryId);
            return { id: categoryId, name: data.name };
        });
    }
    async createTool(actor: CatalogActor, input: unknown) {
        requireAdmin(actor.role); const data = parse(toolSchema, input), toolId = randomUUID();
        return this.transaction(actor, async db => {
            await db.query(`INSERT INTO catalog_tools(id,name,description,category_id,type,compatibility,tags,requires_admin,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [toolId, data.name, data.description, data.categoryId, data.type, data.compatibility, JSON.stringify(data.tags), data.requiresAdmin, data.visibility]);
            await audit(db, actor.role, actor.tokenHash, 'tool.create', toolId); return { id: toolId };
        });
    }
    async editCategory(actor: CatalogActor, categoryId: string, input: unknown) {
        requireAdmin(actor.role); const data = parse(categorySchema, input);
        return this.transaction(actor, async db => {
            const result = await db.query('UPDATE catalog_categories SET name=$2 WHERE id=$1', [categoryId,data.name]);
            if (!result.rowCount) throw new CatalogError('NOT_FOUND',404);
            await audit(db,actor.role,actor.tokenHash,'category.edit',categoryId); return { ok:true };
        });
    }
    async editTool(actor: CatalogActor, toolId: string, input: unknown) {
        requireAdmin(actor.role); const data = parse(toolSchema, input);
        return this.transaction(actor, async db => {
            const r = await db.query(`UPDATE catalog_tools SET name=$2,description=$3,category_id=$4,type=$5,compatibility=$6,tags=$7,requires_admin=$8,visibility=$9 WHERE id=$1 AND deleted_at IS NULL`,
                [toolId, data.name, data.description, data.categoryId, data.type, data.compatibility, JSON.stringify(data.tags), data.requiresAdmin, data.visibility]);
            if (!r.rowCount) throw new CatalogError('NOT_FOUND', 404);
            await audit(db, actor.role, actor.tokenHash, 'tool.edit', toolId); return { ok: true };
        });
    }
    async upload(actor: CatalogActor, toolId: string, input: unknown) {
        requireAdmin(actor.role); const data = parse(uploadSchema, input), versionId = randomUUID();
        const path = `catalog/${toolId}/${versionId}/${data.fileName}`;
        const contentType = 'application/octet-stream';
        return this.transaction(actor, async db => {
            if (!(await db.query('SELECT id FROM catalog_tools WHERE id=$1 AND deleted_at IS NULL', [toolId])).rowCount) throw new CatalogError('NOT_FOUND', 404);
            await db.query(`INSERT INTO catalog_versions(id,tool_id,version,file_name,size,object_path,content_type,upload_owner,upload_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '20 minutes')`,
                [versionId, toolId, data.version, data.fileName, data.size, path, contentType, actor.tokenHash]);
            const uploadUrl = await this.storage.upload(path, data.size, contentType);
            await audit(db, actor.role, actor.tokenHash, 'version.upload_requested', versionId);
            return { versionId, uploadUrl, contentType };
        });
    }
    async finalize(actor: CatalogActor, versionId: string) {
        requireAdmin(actor.role);
        // No client-provided URL/hash/path is accepted. Read the immutable server-owned object.
        const row = (await this.pool.query(`SELECT v.* FROM catalog_versions v JOIN catalog_tools t ON t.id=v.tool_id
            WHERE v.id=$1 AND t.deleted_at IS NULL AND v.upload_owner=$2 AND v.upload_expires_at>now()`, [versionId, actor.tokenHash])).rows[0];
        if (!row) throw new CatalogError('UPLOAD_EXPIRED_OR_UNAVAILABLE', 409);
        if (row.verified) return { sha256: row.sha256.trim() };
        const sha256 = await this.storage.verify(row.object_path, Number(row.size), row.file_name);
        return this.transaction(actor, async db => {
            const r = await db.query(`UPDATE catalog_versions v SET verified=true,sha256=$2 FROM catalog_tools t
                WHERE v.id=$1 AND t.id=v.tool_id AND t.deleted_at IS NULL AND v.upload_owner=$3 AND v.upload_expires_at>now() AND NOT v.verified`, [versionId, sha256, actor.tokenHash]);
            if (!r.rowCount) throw new CatalogError('UPLOAD_EXPIRED_OR_UNAVAILABLE', 409);
            await audit(db, actor.role, actor.tokenHash, 'version.verified', versionId); return { sha256 };
        });
    }
    async publish(actor: CatalogActor, versionId: string, published: boolean) {
        requireAdmin(actor.role);
        return this.transaction(actor, async db => {
            const r = await db.query(`UPDATE catalog_versions v SET published=$2,approved=CASE WHEN $2 THEN true ELSE approved END
                FROM catalog_tools t WHERE v.id=$1 AND t.id=v.tool_id AND t.deleted_at IS NULL AND (NOT $2 OR (v.verified AND v.sha256 IS NOT NULL))`, [versionId, published]);
            if (!r.rowCount) throw new CatalogError('VERSION_NOT_VERIFIED_OR_UNAVAILABLE', 409);
            await audit(db, actor.role, actor.tokenHash, published ? 'version.approve_publish' : 'version.unpublish', versionId); return { ok: true };
        });
    }
    async remove(actor: CatalogActor, toolId: string) {
        requireAdmin(actor.role);
        return this.transaction(actor, async db => {
            const r = await db.query('UPDATE catalog_tools SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1', [toolId]);
            if (!r.rowCount) throw new CatalogError('NOT_FOUND', 404);
            await db.query('UPDATE catalog_versions SET published=false WHERE tool_id=$1', [toolId]);
            await audit(db, actor.role, actor.tokenHash, 'tool.remove', toolId); return { ok: true };
        });
    }
    async download(actor: CatalogActor | null, versionId: string) {
        requireSession(actor);
        return this.transaction(actor, async db => {
            const row = (await db.query(`SELECT v.object_path,t.visibility FROM catalog_versions v JOIN catalog_tools t ON t.id=v.tool_id
                WHERE v.id=$1 AND v.published AND v.approved AND v.verified AND t.deleted_at IS NULL FOR SHARE OF t,v`, [versionId])).rows[0];
            if (!row || !canRead(row.visibility, actor?.role ?? null)) throw new CatalogError('DOWNLOAD_DENIED', 404);
            const source = catalogFileSource(row.object_path);
            const url = source.kind === 'github-release' ? row.object_path : await this.storage.download(row.object_path);
            if (actor) await audit(db, actor.role, actor.tokenHash, 'version.download_issued', versionId);
            return { url, expiresInSeconds: source.kind === 'private-blob' ? 60 : null, public: source.kind === 'github-release' };
        });
    }
    async changePassword(actor: CatalogActor, input: unknown) {
        requireAdmin(actor.role); const data = parse(credentialSchema, input);
        return this.transaction(actor, async db => { await rotateCredential(db, data.role, data.password, actor); return { ok: true, reloginRequired: data.role === 'admin' }; });
    }
    async revoke(actor: CatalogActor, role: 'technician' | 'admin') {
        requireAdmin(actor.role);
        return this.transaction(actor, async db => {
            await db.query('UPDATE catalog_credentials SET epoch=epoch+1 WHERE role=$1', [role]);
            await db.query('DELETE FROM catalog_sessions WHERE role=$1', [role]);
            await audit(db, actor.role, actor.tokenHash, 'session.revoke.' + role); return { ok: true, reloginRequired: role === 'admin' };
        });
    }
    async history(actor: CatalogActor): Promise<CatalogAudit[]> {
        requireAdmin(actor.role);
        return (await this.pool.query('SELECT id,action,role,resource_id,created_at FROM catalog_audit ORDER BY created_at DESC LIMIT 100')).rows.map(r =>
            ({ id: r.id, action: r.action, role: r.role, resourceId: r.resource_id, createdAt: r.created_at.toISOString() }));
    }
}

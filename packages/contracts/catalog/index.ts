export type CatalogRole = 'technician' | 'admin';
export type CatalogVisibility = 'public' | 'technicians' | 'admin';
export interface CatalogSession { role: CatalogRole; csrfToken: string; expiresAt: string }
export interface CatalogCategory { id: string; name: string }
export interface CatalogTool {
    id: string; name: string; description: string; categoryId: string; categoryName: string;
    type: string; compatibility: string; tags: string[]; requiresAdmin: boolean;
    visibility: CatalogVisibility; versions: CatalogVersion[];
}
export interface CatalogVersion {
    id: string; version: string; fileName: string; size: number; sha256: string | null;
    verified: boolean; approved: boolean; published: boolean; createdAt: string;
    source?: { kind: 'private-blob' } | { kind: 'github-release'; repository: string; tag: string; assetName: string; public: true };
}
export interface CatalogAudit { id: string; action: string; role: CatalogRole; resourceId: string | null; createdAt: string }

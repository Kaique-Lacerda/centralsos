import { CatalogError } from './Validation.js';
import type { CatalogVersion } from '../../packages/contracts/catalog/index.js';
export const legacyRepository = 'Kaique-Lacerda/centralsos';
const prefix = `https://github.com/${legacyRepository}/releases/download/`;
export function githubAssetReference(tag: string, assetName: string) {
    if (!/^tools-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
        || !/^[\p{L}\p{N} _().-]+\.(exe|msi|zip)$/iu.test(assetName) || assetName.length > 180) throw new CatalogError('LEGACY_SOURCE_INVALID');
    return prefix + tag + '/' + encodeURIComponent(assetName);
}
export function catalogFileSource(reference: string): NonNullable<CatalogVersion['source']> {
    if (reference.startsWith('catalog/') && !reference.includes('..') && !reference.includes('://')) return { kind: 'private-blob' };
    if (reference.startsWith(prefix)) {
        const parts = reference.slice(prefix.length).split('/');
        try {
            if (parts.length === 2) {
                const assetName = decodeURIComponent(parts[1]);
                if (githubAssetReference(parts[0],assetName) === reference) return { kind:'github-release',repository:legacyRepository,tag:parts[0],assetName,public:true };
            }
        } catch { /* Fail closed for invalid or noncanonical references. */ }
    }
    throw new CatalogError('FILE_SOURCE_INVALID',409);
}

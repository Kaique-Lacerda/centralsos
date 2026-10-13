import { createHash } from 'node:crypto';
import { get, issueSignedToken, presignUrl } from '@vercel/blob';
import { CatalogError } from './Validation.js';
export interface CatalogStorage {
    upload(path: string, size: number, contentType: string): Promise<string>;
    verify(path: string, size: number, fileName: string): Promise<string>;
    download(path: string): Promise<string>;
}
export function verifyHeader(header: Buffer, fileName: string) {
    const extension = fileName.split('.').pop()?.toLowerCase();
    let valid = false;
    if (extension === 'exe' && header.length >= 64 && header.toString('ascii', 0, 2) === 'MZ') {
        const offset = header.readUInt32LE(60);
        valid = offset >= 64 && offset + 4 <= header.length && header.subarray(offset, offset + 4).equals(Buffer.from([80,69,0,0]));
    }
    if (extension === 'msi') valid = header.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    if (extension === 'zip') valid = ['504b0304', '504b0506', '504b0708'].includes(header.subarray(0, 4).toString('hex'));
    if (!valid) throw new CatalogError('FILE_FORMAT_INVALID');
}
export class PrivateBlobStorage implements CatalogStorage {
    async upload(path: string, size: number, contentType: string) {
        const validUntil = Date.now() + 10 * 60 * 1000;
        const token = await issueSignedToken({ pathname: path, operations: ['put'], validUntil, maximumSizeInBytes: size, allowedContentTypes: [contentType] });
        return (await presignUrl(token, { operation: 'put', access: 'private', pathname: path, validUntil,
            maximumSizeInBytes: size, allowedContentTypes: [contentType], allowOverwrite: false, addRandomSuffix: false })).presignedUrl;
    }
    async verify(path: string, size: number, fileName: string) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
        try {
            const result = await get(path, { access: 'private', useCache: false, abortSignal: controller.signal });
            if (!result || result.statusCode !== 200) throw new CatalogError('UPLOAD_NOT_FOUND', 409);
            const reader = result.stream.getReader(), hash = createHash('sha256');
            let bytes = 0, header = Buffer.alloc(0);
            try {
                while (true) {
                    const part = await reader.read(); if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > size || bytes > 100 * 1024 * 1024) throw new CatalogError('FILE_SIZE_INVALID');
                    if (header.length < 65536) header = Buffer.concat([header, Buffer.from(part.value).subarray(0, 65536 - header.length)]);
                    hash.update(part.value);
                }
            } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
            if (bytes !== size) throw new CatalogError('FILE_SIZE_INVALID');
            verifyHeader(header, fileName);
            return hash.digest('hex');
        } finally { clearTimeout(timer); }
    }
    async download(path: string) {
        const validUntil = Date.now() + 60000;
        const token = await issueSignedToken({ pathname: path, operations: ['get'], validUntil });
        return (await presignUrl(token, { operation: 'get', access: 'private', pathname: path, validUntil })).presignedUrl;
    }
}

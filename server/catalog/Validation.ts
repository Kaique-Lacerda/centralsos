import { z } from 'zod';
export class CatalogError extends Error {
    constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
export const roleSchema = z.enum(['technician', 'admin']);
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const loginSchema = z.object({ role: roleSchema, password: z.string().min(1).max(128) }).strict();
export const toolSchema = z.object({
    name: text(120), description: text(2000), categoryId: z.uuid(), type: text(60), compatibility: text(160),
    tags: z.array(text(40)).max(20), requiresAdmin: z.boolean(), visibility: z.enum(['public','technicians','admin'])
}).strict();
export const categorySchema = z.object({ name: text(80) }).strict();
export const uploadSchema = z.object({
    version: text(60), fileName: z.string().min(1).max(180).regex(/^[\p{L}\p{N} _().-]+\.(exe|msi|zip)$/iu),
    size: z.number().int().positive().max(100 * 1024 * 1024)
}).strict();
export const credentialSchema = z.object({ role: roleSchema, password: z.string().min(14).max(128) }).strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new CatalogError('INVALID_INPUT');
    return result.data;
}
export function id(value: string): string { return parse(z.uuid(), value); }
export function canRead(visibility: string, role: string | null): boolean {
    return role === 'admin' || (role === 'technician' && ['public', 'technicians'].includes(visibility));
}
export function requireSession<T>(actor: T | null): asserts actor is T {
    if (!actor) throw new CatalogError('SESSION_REQUIRED', 401);
}
export function requireAdmin(role: string | null) { if (role !== 'admin') throw new CatalogError('ACCESS_DENIED', 403); }
export function validatePassword(password: string) {
    if (password.length < 14 || password.length > 128 || password.toLowerCase() === 'sosmr1234' || /[\x00\r\n]/.test(password)) throw new CatalogError('PASSWORD_POLICY');
}

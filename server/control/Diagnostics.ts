import type { Pool } from 'pg';
import { ApiError } from './ControlBackend.js';
import { NativeAuthError } from './NativeAuthentication.js';
import { AdministrativeError, controlConfiguration, databaseConfiguration, type Settings } from './Configuration.js';
import { migrationStatus, type Migration } from './Migrations.js';

/** Only finite codes leave the backend. Never serialize error.message, SQL,
 * URL, headers, request body, subject, IP, cookie or credential. */
export function diagnosticCode(error: unknown): string {
    if (error instanceof AdministrativeError) return error.code;
    if (error instanceof NativeAuthError) return error.code;
    if (error instanceof ApiError) {
        if (error.message.startsWith('Protocolo incompatível') || error.message.startsWith('Protocolo do resultado incompatível')) return 'PROTOCOL_MISMATCH';
        if (error.message === 'Código inválido, expirado ou já utilizado.' || error.message === 'Perfil não corresponde ao pareamento.') return 'ENROLLMENT_REJECTED';
        return ({ 401: 'AUTHENTICATION_REQUIRED', 403: 'AUTHORIZATION_DENIED', 409: 'STATE_CONFLICT', 429: 'RATE_LIMITED' } as Record<number, string>)[error.status] ?? 'CONTRACT_OR_STATE_REJECTED';
    }
    const code = (error as { code?: unknown })?.code;
    if (code === '42P01') return 'MIGRATION_REQUIRED';
    if (code === '57014' || code === '55P03') return 'DATABASE_TIMEOUT';
    if (typeof code === 'string' && (/^(08|28)/.test(code) || ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(code))) return 'DATABASE_UNAVAILABLE';
    return 'BACKEND_FAILURE';
}
export function safeRequestDiagnostic(path: string, error: unknown) {
    const area = path.startsWith('/api/control/auth/native/') ? 'native-auth' : path === '/api/agent/enroll' ? 'enrollment' : path.startsWith('/api/agent/') ? 'agent' : 'control';
    return { event: 'control.request_failed', area, code: diagnosticCode(error) };
}
export async function administrativeDiagnostics(env: Settings, pool: Pool | null, migrations: Migration[]) {
    const report: { component: string; code: string }[] = [];
    report.push({ component: 'oidc-configuration', code: ['CONTROL_OIDC_ISSUER', 'CONTROL_OIDC_CLIENT_ID', 'CONTROL_OIDC_CLIENT_SECRET'].every(key => env[key]) ? 'CONFIGURED_NOT_HOMOLOGATED' : 'OIDC_NOT_CONFIGURED' });
    for (const [component, check] of [
        ['configuration', () => controlConfiguration(env)],
        ['database-configuration', () => databaseConfiguration(env, true)]
    ] as const) {
        try { check(); report.push({ component, code: 'CONFIGURED' }); }
        catch (error) { report.push({ component, code: diagnosticCode(error) }); }
    }
    if (!pool) return report;
    try {
        const status = await migrationStatus(pool, migrations);
        report.push({ component: 'migrations', code: status.pending.length ? 'MIGRATION_REQUIRED' : 'CURRENT' });
    } catch (error) { report.push({ component: 'migrations', code: diagnosticCode(error) }); }
    // Configuration presence is not proof of OIDC login, HTTPS publication or
    // enrollment. Those require the integration/homologation checklist.
    return report;
}

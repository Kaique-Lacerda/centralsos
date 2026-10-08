import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ControlState } from './Repository.js';
import { AdministrativeError } from './Configuration.js';
import { migrationStatus, type Migration } from './Migrations.js';

const label = z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const uuid = z.uuid().transform(value => value.toLowerCase());
export const provisioningSchema = z.object({
    company: z.object({ id: uuid, name: label }).strict(),
    environment: z.object({ id: uuid, name: label }).strict(),
    operator: z.object({ subject: z.string().min(1).max(256).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)), name: label }).strict(),
    role: z.enum(['viewer', 'operator', 'admin'])
}).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function provision(pool: Pool, migrations: Migration[], input: unknown, options: { actor: string; dryRun: boolean; confirmRoleChange?: boolean }) {
    const parsed = provisioningSchema.safeParse(input);
    if (!parsed.success) throw new AdministrativeError('PROVISIONING_INPUT_INVALID');
    if (!options.actor || /[\x00-\x1f\x7f]/.test(options.actor) || options.actor.length > 256) throw new AdministrativeError('ADMINISTRATION_NOT_AUTHORIZED');
    const data = parsed.data, client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Same lock order for all administrative calls. Coordinate with migrations,
        // domain transitions and native session lookups on every Backend replica.
        for (const lock of [827351901, 827351902, 827351903]) await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
        if ((await migrationStatus(client, migrations)).pending.length) throw new AdministrativeError('MIGRATION_REQUIRED');
        const state = (await client.query('SELECT state FROM central_sos_control_state WHERE id=1 FOR UPDATE')).rows[0]?.state as ControlState | undefined;
        if (!state) throw new AdministrativeError('MIGRATION_SCHEMA_MISSING');
        const environment = state.environments.find(row => row.id === data.environment.id);
        if (environment && environment.companyId !== data.company.id) throw new AdministrativeError('ENVIRONMENT_COMPANY_CONFLICT');
        const company = (await client.query('SELECT name FROM control_companies WHERE id=$1', [data.company.id])).rows[0];
        const user = (await client.query('SELECT display_name, enabled FROM control_users WHERE subject=$1', [data.operator.subject])).rows[0];
        if (user && !user.enabled) throw new AdministrativeError('OPERATOR_DISABLED');
        const member = (await client.query('SELECT role FROM control_memberships WHERE subject=$1 AND company_id=$2', [data.operator.subject, data.company.id])).rows[0];
        const roleChangeRequiresConfirmation = !!member && member.role !== data.role;
        if (roleChangeRequiresConfirmation && !options.dryRun && !options.confirmRoleChange) throw new AdministrativeError('ROLE_CHANGE_CONFIRMATION_REQUIRED');
        const changes = {
            company: !company ? 'created' : company.name !== data.company.name ? 'renamed' : 'unchanged',
            environment: !environment ? 'created' : environment.name !== data.environment.name ? 'renamed' : 'unchanged',
            operator: !user ? 'created' : user.display_name !== data.operator.name ? 'renamed' : 'unchanged',
            membership: !member ? 'created' : member.role !== data.role ? 'role_changed' : 'unchanged',
            previousRole: member?.role ?? null, role: data.role
        };
        const changed = [changes.company, changes.environment, changes.operator, changes.membership].some(value => value !== 'unchanged');
        if (changed && !options.dryRun) {
            await client.query('INSERT INTO control_companies(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name', [data.company.id, data.company.name]);
            await client.query('INSERT INTO control_users(subject,display_name) VALUES($1,$2) ON CONFLICT(subject) DO UPDATE SET display_name=excluded.display_name', [data.operator.subject, data.operator.name]);
            await client.query('INSERT INTO control_memberships(subject,company_id,role) VALUES($1,$2,$3) ON CONFLICT(subject,company_id) DO UPDATE SET role=excluded.role', [data.operator.subject, data.company.id, data.role]);
            if (environment) environment.name = data.environment.name;
            else state.environments.push({ ...data.environment, companyId: data.company.id });
            await client.query('UPDATE central_sos_control_state SET state=$1::jsonb, updated_at=now() WHERE id=1', [JSON.stringify(state)]);
            await client.query('INSERT INTO control_administrative_audit(id,actor_hash,subject_hash,company_id,environment_id,changes) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), hash(options.actor), hash(data.operator.subject), data.company.id, data.environment.id, JSON.stringify(changes)]);
        }
        await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
        return { dryRun: options.dryRun, changed, roleChangeRequiresConfirmation, changes };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
}

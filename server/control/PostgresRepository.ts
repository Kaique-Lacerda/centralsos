import type { Pool } from 'pg';
import type { ControlState, Repository } from './Repository.js';
/** Durable reference adapter. A transaction-scoped lock serializes MVP transitions across instances. */
export class PostgresRepository implements Repository {
    constructor(private pool: Pool) { }
    async transaction<T>(operation: (state: ControlState) => T | Promise<T>): Promise<T> {
        const c = await this.pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('SELECT pg_advisory_xact_lock(827351902)');
            const state = (await c.query('SELECT state FROM central_sos_control_state WHERE id = 1 FOR UPDATE')).rows[0]?.state as ControlState | undefined;
            if (!state)
                throw new Error('Migração do Control ausente.');
            const result = await operation(state);
            await c.query('UPDATE central_sos_control_state SET state = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(state)]);
            await c.query('COMMIT');
            return result;
        }
        catch (e) {
            await c.query('ROLLBACK');
            throw e;
        }
        finally {
            c.release();
        }
    }
}

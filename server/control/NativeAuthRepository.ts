import type { Pool, PoolClient } from 'pg';
import type { Actor } from './Repository.js';

export interface NativeTransaction {
    id: string; deviceHash: string; code: string; challenge: string; expires: number; consumed: boolean;
    polls: number; failures: number; lastPoll: number; subject: string | null;
    oidc?: { stateHash: string; browserHash: string; verifierCipher: string; nonceHash: string; used: boolean };
    browser?: { hash: string; csrfHash: string; subject: string };
    approved: boolean;
}
export interface NativeState {
    transactions: NativeTransaction[];
    sessions: { hash: string; subject: string; expires: number; created: number; revoked: boolean }[];
    limits: { hash: string; window: number; attempts: number }[];
    audit: { timestamp: number; subject: string | null; event: 'confirmed' | 'session_created' | 'logout' | 'session_limit'; outcome: string }[];
}
export interface NativeStore { state: NativeState; actor(subject: string): Promise<Actor | null> }
export interface NativeAuthRepository { transaction<T>(work: (store: NativeStore) => Promise<T>): Promise<T> }
export const emptyNativeState = (): NativeState => ({ transactions: [], sessions: [], limits: [], audit: [] });

/** Durable, bounded reference store; one transaction-scoped lock across all replicas. */
export class PostgresNativeAuthRepository implements NativeAuthRepository {
    constructor(private pool: Pool) {}
    async transaction<T>(work: (store: NativeStore) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(827351903)');
            const state = (await client.query('SELECT state FROM control_native_auth_state WHERE id=1 FOR UPDATE')).rows[0]?.state as NativeState | undefined;
            if (!state) throw new Error('Native auth migration required');
            const result = await work({ state, actor: subject => readActor(client, subject) });
            await client.query('UPDATE control_native_auth_state SET state=$1::jsonb, updated_at=now() WHERE id=1', [JSON.stringify(state)]);
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
}
async function readActor(client: PoolClient, subject: string): Promise<Actor | null> {
    const row = (await client.query('SELECT subject, display_name FROM control_users WHERE subject=$1 AND enabled=true', [subject])).rows[0];
    if (!row) return null;
    const memberships = (await client.query('SELECT company_id AS "companyId", role FROM control_memberships WHERE subject=$1', [subject])).rows;
    return { id: row.subject, name: row.display_name, memberships };
}

import type { Pool } from 'pg';
import { ApiError, digest } from './ControlBackend.js';
/** PostgreSQL window is shared across replicas; IP is supplied only by the trusted HTTP host. */
export async function limitEnrollment(pool: Pool, source: string) {
    const minute = Math.floor(Date.now() / 60000);
    const row = (await pool.query(`INSERT INTO control_enrollment_limits(source_hash, window, attempts)
    VALUES($1,$2,1) ON CONFLICT(source_hash) DO UPDATE SET window=$2,
    attempts=CASE WHEN control_enrollment_limits.window=$2 THEN control_enrollment_limits.attempts+1 ELSE 1 END
    RETURNING attempts`, [digest(source), minute])).rows[0];
    if (!row || row.attempts > 10)
        throw new ApiError(429, 'Limite de tentativas de pareamento; aguarde um minuto.');
}

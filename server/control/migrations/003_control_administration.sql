BEGIN;
-- Administrative metadata only. Preserve the existing Control/NativeAuth stores
-- and existing memberships; legacy data is never deleted or silently adopted.
CREATE TABLE control_companies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200)
);
CREATE TABLE control_administrative_audit (
  id uuid PRIMARY KEY,
  timestamp timestamptz NOT NULL DEFAULT now(),
  actor_hash char(64) NOT NULL,
  subject_hash char(64) NOT NULL,
  company_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  changes jsonb NOT NULL
);
COMMIT;

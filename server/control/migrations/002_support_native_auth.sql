BEGIN;
-- Separate from browser sessions and Agent credentials. Bounded state under a shared
-- transaction-scoped lock; no process-local auth persistence or fallback store.
CREATE TABLE control_native_auth_state (
  id smallint PRIMARY KEY CHECK (id=1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO control_native_auth_state(id,state) VALUES
  (1,'{"transactions":[],"sessions":[],"limits":[],"audit":[]}');
COMMIT;

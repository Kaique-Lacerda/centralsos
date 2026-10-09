BEGIN;
-- MVP single-document persistence, atomic pairing/command transitions across backend replicas.
-- Repository boundary permits normalization without changing HTTP contracts.
CREATE TABLE central_sos_control_state (id smallint PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO central_sos_control_state (id, state) VALUES (1, '{"environments":[],"devices":[],"commands":[],"results":[],"pairing":[],"audit":[]}');
CREATE TABLE control_users (subject text PRIMARY KEY, display_name text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE control_memberships (subject text REFERENCES control_users(subject), company_id uuid NOT NULL, role text NOT NULL CHECK (role IN ('viewer','operator','admin')), PRIMARY KEY(subject, company_id));
CREATE TABLE control_sessions (token_hash char(64) PRIMARY KEY, subject text NOT NULL REFERENCES control_users(subject), expires_at timestamptz NOT NULL);
CREATE INDEX control_sessions_expiry ON control_sessions(expires_at);
CREATE TABLE control_enrollment_limits (source_hash char(64) PRIMARY KEY, window_start bigint NOT NULL, attempts integer NOT NULL);
COMMIT;

CREATE TABLE catalog_credentials (
    role text PRIMARY KEY CHECK(role IN ('technician','admin')),
    password_hash text NOT NULL, epoch integer NOT NULL DEFAULT 1,
    enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_sessions (
    token_hash char(64) PRIMARY KEY, role text NOT NULL REFERENCES catalog_credentials(role),
    epoch integer NOT NULL, csrf_hash char(64) NOT NULL,
    expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_sessions_expiration ON catalog_sessions(expires_at);
CREATE TABLE catalog_login_limits (
    key_hash char(64) PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL
);
CREATE TABLE catalog_categories (id uuid PRIMARY KEY, name text UNIQUE NOT NULL CHECK(length(name) BETWEEN 1 AND 80));
CREATE TABLE catalog_tools (
    id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL,
    category_id uuid NOT NULL REFERENCES catalog_categories(id), type text NOT NULL,
    compatibility text NOT NULL, tags jsonb NOT NULL DEFAULT '[]', requires_admin boolean NOT NULL,
    visibility text NOT NULL CHECK(visibility IN ('public','technicians','admin')),
    deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_versions (
    id uuid PRIMARY KEY, tool_id uuid NOT NULL REFERENCES catalog_tools(id), version text NOT NULL,
    file_name text NOT NULL, size bigint NOT NULL CHECK(size > 0), object_path text UNIQUE NOT NULL,
    content_type text NOT NULL, upload_owner char(64) NOT NULL, upload_expires_at timestamptz NOT NULL,
    sha256 char(64), verified boolean NOT NULL DEFAULT false, approved boolean NOT NULL DEFAULT false,
    published boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tool_id,version), CHECK(NOT published OR (verified AND approved AND sha256 IS NOT NULL))
);
CREATE TABLE catalog_audit (
    id uuid PRIMARY KEY, role text NOT NULL CHECK(role IN ('technician','admin')),
    session_ref char(64) NOT NULL, action text NOT NULL,
    resource_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);

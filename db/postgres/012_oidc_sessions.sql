-- @feature F-001
-- @feature F-006
-- @feature F-009
-- @feature F-012

CREATE TABLE IF NOT EXISTS bloggers_oidc_session_control (
  control_key text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
  revoked_all_at bigint CHECK (revoked_all_at IS NULL OR revoked_all_at > 0),
  revoked_all_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bloggers_oidc_session_control (control_key, generation, updated_at)
VALUES ('global', 1, now())
ON CONFLICT (control_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS bloggers_oidc_sessions (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  principal_id text NOT NULL,
  subject text,
  issuer text,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  issued_at bigint NOT NULL CHECK (issued_at > 0),
  expires_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text,
  generation bigint NOT NULL CHECK (generation >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX IF NOT EXISTS bloggers_oidc_sessions_expiry_idx
ON bloggers_oidc_sessions (expires_at);

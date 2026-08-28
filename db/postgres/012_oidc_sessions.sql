-- @feature F-001
-- @feature F-006
-- @feature F-009
-- @feature F-012

CREATE TABLE IF NOT EXISTS bloggers_oidc_session_control (
  control_key text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1,
  revoked_all_at bigint,
  revoked_all_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bloggers_oidc_session_control (control_key, generation, updated_at)
VALUES ('global', 1, now())
ON CONFLICT (control_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS bloggers_oidc_sessions (
  fingerprint text PRIMARY KEY,
  principal_id text NOT NULL,
  subject text,
  issuer text,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text,
  generation bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_oidc_sessions_expiry_idx
ON bloggers_oidc_sessions (expires_at);

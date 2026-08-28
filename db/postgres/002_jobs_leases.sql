-- @feature F-012
-- Normalize the hot concurrency paths before normalizing the rest of the state document.
-- Jobs use SKIP LOCKED for concurrent workers; operation leases use a unique key.

BEGIN;

CREATE TABLE IF NOT EXISTS bloggers_jobs (
  id text PRIMARY KEY,
  type text NOT NULL,
  blog_id text,
  payload jsonb,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  due_at timestamptz NOT NULL,
  lease_until timestamptz,
  leased_at timestamptz,
  lease_owner text,
  finished_at timestamptz,
  last_error text,
  failure_reason text,
  result jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_jobs_due_idx
  ON bloggers_jobs (due_at, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS bloggers_jobs_lease_idx
  ON bloggers_jobs (lease_until)
  WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS bloggers_jobs_active_dedupe_idx
  ON bloggers_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS bloggers_operation_leases (
  lease_key text PRIMARY KEY,
  lease_id text NOT NULL,
  owner text NOT NULL,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_operation_leases_expiry_idx
  ON bloggers_operation_leases (expires_at);

INSERT INTO bloggers_schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;

COMMIT;

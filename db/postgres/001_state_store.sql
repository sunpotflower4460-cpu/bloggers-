-- @feature F-012
-- Bloggers PostgreSQL foundation.
-- The first PostgreSQL adapter intentionally keeps the existing state document intact
-- and serializes mutations with SELECT ... FOR UPDATE. This minimizes migration risk
-- while making transactions and multi-host workers possible. Domain tables can be
-- normalized in later migrations without changing the Store contract.

BEGIN;

CREATE TABLE IF NOT EXISTS bloggers_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bloggers_state (
  state_key text PRIMARY KEY,
  version integer NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bloggers_schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;

COMMIT;

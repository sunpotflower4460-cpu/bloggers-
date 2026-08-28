-- @feature F-002
-- @feature F-012

CREATE TABLE IF NOT EXISTS bloggers_blogs (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS bloggers_blogs_active_updated_idx
ON bloggers_blogs (active, updated_at DESC);

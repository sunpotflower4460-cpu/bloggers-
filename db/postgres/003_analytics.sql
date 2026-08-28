-- @feature F-007
-- @feature F-012
-- PostgreSQL staged normalization: analytics snapshots leave the global state document.
-- Existing document.analytics rows are promoted transactionally by PostgresRuntimeStore.init().

CREATE TABLE IF NOT EXISTS bloggers_analytics (
  id text PRIMARY KEY,
  blog_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_analytics_blog_time_idx
ON bloggers_analytics (blog_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_analytics_time_idx
ON bloggers_analytics (captured_at DESC);

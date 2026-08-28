-- @feature F-009
-- @feature F-012
-- PostgreSQL staged normalization: audit activities leave the global state document.
-- Existing document.activities rows are promoted transactionally by PostgresRuntimeStore.init().

CREATE TABLE IF NOT EXISTS bloggers_activities (
  id text PRIMARY KEY,
  blog_id text,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_activities_blog_time_idx
ON bloggers_activities (blog_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_activities_time_idx
ON bloggers_activities (created_at DESC);

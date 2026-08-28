-- @feature F-005
-- @feature F-012
-- PostgreSQL staged normalization: AI usage leaves the global state document.
-- Existing document.aiUsage rows are promoted transactionally by PostgresRuntimeStore.init().

CREATE TABLE IF NOT EXISTS bloggers_ai_usage (
  id text PRIMARY KEY,
  blog_id text,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_ai_usage_blog_time_idx
ON bloggers_ai_usage (blog_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_ai_usage_time_idx
ON bloggers_ai_usage (created_at DESC);

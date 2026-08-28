-- @feature F-004
-- @feature F-009
-- @feature F-012
-- PostgreSQL staged normalization: workflow history leaves the global state document.
-- Existing document.workflows rows are promoted transactionally by PostgresRuntimeStore.init().

CREATE TABLE IF NOT EXISTS bloggers_workflows (
  id text PRIMARY KEY,
  blog_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_workflows_blog_started_idx
ON bloggers_workflows (blog_id, started_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_workflows_started_idx
ON bloggers_workflows (started_at DESC);

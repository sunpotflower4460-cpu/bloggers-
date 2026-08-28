-- @feature F-004
-- @feature F-012
-- PostgreSQL staged normalization: Director idea history leaves the global state document.
-- Existing document.ideas rows are promoted transactionally by PostgresEditorialStore.init().

CREATE TABLE IF NOT EXISTS bloggers_ideas (
  id text PRIMARY KEY,
  blog_id text NOT NULL,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_ideas_blog_created_idx
ON bloggers_ideas (blog_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_ideas_created_idx
ON bloggers_ideas (created_at DESC);

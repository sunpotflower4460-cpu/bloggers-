-- @feature F-004
-- @feature F-006
-- @feature F-012
-- PostgreSQL staged normalization: articles and approvals leave the global state document together.
-- PostgresEditorialStore promotes legacy document rows transactionally and resolves approval/article state atomically.

CREATE TABLE IF NOT EXISTS bloggers_articles (
  id text PRIMARY KEY,
  blog_id text NOT NULL,
  idea_id text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS bloggers_articles_blog_updated_idx
ON bloggers_articles (blog_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_articles_status_updated_idx
ON bloggers_articles (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS bloggers_approvals (
  id text PRIMARY KEY,
  blog_id text NOT NULL,
  article_id text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_approvals_status_created_idx
ON bloggers_approvals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS bloggers_approvals_blog_created_idx
ON bloggers_approvals (blog_id, created_at DESC);

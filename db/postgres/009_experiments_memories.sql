-- @feature F-011
-- @feature F-012

CREATE TABLE IF NOT EXISTS bloggers_experiments (
  id text PRIMARY KEY,
  blog_id text NOT NULL,
  article_id text,
  action text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_experiments_blog_status_idx
ON bloggers_experiments (blog_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS bloggers_experiments_article_action_idx
ON bloggers_experiments (article_id, action)
WHERE article_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bloggers_memories (
  id text PRIMARY KEY,
  blog_id text,
  scope text NOT NULL,
  type text NOT NULL,
  source_experiment_id text,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloggers_memories_blog_type_idx
ON bloggers_memories (blog_id, type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS bloggers_memories_source_experiment_idx
ON bloggers_memories (source_experiment_id)
WHERE source_experiment_id IS NOT NULL;

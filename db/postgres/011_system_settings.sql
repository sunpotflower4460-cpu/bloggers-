-- @feature F-006
-- @feature F-008
-- @feature F-012

CREATE TABLE IF NOT EXISTS bloggers_system_settings (
  setting_key text PRIMARY KEY,
  document jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

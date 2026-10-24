-- Migration: Add session expiration support and push subscriptions
BEGIN;

-- Add expired_at column to shopping_sessions
ALTER TABLE shopping_sessions
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMP;

-- Add last_activity_at column if not present
ALTER TABLE shopping_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP;

-- Backfill last_activity_at for existing sessions (use started_at as fallback)
DO $$
BEGIN
  UPDATE shopping_sessions
  SET last_activity_at = COALESCE(last_activity_at, started_at)
  WHERE last_activity_at IS NULL;
END $$;

-- Index for active sessions based on inactivity threshold
CREATE INDEX IF NOT EXISTS idx_active_sessions_last_activity
  ON shopping_sessions (status, last_activity_at)
  WHERE status = 'active';

-- Index to quickly find sessions that have expired
CREATE INDEX IF NOT EXISTS idx_sessions_expired_at
  ON shopping_sessions (expired_at)
  WHERE expired_at IS NOT NULL;

-- Table for push subscription data linked to a session
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(session_id) ON DELETE CASCADE,
  subscription_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index on session_id for fast lookup
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session_id
  ON push_subscriptions (session_id);

-- Record this migration
INSERT INTO schema_migrations (migration_name) VALUES ('20261025_session_expiration.sql')
  ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

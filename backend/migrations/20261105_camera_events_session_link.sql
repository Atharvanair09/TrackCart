-- 20261105_camera_events_session_link.sql
-- Migration: Create camera_events_log with session reference, correlation status, and reconciliation tracking
-- Idempotent and safe to re-run.

BEGIN;

-- 1. Ensure camera_events_log table exists
CREATE TABLE IF NOT EXISTS camera_events_log (
  event_id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  device_id TEXT NOT NULL,
  baseline_id TEXT,
  diff_score REAL,
  consecutive_frames INT,
  classification TEXT,
  mismatch BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending',
  session_id TEXT REFERENCES shopping_sessions(session_id) ON DELETE SET NULL
);

-- 2. Add nullable session_id column referencing shopping_sessions(session_id) if table pre-existed
ALTER TABLE camera_events_log
  ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES shopping_sessions(session_id) ON DELETE SET NULL;

-- 3. Add status column if table pre-existed without it
ALTER TABLE camera_events_log
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';

-- 4. Create indexes for efficient querying and correlation
CREATE INDEX IF NOT EXISTS idx_camera_events_session_id
  ON camera_events_log (session_id);

CREATE INDEX IF NOT EXISTS idx_camera_events_device_status_ts
  ON camera_events_log (device_id, status, timestamp);

-- 5. Record migration if schema_migrations tracking table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (migration_name)
    VALUES ('20261105_camera_events_session_link.sql')
    ON CONFLICT (migration_name) DO NOTHING;
  END IF;
END $$;

COMMIT;



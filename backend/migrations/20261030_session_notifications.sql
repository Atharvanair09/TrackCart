// Migration: Add notification tracking table for push warnings
BEGIN;

CREATE TABLE IF NOT EXISTS session_notifications (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(session_id) ON DELETE CASCADE,
  milestone INTEGER NOT NULL, -- minutes of inactivity (10,13,14)
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_session_notifications ON session_notifications (session_id, milestone);

COMMIT;

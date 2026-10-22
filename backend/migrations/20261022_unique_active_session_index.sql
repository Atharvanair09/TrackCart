/* Migration: enforce single active session per cart */
DO $$
BEGIN
  -- Abort if duplicate active sessions exist
  IF (SELECT COUNT(*) FROM (
        SELECT cart_id FROM shopping_sessions WHERE status = 'active' GROUP BY cart_id HAVING COUNT(*) > 1
      ) dup) > 0 THEN
    RAISE EXCEPTION 'Duplicate active sessions per cart exist. Resolve before applying migration.';
  END IF;
END $$;

-- Create a unique partial index to prevent multiple active sessions per cart
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_session_per_cart ON shopping_sessions (cart_id) WHERE status = 'active';

-- Record migration
INSERT INTO schema_migrations (migration_name) VALUES ('20261022_unique_active_session_index.sql') ON CONFLICT (migration_name) DO NOTHING;

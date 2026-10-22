
BEGIN;

ALTER TABLE inventory_operations
ADD COLUMN IF NOT EXISTS reservation_operation_id BIGINT
REFERENCES inventory_operations(id);

CREATE INDEX IF NOT EXISTS inventory_operations_reservation_link_idx
ON inventory_operations(reservation_operation_id);

INSERT INTO schema_migrations (migration_name)
VALUES ('20261021_inventory_release_link.sql')
ON CONFLICT DO NOTHING;

COMMIT;

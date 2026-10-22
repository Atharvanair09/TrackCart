
BEGIN;

-- Additive product inventory fields.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS reserved_qty INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS reorder_level INTEGER,
  ADD COLUMN IF NOT EXISTS safety_stock INTEGER,
  ADD COLUMN IF NOT EXISTS supplier_lead_time_days INTEGER;

-- Enforce valid values, including on databases where columns already existed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_inventory_qty_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_inventory_qty_nonnegative
      CHECK (inventory_qty IS NULL OR inventory_qty >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_reserved_qty_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_reserved_qty_nonnegative
      CHECK (reserved_qty >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_reserved_not_above_inventory'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_reserved_not_above_inventory
      CHECK (inventory_qty IS NULL OR reserved_qty <= inventory_qty);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_unit_cost_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_unit_cost_nonnegative
      CHECK (unit_cost IS NULL OR unit_cost >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_reorder_level_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_reorder_level_nonnegative
      CHECK (reorder_level IS NULL OR reorder_level >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_safety_stock_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_safety_stock_nonnegative
      CHECK (safety_stock IS NULL OR safety_stock >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND conname = 'products_lead_time_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_lead_time_nonnegative
      CHECK (supplier_lead_time_days IS NULL OR supplier_lead_time_days >= 0);
  END IF;
END $$;

-- One row per logical inventory operation.
CREATE TABLE IF NOT EXISTS inventory_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('reservation', 'sale', 'release', 'restock', 'adjustment')),
  operation_key TEXT NOT NULL UNIQUE,
  session_id TEXT REFERENCES shopping_sessions(session_id),
  sale_id TEXT REFERENCES sales(sale_id),
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

-- Each product may be affected only once per operation.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id BIGINT NOT NULL
    REFERENCES inventory_operations(id),
  product_id TEXT NOT NULL REFERENCES products(product_id),
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('reservation', 'sale', 'release', 'restock', 'adjustment')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  physical_delta INTEGER NOT NULL DEFAULT 0,
  reserved_delta INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (operation_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created
  ON inventory_movements (product_id, created_at);

CREATE INDEX IF NOT EXISTS idx_inventory_operations_session
  ON inventory_operations (session_id, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_migrations (migration_name)
VALUES ('20261021_inventory_foundation.sql')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

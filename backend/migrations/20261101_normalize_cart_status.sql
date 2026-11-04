-- 20261101_normalize_cart_status.sql
-- Migration to normalize cart status vocabulary, enforce allowed values, and validate existing constraint.
-- Idempotent and safe to re‑run.

BEGIN;

-- 1️⃣ Ensure default status is 'available'.
ALTER TABLE carts
  ALTER COLUMN status SET DEFAULT 'available';

-- 2️⃣ Convert any legacy 'active' entries to the new 'available'.
UPDATE carts
  SET status = 'available'
  WHERE status = 'active';

-- 3️⃣ Fail if any cart currently has a status outside the allowed set (including NULL).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM carts
    WHERE status IS NULL OR status NOT IN ('available','occupied')
  ) THEN
    RAISE EXCEPTION 'Unexpected cart status values exist; migration aborted.';
  END IF;
END $$;

-- 4️⃣ Ensure the status column is NOT NULL (application expects only defined values).
DO $$
DECLARE
  rel_oid      OID := 'carts'::regclass;
  schema_name  TEXT;
  col_is_nullable BOOLEAN;
BEGIN
  SELECT n.nspname INTO schema_name
  FROM pg_namespace n
  JOIN pg_class c ON c.relnamespace = n.oid
  WHERE c.oid = rel_oid;

  SELECT is_nullable = 'YES' INTO col_is_nullable
  FROM information_schema.columns
  WHERE table_name = 'carts'
    AND column_name = 'status'
    AND table_schema = schema_name;

  IF col_is_nullable THEN
    ALTER TABLE carts ALTER COLUMN status SET NOT NULL;
  END IF;
END $$;

-- 5️⃣ Validate or create the CHECK constraint on the carts table.
DO $$
DECLARE
  rel_oid        OID := 'carts'::regclass;
  ct_oid         OID;
  ct_type        CHAR;
  ct_validated   BOOLEAN;
  ct_def         TEXT;
  col_type       TEXT;
  expected_def   TEXT;
BEGIN
  -- Resolve the data type of carts.status.
  SELECT pg_catalog.format_type(atttypid, atttypmod) INTO col_type
  FROM pg_attribute
  WHERE attrelid = rel_oid
    AND attname = 'status'
    AND NOT attisdropped;

  -- Look for any constraint named carts_status_check on this relation.
  SELECT oid, contype, convalidated INTO ct_oid, ct_type, ct_validated
  FROM pg_constraint
  WHERE conname = 'carts_status_check'
    AND conrelid = rel_oid
  LIMIT 1;

  IF ct_oid IS NULL THEN
    -- Constraint does not exist – create it.
    ALTER TABLE carts ADD CONSTRAINT carts_status_check CHECK (status IN ('available','occupied'));
  ELSE
    -- Ensure it is a CHECK constraint.
    IF ct_type <> 'c' THEN
      RAISE EXCEPTION 'Constraint carts_status_check exists but is of type % (expected CHECK).', ct_type;
    END IF;

    -- Ensure the constraint is validated.
    IF NOT ct_validated THEN
      RAISE EXCEPTION 'Constraint carts_status_check exists but is not validated.';
    END IF;

    -- Retrieve its definition.
    SELECT pg_get_constraintdef(ct_oid) INTO ct_def;

    -- Build the expected definition based on the column's data type.
    IF col_type LIKE 'character varying%' THEN
      expected_def := 'CHECK ((status = ANY (ARRAY[''available''::character varying, ''occupied''::character varying])))';
    ELSIF col_type = 'text' THEN
      expected_def := 'CHECK ((status = ANY (ARRAY[''available''::text, ''occupied''::text])))';
    ELSE
      RAISE EXCEPTION 'Unsupported data type % for carts.status; cannot validate constraint definition.', col_type;
    END IF;

    IF ct_def <> expected_def THEN
      RAISE EXCEPTION 'Constraint carts_status_check definition mismatch. Expected: % Got: %', expected_def, ct_def;
    END IF;
    -- Existing constraint is correct – nothing further to do.
  END IF;
END $$;

COMMIT;

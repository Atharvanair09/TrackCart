-- Migration: Expiry Tracking, Batch Ledger, Reorder Configuration & Smart Promotions
-- Date: 2026-10-23

BEGIN;

-- Add expiry date, batch number, and target inventory coverage to products
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS batch_number TEXT,
  ADD COLUMN IF NOT EXISTS target_coverage_days INTEGER DEFAULT 14;

-- Batch-level inventory tracking for receiving lots with distinct expiry dates
CREATE TABLE IF NOT EXISTS product_batches (
  id SERIAL PRIMARY KEY,
  batch_id TEXT UNIQUE NOT NULL,
  product_id TEXT REFERENCES products(product_id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  expiry_date DATE NOT NULL,
  received_date DATE DEFAULT CURRENT_DATE,
  supplier TEXT,
  status TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_product_batches_prod ON product_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_product_batches_expiry ON product_batches(expiry_date);

-- Smart Promotions and Discount Offers
CREATE TABLE IF NOT EXISTS product_promotions (
  id SERIAL PRIMARY KEY,
  promo_id TEXT UNIQUE NOT NULL,
  product_id TEXT REFERENCES products(product_id) ON DELETE CASCADE,
  discount_percent NUMERIC(5,2) NOT NULL,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'recommended', -- 'recommended', 'active', 'dismissed'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_promotions_prod ON product_promotions(product_id);

COMMIT;

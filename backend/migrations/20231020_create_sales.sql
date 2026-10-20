/* Migration: create sales and sale_line_items tables */
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  sale_id TEXT UNIQUE NOT NULL,
  session_id TEXT UNIQUE REFERENCES shopping_sessions(session_id) ON DELETE CASCADE,
  subtotal REAL NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0.0825,
  tax_amount REAL NOT NULL,
  total REAL NOT NULL,
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_line_items (
  id SERIAL PRIMARY KEY,
  sale_id TEXT REFERENCES sales(sale_id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(product_id),
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  line_subtotal REAL NOT NULL
);

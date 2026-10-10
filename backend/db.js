const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'smart_cart',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        product_id TEXT UNIQUE NOT NULL,
        tag_uid TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        category TEXT,
        image_url TEXT,
        is_active BOOLEAN DEFAULT true,
        inventory_qty INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS carts (
        id SERIAL PRIMARY KEY,
        cart_id TEXT UNIQUE NOT NULL,
        device_id TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS shopping_sessions (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        user_id TEXT REFERENCES users(user_id),
        cart_id TEXT REFERENCES carts(cart_id),
        status TEXT DEFAULT 'active',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        session_id TEXT REFERENCES shopping_sessions(session_id),
        product_id TEXT REFERENCES products(product_id),
        quantity INTEGER DEFAULT 1,
        unit_price_at_addition REAL NOT NULL,
        subtotal REAL NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS rfid_events_log (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        tag_uid TEXT NOT NULL,
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database initialized.');
  } catch (err) {
    console.error('Error initializing DB:', err);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDb,
};

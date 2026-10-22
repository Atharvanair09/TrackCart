const { Pool } = require('pg');
require('dotenv').config();

// Build pool configuration.
// In production (Render), DATABASE_URL is set as a single connection string.
// In local development, individual DB_* env vars are used.
let poolConfig;
if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    // Render's managed PostgreSQL requires SSL.
    // rejectUnauthorized: false is necessary for Render's self-signed certificates.
    ssl: {
      rejectUnauthorized: false,
    },
  };
} else {
  poolConfig = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'smart_cart',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
  };
}

// --- Safe diagnostic logging (no secrets) ---
{
  const dotenvResult = require('dotenv').config();
  if (dotenvResult.error) {
    console.log('[db] dotenv: no .env file loaded (expected in production)');
  } else {
    console.log(`[db] dotenv: loaded .env with keys: ${Object.keys(dotenvResult.parsed || {}).join(', ')}`);
  }
}

if (process.env.DATABASE_URL) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    const host = dbUrl.hostname;
    console.log(`[db] DATABASE_URL is set (length=${process.env.DATABASE_URL.length})`);
    console.log(`[db] Parsed hostname: "${host}", port: ${dbUrl.port || 5432}, database: "${dbUrl.pathname.slice(1)}"`);
    if (!host.includes('.')) {
      console.error(`[db] WARNING: hostname "${host}" has no domain suffix — this is a Render internal ID that only resolves within Render's private network. Use the External Database URL if your service cannot reach it.`);
    }
  } catch (e) {
    console.error('[db] DATABASE_URL is set but is not a valid URL:', e.message);
  }
} else {
  console.log(`[db] DATABASE_URL is NOT set — using individual env vars`);
  console.log(`[db] host: ${poolConfig.host}, port: ${poolConfig.port}, database: ${poolConfig.database}`);
}

const pool = new Pool(poolConfig);


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
        inventory_qty INTEGER DEFAULT 0,
        reserved_qty INTEGER DEFAULT 0
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

const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}


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

      ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS reserved_qty INTEGER DEFAULT 0;

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

      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        admin_id TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT DEFAULT 'SUPER_ADMIN',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        admin_id TEXT REFERENCES admins(admin_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        sale_id TEXT UNIQUE NOT NULL,
        session_id TEXT UNIQUE REFERENCES shopping_sessions(session_id) ON DELETE SET NULL,
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

      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        movement_id TEXT UNIQUE NOT NULL,
        product_id TEXT REFERENCES products(product_id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        delta INTEGER NOT NULL,
        before_qty INTEGER NOT NULL,
        after_qty INTEGER NOT NULL,
        ref_code TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Extend products table with inventory metrics if not already present
      ALTER TABLE products ADD COLUMN IF NOT EXISTS cost REAL DEFAULT 0;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_level INTEGER DEFAULT 10;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS safety_stock INTEGER DEFAULT 5;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS lead_time_days INTEGER DEFAULT 3;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS target_coverage_days INTEGER DEFAULT 14;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS last_restocked DATE DEFAULT CURRENT_DATE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier TEXT DEFAULT 'General Supplier';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS expiry_date DATE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS batch_number TEXT;

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

      CREATE TABLE IF NOT EXISTS product_promotions (
        id SERIAL PRIMARY KEY,
        promo_id TEXT UNIQUE NOT NULL,
        product_id TEXT REFERENCES products(product_id) ON DELETE CASCADE,
        discount_percent NUMERIC(5,2) NOT NULL,
        reason TEXT NOT NULL,
        status TEXT DEFAULT 'recommended',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
    `);

    // Ensure default admin user is seeded in the database
    const defaultAdminEmail = 'ojharamakant48@gmail.com';
    const defaultAdminPass = 'Sahil@1234567';
    const { hash, salt } = hashPassword(defaultAdminPass);

    await client.query(`
      INSERT INTO admins (admin_id, email, password_hash, salt, full_name, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE 
      SET password_hash = EXCLUDED.password_hash,
          salt = EXCLUDED.salt,
          role = EXCLUDED.role;
    `, ['ADM-001', defaultAdminEmail, hash, salt, 'Store Admin', 'SUPER_ADMIN']);

    console.log(`[db] Admin account verified/seeded in database: ${defaultAdminEmail}`);

    // Ensure products and store catalog are seeded if empty
    const productCountRes = await client.query('SELECT COUNT(*) FROM products');
    if (productCountRes && productCountRes.rows && productCountRes.rows[0] && parseInt(productCountRes.rows[0].count, 10) === 0) {
      console.log('[db] No products found in database. Seeding real store inventory catalog...');

      const initialProducts = [
        {
          product_id: 'PROD-004',
          tag_uid: 'RF994821',
          name: 'Wireless Earbuds',
          category: 'Electronics',
          price: 39.99,
          cost: 22.50,
          inventory_qty: 20,
          reorder_level: 10,
          safety_stock: 5,
          lead_time_days: 3,
          supplier: 'Apex Audio Ltd',
          image_url: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=200'
        },
        {
          product_id: 'PROD001',
          tag_uid: '12500123456',
          name: 'Smart Water Bottle',
          category: 'Accessories',
          price: 19.99,
          cost: 8.50,
          inventory_qty: 8,
          reorder_level: 15,
          safety_stock: 8,
          lead_time_days: 4,
          supplier: 'HydroTech Corp',
          image_url: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=200'
        },
        {
          product_id: 'PROD002',
          tag_uid: 'ABCDEF123456',
          name: 'Organic Granola Bar',
          category: 'Snacks',
          price: 2.49,
          cost: 0.95,
          inventory_qty: 0,
          reorder_level: 30,
          safety_stock: 15,
          lead_time_days: 2,
          supplier: 'NatureBites LLC',
          image_url: 'https://images.unsplash.com/photo-1622484212850-cab3c6a461b3?w=200'
        },
        {
          product_id: 'PROD-005',
          tag_uid: 'RF773190',
          name: 'Cold Brew Coffee 330ml',
          category: 'Beverages',
          price: 3.99,
          cost: 1.40,
          inventory_qty: 42,
          reorder_level: 20,
          safety_stock: 10,
          lead_time_days: 1,
          supplier: 'Artisan Roasters',
          image_url: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=200'
        },
        {
          product_id: 'PROD-006',
          tag_uid: 'RF662104',
          name: 'Organic Trail Mix 200g',
          category: 'Snacks',
          price: 4.79,
          cost: 2.10,
          inventory_qty: 25,
          reorder_level: 12,
          safety_stock: 6,
          lead_time_days: 2,
          supplier: 'NatureBites LLC',
          image_url: 'https://images.unsplash.com/photo-1541832676-9b763b0239ab?w=200'
        },
        {
          product_id: 'PROD-007',
          tag_uid: 'RF551928',
          name: 'Smart Phone Grip Ring',
          category: 'Accessories',
          price: 7.99,
          cost: 2.50,
          inventory_qty: 6,
          reorder_level: 10,
          safety_stock: 5,
          lead_time_days: 5,
          supplier: 'Apex Audio Ltd',
          image_url: 'https://images.unsplash.com/photo-1586105251261-72a756497a11?w=200'
        },
        {
          product_id: 'PROD-008',
          tag_uid: 'RF332918',
          name: 'Electrolyte Energy Drink',
          category: 'Beverages',
          price: 2.99,
          cost: 1.10,
          inventory_qty: 64,
          reorder_level: 25,
          safety_stock: 12,
          lead_time_days: 2,
          supplier: 'Volt Beverages',
          image_url: 'https://images.unsplash.com/photo-1622543925917-763c34d1a86e?w=200'
        },
        {
          product_id: 'PROD-009',
          tag_uid: 'RF882103',
          name: 'Bluetooth Tracker Tag',
          category: 'Electronics',
          price: 24.99,
          cost: 11.00,
          inventory_qty: 14,
          reorder_level: 10,
          safety_stock: 5,
          lead_time_days: 4,
          supplier: 'Apex Audio Ltd',
          image_url: 'https://images.unsplash.com/photo-1572569511254-d8f925fe2cbb?w=200'
        },
        {
          product_id: 'PROD-010',
          tag_uid: 'RF441092',
          name: 'Protein Whey Crisp Bar',
          category: 'Snacks',
          price: 3.29,
          cost: 1.30,
          inventory_qty: 50,
          reorder_level: 20,
          safety_stock: 10,
          lead_time_days: 2,
          supplier: 'FitFuel Pro',
          image_url: 'https://images.unsplash.com/photo-1622484212850-cab3c6a461b3?w=200'
        },
        {
          product_id: 'PROD-011',
          tag_uid: 'RF119283',
          name: 'Microfiber Cleaning Cloth',
          category: 'Accessories',
          price: 2.99,
          cost: 0.80,
          inventory_qty: 3,
          reorder_level: 15,
          safety_stock: 5,
          lead_time_days: 3,
          supplier: 'Apex Audio Ltd',
          image_url: 'https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?w=200'
        }
      ];

      for (const p of initialProducts) {
        await client.query(`
          INSERT INTO products (
            product_id, tag_uid, name, price, cost, category, 
            inventory_qty, reorder_level, safety_stock, lead_time_days, supplier, image_url, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
          ON CONFLICT (product_id) DO NOTHING
        `, [
          p.product_id, p.tag_uid, p.name, p.price, p.cost, p.category,
          p.inventory_qty, p.reorder_level, p.safety_stock, p.lead_time_days, p.supplier, p.image_url
        ]);
      }

      // Ensure test carts exist
      await client.query(`
        INSERT INTO carts (cart_id, device_id, status)
        VALUES 
          ('CART_01', 'cart-001', 'active'),
          ('CART_02', 'cart-002', 'active'),
          ('CART_03', 'cart-003', 'active')
        ON CONFLICT (cart_id) DO NOTHING
      `);

      // Ensure default customer user exists
      await client.query(`
        INSERT INTO users (user_id, username)
        VALUES ('USER123', 'guest_shopper')
        ON CONFLICT (user_id) DO NOTHING
      `);

      // Seed initial stock movements history
      const initialMovements = [
        {
          movement_id: 'MOV-1008',
          product_id: 'PROD-004',
          action: 'CHECKOUT',
          delta: -1,
          before_qty: 21,
          after_qty: 20,
          ref_code: 'CRT-8849-AX',
          notes: 'POS RFID settlement at Express Exit Gate 2'
        },
        {
          movement_id: 'MOV-1007',
          product_id: 'PROD-008',
          action: 'CHECKOUT',
          delta: -2,
          before_qty: 66,
          after_qty: 64,
          ref_code: 'CRT-8841-B',
          notes: 'Guest checkout self-pay transaction'
        },
        {
          movement_id: 'MOV-1006',
          product_id: 'PROD001',
          action: 'CYCLE_COUNT',
          delta: -1,
          before_qty: 9,
          after_qty: 8,
          ref_code: 'AUDIT-FLOOR-A',
          notes: 'Shelf count audit discrepancy: item misplaced'
        },
        {
          movement_id: 'MOV-1005',
          product_id: 'PROD-008',
          action: 'RESTOCK',
          delta: 50,
          before_qty: 14,
          after_qty: 64,
          ref_code: 'PO-2026-8812',
          notes: 'Inbound delivery from Volt Beverages Ltd'
        },
        {
          movement_id: 'MOV-1004',
          product_id: 'PROD-005',
          action: 'RESTOCK',
          delta: 30,
          before_qty: 12,
          after_qty: 42,
          ref_code: 'PO-2026-8809',
          notes: 'Fresh batch receiving verified at dock'
        },
        {
          movement_id: 'MOV-1003',
          product_id: 'PROD-011',
          action: 'DAMAGE_WRITEOFF',
          delta: -2,
          before_qty: 5,
          after_qty: 3,
          ref_code: 'DMG-WRT-091',
          notes: 'Packaging torn during shelf replenishment'
        },
        {
          movement_id: 'MOV-1002',
          product_id: 'PROD-006',
          action: 'CHECKOUT',
          delta: -1,
          before_qty: 26,
          after_qty: 25,
          ref_code: 'CRT-8833-K',
          notes: 'Standard cart checkout'
        },
        {
          movement_id: 'MOV-1001',
          product_id: 'PROD002',
          action: 'CHECKOUT',
          delta: -4,
          before_qty: 4,
          after_qty: 0,
          ref_code: 'CRT-8822-M',
          notes: 'Depleted last 4 units on shelf. Out of stock triggered.'
        }
      ];

      for (const m of initialMovements) {
        await client.query(`
          INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (movement_id) DO NOTHING
        `, [m.movement_id, m.product_id, m.action, m.delta, m.before_qty, m.after_qty, m.ref_code, m.notes]);
      }

      // Seed initial completed sales and line items for analytics
      const sampleSaleId = 'SALE_INIT_001';
      await client.query(`
        INSERT INTO sales (sale_id, subtotal, tax_rate, tax_amount, total, completed_at)
        VALUES ($1, 4520.00, 0.0825, 372.90, 4892.90, CURRENT_TIMESTAMP)
        ON CONFLICT (sale_id) DO NOTHING
      `, [sampleSaleId]);

      const sampleLineItems = [
        { product_id: 'PROD-004', qty: 48, price: 39.99 },
        { product_id: 'PROD001', qty: 34, price: 19.99 },
        { product_id: 'PROD002', qty: 62, price: 2.49 },
        { product_id: 'PROD-005', qty: 55, price: 3.99 },
        { product_id: 'PROD-006', qty: 38, price: 4.79 },
        { product_id: 'PROD-007', qty: 28, price: 7.99 },
        { product_id: 'PROD-008', qty: 72, price: 2.99 },
        { product_id: 'PROD-009', qty: 22, price: 24.99 },
        { product_id: 'PROD-010', qty: 41, price: 3.29 },
        { product_id: 'PROD-011', qty: 12, price: 2.99 },
      ];

      for (const item of sampleLineItems) {
        await client.query(`
          INSERT INTO sale_line_items (sale_id, product_id, quantity, unit_price, line_subtotal)
          VALUES ($1, $2, $3, $4, $5)
        `, [sampleSaleId, item.product_id, item.qty, item.price, item.qty * item.price]);
      }

      console.log('[db] Initial store catalog, stock movements, and sales seeded successfully.');
    }

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
  hashPassword,
  verifyPassword,
};

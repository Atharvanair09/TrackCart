// fix_carts.js
// Script to verify and insert missing cart records in local PostgreSQL database.
// Uses the existing pg pool from backend/db.js.

const { pool } = require('./db');

async function main() {
  try {
    // 1. Query existing carts
    const res = await pool.query('SELECT cart_id, device_id, status FROM carts ORDER BY cart_id;');
    console.log('Current carts:');
    console.table(res.rows);
    const existing = new Set(res.rows.map(r => r.cart_id));

    // 2. Determine missing carts
    const required = [
      { cart_id: 'CART_01', device_id: 'cart-001', status: 'active' },
      { cart_id: 'CART_02', device_id: 'cart-002', status: 'active' },
      { cart_id: 'CART_03', device_id: 'cart-003', status: 'active' },
    ];
    const missing = required.filter(c => !existing.has(c.cart_id));
    if (missing.length === 0) {
      console.log('All required carts already exist. No insertion needed.');
    } else {
      console.log('Missing carts:', missing.map(c => c.cart_id).join(', '));
      // 3. Insert missing carts using ON CONFLICT DO NOTHING
      const insertQuery = `
        INSERT INTO carts (cart_id, device_id, status)
        VALUES ($1, $2, $3)
        ON CONFLICT (cart_id) DO NOTHING;
      `;
      for (const cart of missing) {
        await pool.query(insertQuery, [cart.cart_id, cart.device_id, cart.status]);
        console.log(`Inserted ${cart.cart_id}`);
      }
    }

    // 4. Verify final state
    const finalRes = await pool.query('SELECT cart_id, device_id, status FROM carts ORDER BY cart_id;');
    console.log('Final carts:');
    console.table(finalRes.rows);
  } catch (err) {
    console.error('Error during cart verification/insertion:', err);
  } finally {
    await pool.end();
  }
}

main();

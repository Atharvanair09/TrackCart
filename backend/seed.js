const { pool, initDb } = require('./db');

const seedProducts = [
  {
    product_id: 'PROD001',
    tag_uid: '12500123456',
    name: 'Smart Water Bottle',
    price: 19.99,
    category: 'Accessories',
    image_url: 'https://example.com/bottle.jpg',
    is_active: true,
    inventory_qty: 50
  },
  {
    product_id: 'PROD002',
    tag_uid: 'ABCDEF123456',
    name: 'Organic Granola Bar',
    price: 2.49,
    category: 'Snacks',
    image_url: 'https://example.com/granola.jpg',
    is_active: true,
    inventory_qty: 120
  },
  {
    product_id: 'PROD003',
    tag_uid: 'INACTIVETAG01',
    name: 'Discontinued Snack',
    price: 1.99,
    category: 'Snacks',
    image_url: null,
    is_active: false,
    inventory_qty: 0
  }
];

const seedUser = {
  user_id: 'USER123',
  username: 'test_user'
};

const seedCart = {
  cart_id: 'CART_01',
  // Must match firmware/esp8266-rfid/src/config.h DEVICE_ID so RFID events
  // resolve to the same cart the PWA pairs as CART_01.
  device_id: 'cart-001',
  status: 'available'
};

async function seed() {
  await initDb();
  const client = await pool.connect();
  
  try {
    console.log('Clearing existing data...');
    // Delete in reverse dependency order
    await client.query('DELETE FROM cart_items');
    await client.query('DELETE FROM shopping_sessions');
    await client.query('DELETE FROM carts');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM products');
    await client.query('DELETE FROM rfid_events_log');
    
    console.log('Inserting seed products...');
    for (const p of seedProducts) {
      await client.query(`
        INSERT INTO products (product_id, tag_uid, name, price, category, image_url, is_active, inventory_qty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [p.product_id, p.tag_uid, p.name, p.price, p.category, p.image_url, p.is_active, p.inventory_qty]);
    }
    
    console.log('Inserting seed user...');
    await client.query(`
      INSERT INTO users (user_id, username) VALUES ($1, $2)
    `, [seedUser.user_id, seedUser.username]);

    console.log('Inserting seed cart...');
    await client.query(`
      INSERT INTO carts (cart_id, device_id, status) VALUES ($1, $2, $3)
    `, [seedCart.cart_id, seedCart.device_id, seedCart.status]);

    // Do not seed an active shopping session. RFID events attach to the
    // session the PWA creates for CART_01; a leftover seed session would
    // either block pairing (409) or receive items the PWA is not polling.

    console.log('Seeding completed successfully!');
  } catch (error) {
    console.error('Error during seeding:', error);
  } finally {
    client.release();
    pool.end(); // close pool to exit process
  }
}

seed();

const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// POST /api/rfid/events
router.post('/events', async (req, res) => {
  const { deviceId, tagUid, event } = req.body;

  // 1 & 2. Validate request & device ID
  if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }

  if (!tagUid || typeof tagUid !== 'string' || tagUid.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid tagUid' });
  }

  // Normalize UID
  const normalizedUid = tagUid.replace(/[^0-9A-F]/gi, '').toUpperCase();
  if (normalizedUid === '') {
    return res.status(400).json({ error: 'tagUid contains no valid hexadecimal characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deduplication check (e.g., within 5 seconds)
    const recentEvent = await client.query(`
      SELECT * FROM rfid_events_log 
      WHERE device_id = $1 AND tag_uid = $2 AND scanned_at >= NOW() - INTERVAL '5 seconds'
    `, [deviceId, normalizedUid]);

    if (recentEvent.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(429).json({ error: 'Duplicate RFID event detected' });
    }

    // Log the event
    await client.query(`
      INSERT INTO rfid_events_log (device_id, tag_uid) VALUES ($1, $2)
    `, [deviceId, normalizedUid]);

    // Validate Device -> Cart
    const cartResult = await client.query('SELECT cart_id FROM carts WHERE device_id = $1', [deviceId]);
    if (cartResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Device is not associated with any cart' });
    }
    const cartId = cartResult.rows[0].cart_id;

    // Find active session
    const sessionResult = await client.query(`
      SELECT session_id FROM shopping_sessions 
      WHERE cart_id = $1 AND status = 'active'
    `, [cartId]);
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No active shopping session for this cart' });
    }
    const sessionId = sessionResult.rows[0].session_id;

    // Look up product
    const productResult = await client.query('SELECT * FROM products WHERE tag_uid = $1', [normalizedUid]);
    if (productResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Unregistered RFID tag' });
    }
    const product = productResult.rows[0];

    if (!product.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Product is inactive' });
    }

    // Add or increment cart item
    const existingItem = await client.query(`
      SELECT * FROM cart_items WHERE session_id = $1 AND product_id = $2
    `, [sessionId, product.product_id]);

    if (existingItem.rows.length > 0) {
      await client.query(`
        UPDATE cart_items 
        SET quantity = quantity + 1, subtotal = (quantity + 1) * unit_price_at_addition
        WHERE session_id = $1 AND product_id = $2
      `, [sessionId, product.product_id]);
    } else {
      await client.query(`
        INSERT INTO cart_items (session_id, product_id, quantity, unit_price_at_addition, subtotal)
        VALUES ($1, $2, 1, $3, $3)
      `, [sessionId, product.product_id, product.price]);
    }

    // Fetch updated cart state
    const itemsResult = await client.query(`
      SELECT ci.*, p.name, p.image_url 
      FROM cart_items ci
      JOIN products p ON ci.product_id = p.product_id
      WHERE ci.session_id = $1
    `, [sessionId]);

    await client.query('COMMIT');

    const cartItems = itemsResult.rows;
    const cartTotal = cartItems.reduce((sum, item) => sum + item.subtotal, 0);

    return res.status(200).json({
      success: true,
      message: 'Product added to cart',
      session: {
        sessionId: sessionId,
        status: 'active'
      },
      cart: {
        cartId: cartId,
        items: cartItems,
        total: cartTotal
      },
      product: {
        productId: product.product_id,
        name: product.name,
        price: product.price,
        category: product.category,
        imageUrl: product.image_url,
        isActive: product.is_active,
        inventoryQty: product.inventory_qty
      },
      cartTotal: cartTotal,
      items: cartItems
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database error during RFID event processing:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;

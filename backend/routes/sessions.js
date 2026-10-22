const express = require('express');
// Enable inventory-only demo mode via env var. Set INVENTORY_ONLY_MODE=true to bypass Razorpay verification and payment order creation.
const router = express.Router();
const { pool } = require('../db');
const INVENTORY_ONLY_MODE = process.env.INVENTORY_ONLY_MODE === 'true';

// POST /api/sessions - Create a new session
router.post('/', async (req, res) => {
  const { userId, cartId } = req.body;
  if (!cartId) {
    return res.status(400).json({ error: 'Missing cartId' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (userId) {
      const userResult = await client.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
    }

    const cartResult = await client.query('SELECT * FROM carts WHERE cart_id = $1', [cartId]);
    if (cartResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cart not found' });
    }

    const activeSession = await client.query(
      "SELECT * FROM shopping_sessions WHERE cart_id = $1 AND status = 'active'",
      [cartId]
    );
    if (activeSession.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cart is already in use by an active session' });
    }

    const sessionId = `SESS_${Date.now()}`;
    const result = await client.query(
      'INSERT INTO shopping_sessions (session_id, user_id, cart_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [sessionId, userId || null, cartId, 'active']
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/sessions/:sessionId - Retrieve session details
router.get('/:sessionId', async (req, res) => {
  try {
    const sessionResult = await pool.query('SELECT * FROM shopping_sessions WHERE session_id = $1', [req.params.sessionId]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessionResult.rows[0];
    
    const itemsResult = await pool.query(`
      SELECT ci.*, p.name, p.image_url 
      FROM cart_items ci
      JOIN products p ON ci.product_id = p.product_id
      WHERE ci.session_id = $1
    `, [session.session_id]);
    
    session.items = itemsResult.rows;
    session.cartTotal = session.items.reduce((sum, item) => sum + item.subtotal, 0);
    
    res.status(200).json(session);
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/sessions/:sessionId/end - End a session
// POST /api/sessions/:sessionId/create-order - Create Razorpay order
router.post('/:sessionId/create-order', async (req, res) => {
  const sessionId = req.params.sessionId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verify session exists and is active
    const sessionRes = await client.query('SELECT * FROM shopping_sessions WHERE session_id = $1 AND status = $2 FOR UPDATE', [sessionId, 'active']);
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or inactive session' });
    }
    const itemsRes = await client.query(
      `SELECT ci.*, p.price FROM cart_items ci 
       JOIN products p ON ci.product_id = p.product_id 
       WHERE ci.session_id = $1`,
      [sessionId]
    );
    if (itemsRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cart is empty' });
    }
    const subtotal = itemsRes.rows.reduce((sum, i) => sum + (i.unit_price_at_addition * i.quantity), 0);
    const taxRate = 0.0825;
    const taxAmount = Math.round(subtotal * taxRate * 100);
    const total = Math.round((subtotal + taxAmount) * 100);
    const paymentService = require('../services/paymentService');
    if (!process.env.INVENTORY_ONLY_MODE === 'true') {
      // In production mode ensure Razorpay is configured
      if (!paymentService.isConfigured()) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Razorpay configuration missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in environment.' });
      }
      const order = await paymentService.createOrder({ amount: total, currency: 'INR', receipt: `receipt_${sessionId}` });
      await client.query('COMMIT');
      return res.status(200).json({ order_id: order.id, amount: order.amount, currency: order.currency });
    } else {
      // Inventory‑only demo mode – skip order creation and commit early
      await client.query('COMMIT');
      return res.status(200).json({ message: 'Demo checkout successful (payment bypassed)' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating Razorpay order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
router.post('/:sessionId/checkout', async (req, res) => {
  const sessionId = req.params.sessionId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verify session exists and is active, lock the row for concurrency safety
    const sessionRes = await client.query('SELECT * FROM shopping_sessions WHERE session_id = $1 AND status = $2 FOR UPDATE', [sessionId, 'active']);
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or inactive session' });
    }
    // Idempotency: if a sale already exists for this session, return it without modifying inventory
    const existingSale = await client.query('SELECT * FROM sales WHERE session_id = $1', [sessionId]);
    if (existingSale.rows.length > 0) {
      await client.query('COMMIT');
      return res.status(200).json(existingSale.rows[0]);
    }
        // Razorpay payment verification – optional if credentials are set
    const paymentService = require('../services/paymentService');
    if (!INVENTORY_ONLY_MODE) {
      // In production mode ensure Razorpay is configured and verify payment details.
      if (!paymentService.isConfigured()) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Razorpay configuration missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in environment.' });
      }
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Missing Razorpay payment details' });
      }
      const isValid = paymentService.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!isValid) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid Razorpay signature' });
      }
    }
    // Fetch cart items ordered by product_id to lock products deterministically
    const itemsRes = await client.query(
      `SELECT ci.*, p.price, p.product_id FROM cart_items ci 
       JOIN products p ON ci.product_id = p.product_id 
       WHERE ci.session_id = $1 
       ORDER BY ci.product_id ASC`,
      [sessionId]
    );
    if (itemsRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cart is empty, cannot checkout' });
    }
    // Lock each product row to prevent race conditions while updating inventory
    for (const item of itemsRes.rows) {
      await client.query('SELECT * FROM products WHERE product_id = $1 FOR UPDATE', [item.product_id]);
    }
    // Validate that a reservation exists for each product and deduct inventory & reserved quantities atomically
    for (const item of itemsRes.rows) {
      const qty = item.quantity;
      const productId = item.product_id;

      // Compute net reserved quantity for this session and product (sum reservations minus releases)
// Lock reservation rows for this session and product to ensure concurrency safety
await client.query(`
SELECT io.id
FROM inventory_operations io
JOIN inventory_movements im ON im.operation_id = io.id
WHERE io.operation_type = 'reservation'
  AND io.session_id = $1
  AND io.status = 'completed'
  AND im.product_id = $2
FOR UPDATE
`, [sessionId, productId]);

const reservationAggRes = await client.query(
  `SELECT COALESCE(SUM(im.quantity), 0) AS total_reserved
   FROM inventory_operations io
   JOIN inventory_movements im ON im.operation_id = io.id
   WHERE io.operation_type = 'reservation'
     AND io.session_id = $1
     AND io.status = 'completed'
     AND im.product_id = $2`,
  [sessionId, productId]
);
      const releaseAggRes = await client.query(
        `SELECT COALESCE(SUM(im.quantity), 0) AS total_released
         FROM inventory_operations ro
         JOIN inventory_movements im ON im.operation_id = ro.id
         WHERE ro.operation_type = 'release'
           AND ro.status = 'completed'
           AND ro.reservation_operation_id IN (
             SELECT io.id
             FROM inventory_operations io
             JOIN inventory_movements im ON im.operation_id = io.id
             WHERE io.operation_type = 'reservation'
               AND io.session_id = $1
               AND io.status = 'completed'
               AND im.product_id = $2
           )
           AND im.product_id = $2`,
        [sessionId, productId]
      );
      const totalReserved = Number(reservationAggRes.rows[0].total_reserved);
      const totalReleased = Number(releaseAggRes.rows[0].total_released);
      const netReserved = totalReserved - totalReleased;
      if (netReserved < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient reserved quantity for product ${productId}` });
      }

      // Decrement both inventory and reserved quantities
      const updRes = await client.query(
        'UPDATE products SET inventory_qty = inventory_qty - $1, reserved_qty = reserved_qty - $1 WHERE product_id = $2 AND inventory_qty >= $1 AND reserved_qty >= $1',
        [qty, productId]
      );
      if (updRes.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock for product ${productId}` });
      }
    }

    // Calculate totals after successful inventory checks
    const subtotal = itemsRes.rows.reduce((sum, i) => sum + (i.unit_price_at_addition * i.quantity), 0);
    const taxRate = 0.0825;
    const taxAmount = parseFloat((subtotal * taxRate).toFixed(2));
    const total = parseFloat((subtotal + taxAmount).toFixed(2));
    const saleId = `SALE_${Date.now()}`;

    // Insert sale record
    const saleInsert = await client.query(
      `INSERT INTO sales (sale_id, session_id, subtotal, tax_rate, tax_amount, total) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [saleId, sessionId, subtotal, taxRate, taxAmount, total]
    );
    const saleRecord = saleInsert.rows[0];

    // Create inventory operation for the sale (pending)
    const saleOpKey = `sale-${saleId}`;
    const saleOpInsert = await client.query(
      `INSERT INTO inventory_operations (operation_type, operation_key, session_id, sale_id, status) VALUES ('sale', $1, $2, $3, 'pending') RETURNING id`,
      [saleOpKey, sessionId, saleId]
    );
    const saleOperationId = saleOpInsert.rows[0].id;

    // Insert line items and inventory movements
    const lineItemPromises = itemsRes.rows.map(async (item) => {
      const lineSubtotal = parseFloat((item.unit_price_at_addition * item.quantity).toFixed(2));
      await client.query(
        `INSERT INTO sale_line_items (sale_id, product_id, quantity, unit_price, line_subtotal) VALUES ($1, $2, $3, $4, $5)`,
        [saleId, item.product_id, item.quantity, item.unit_price_at_addition, lineSubtotal]
      );
      // Record inventory movement for sale (deduct both physical and reserved)
      await client.query(
        `INSERT INTO inventory_movements (operation_id, product_id, movement_type, quantity, physical_delta, reserved_delta) VALUES ($1, $2, 'sale', $3, -CAST($3 AS INTEGER), -CAST($3 AS INTEGER))`,
        [saleOperationId, item.product_id, item.quantity]
      );
    });
    await Promise.all(lineItemPromises);

    // Mark sale operation as completed
    await client.query(
      `UPDATE inventory_operations SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [saleOperationId]
    );

    // Stock movement logging is handled via inventory_movements above; duplicate inventory decrement removed.

    // Mark session as completed
    await client.query('UPDATE shopping_sessions SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE session_id = $2', ['completed', sessionId]);

    await client.query('COMMIT');
    return res.status(200).json(saleRecord);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during checkout:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/sessions/:sessionId/cancel - Cancel a session
router.post('/:sessionId/cancel', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const result = await pool.query(
      'UPDATE shopping_sessions SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE session_id = $2 RETURNING *',
      ['cancelled', sessionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error cancelling session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/sessions/:sessionId/items/:productId/decrement - Decrease quantity or remove item
router.post('/:sessionId/items/:productId/decrement', async (req, res) => {
  const { sessionId, productId } = req.params;
  if (!sessionId || !productId) {
    return res.status(400).json({ error: 'Missing sessionId or productId' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verify session exists and is active
    const sessionRes = await client.query('SELECT * FROM shopping_sessions WHERE session_id = $1 AND status = $2', [sessionId, 'active']);
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active session not found' });
    }
    // Fetch cart item
    const itemRes = await client.query('SELECT * FROM cart_items WHERE session_id = $1 AND product_id = $2', [sessionId, productId]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found in cart' });
    }
    const item = itemRes.rows[0];
    if (item.quantity > 1) {
      // Decrement quantity
      await client.query(
        `UPDATE cart_items SET quantity = quantity - 1, subtotal = (quantity - 1) * unit_price_at_addition WHERE session_id = $1 AND product_id = $2`,
        [sessionId, productId]
      );
    } else {
      // Quantity would become zero – remove item
      await client.query('DELETE FROM cart_items WHERE session_id = $1 AND product_id = $2', [sessionId, productId]);
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
    const cartTotal = cartItems.reduce((sum, i) => sum + i.subtotal, 0);
    return res.status(200).json({
      success: true,
      sessionId,
      cart: { items: cartItems, total: cartTotal },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error decrementing item:', error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;


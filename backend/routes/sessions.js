const express = require('express');
const router = express.Router();
const { pool } = require('../db');

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
    // Validate inventory for each product and deduct atomically
    for (const item of itemsRes.rows) {
      const qty = item.quantity;
      const productId = item.product_id;
      // Guarded update ensures sufficient stock; rowCount === 1 means deduction succeeded
      const updRes = await client.query(
        'UPDATE products SET inventory_qty = inventory_qty - $1 WHERE product_id = $2 AND inventory_qty >= $1',
        [qty, productId]
      );
      if (updRes.rowCount !== 1) {
        // Insufficient stock or product missing – abort checkout
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
    // Insert line items for each cart item
    const lineItemPromises = itemsRes.rows.map(item => {
      const lineSubtotal = parseFloat((item.unit_price_at_addition * item.quantity).toFixed(2));
      return client.query(
        `INSERT INTO sale_line_items (sale_id, product_id, quantity, unit_price, line_subtotal) VALUES ($1, $2, $3, $4, $5)`,
        [saleId, item.product_id, item.quantity, item.unit_price_at_addition, lineSubtotal]
      );
    });
    await Promise.all(lineItemPromises);
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

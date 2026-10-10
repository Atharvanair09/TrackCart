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
router.post('/:sessionId/end', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE shopping_sessions SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE session_id = $2 RETURNING *',
      ['completed', req.params.sessionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

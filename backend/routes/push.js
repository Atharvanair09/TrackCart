// Backend route to register push subscription for a shopping session
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// POST /api/push/subscribe
// Expected body: { sessionId: string, subscription: object }
router.post('/subscribe', async (req, res) => {
  const { sessionId, subscription } = req.body;
  if (!sessionId || !subscription) {
    return res.status(400).json({ error: 'Missing sessionId or subscription' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verify session exists and is active (or not expired) before storing subscription
    const sessRes = await client.query(
      `SELECT status FROM shopping_sessions WHERE session_id = $1`,
      [sessionId]
    );
    if (sessRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found' });
    }
    if (sessRes.rows[0].status === 'expired') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Session has expired' });
    }

    // Upsert subscription – avoid duplicates for same session
    await client.query(
      `INSERT INTO push_subscriptions (session_id, subscription_data)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET subscription_data = EXCLUDED.subscription_data`,
      [sessionId, subscription]
    );
    await client.query('COMMIT');
    return res.status(201).json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error registering push subscription:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/push/publicKey – returns VAPID public key for client subscription
router.get('/publicKey', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: 'VAPID public key not configured' });
  }
  res.json({ publicKey });
});

module.exports = router;

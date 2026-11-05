// routes/camera.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Configurable correlation window (seconds)
const CAM_CORRELATION_WINDOW = parseInt(process.env.CAM_CORRELATION_WINDOW || '5', 10);

/**
 * POST /api/camera/events
 * Expected payload:
 * {
 *   eventId, timestamp, type, deviceId, baselineId, diffScore,
 *   consecutiveFrames, classification
 * }
 */
router.post('/events', async (req, res) => {
  const {
    eventId,
    timestamp,
    type,
    deviceId,
    baselineId,
    diffScore,
    consecutiveFrames,
    classification,
  } = req.body;

  // Basic validation
  if (!eventId || !timestamp || !type || !deviceId) {
    return res.status(400).json({ error: 'Missing required camera event fields' });
  }

  const trimmedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : deviceId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Acquire transaction-scoped advisory lock per device to serialize reconciliation with RFID route
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [trimmedDeviceId]);

    // 1. Resolve firmware deviceId to cart using existing mapping logic
    const cartResult = await client.query(
      `SELECT cart_id FROM carts
       WHERE LOWER(device_id) = LOWER($1) OR LOWER(cart_id) = LOWER($1)`,
      [trimmedDeviceId]
    );

    let resolvedSessionId = null;
    if (cartResult.rows.length > 0) {
      const cartId = cartResult.rows[0].cart_id;
      // Find cart's active shopping session only
      const sessionResult = await client.query(
        `SELECT session_id FROM shopping_sessions
         WHERE cart_id = $1 AND status = 'active'`,
        [cartId]
      );
      if (sessionResult.rows.length > 0) {
        resolvedSessionId = sessionResult.rows[0].session_id;
      }
    }

    // 2. Correlate with recent RFID events using consistent UTC comparison
    // rfid_events_log.scanned_at (TIMESTAMP) is stored as UTC via CURRENT_TIMESTAMP.
    // Comparing ($2::TIMESTAMPTZ AT TIME ZONE 'UTC') ensures timezone parity.
    const recentRfid = await client.query(
      `SELECT * FROM rfid_events_log
       WHERE device_id = $1
         AND (scanned_at AT TIME ZONE 'UTC') >= ($2::TIMESTAMPTZ - make_interval(secs => $3::int))
         AND (scanned_at AT TIME ZONE 'UTC') <= ($2::TIMESTAMPTZ + make_interval(secs => $3::int))
       ORDER BY scanned_at DESC`,
      [trimmedDeviceId, timestamp, CAM_CORRELATION_WINDOW]
    );

    let correlation = null;
    let isMatched = false;
    let eventStatus = 'pending';

    if (recentRfid.rows.length > 0) {
      correlation = { matchedRfid: recentRfid.rows[0] };
      isMatched = true;
      eventStatus = 'matched';
    }

    // 3. Atomically insert or detect duplicate on event_id conflict
    const insertResult = await client.query(
      `INSERT INTO camera_events_log (
        event_id, timestamp, type, device_id, baseline_id, diff_score,
        consecutive_frames, classification, mismatch, status, session_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING *`,
      [
        eventId,
        timestamp,
        type,
        trimmedDeviceId,
        baselineId || null,
        diffScore || null,
        consecutiveFrames || null,
        classification || null,
        false, // mismatch is false initially (never confirmed mismatch upon arrival)
        eventStatus,
        resolvedSessionId,
      ]
    );

    // Duplicate detection under concurrent requests
    if (insertResult.rows.length === 0) {
      const existing = await client.query(
        `SELECT event_id, status, mismatch, session_id FROM camera_events_log WHERE event_id = $1`,
        [eventId]
      );
      await client.query('COMMIT');

      const existingRecord = existing.rows[0] || {};
      return res.status(200).json({
        success: true,
        message: 'Camera event already recorded (duplicate)',
        duplicate: true,
        status: existingRecord.status || (existingRecord.mismatch ? 'mismatch' : 'pending'),
        mismatch: existingRecord.mismatch || false,
      });
    }

    await client.query('COMMIT');

    if (correlation) {
      return res.status(200).json({
        success: true,
        message: 'Camera event correlated with recent RFID',
        correlation,
        status: 'matched',
        mismatch: false,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Camera event recorded with pending correlation',
      status: 'pending',
      mismatch: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error processing camera event:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;


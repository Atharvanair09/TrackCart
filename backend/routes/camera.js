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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure camera_events_log table exists (simple on‑first‑use DDL)
    await client.query(`
      CREATE TABLE IF NOT EXISTS camera_events_log (
        event_id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        type TEXT NOT NULL,
        device_id TEXT NOT NULL,
        baseline_id TEXT,
        diff_score REAL,
        consecutive_frames INT,
        classification TEXT,
        mismatch BOOLEAN DEFAULT FALSE
      )
    `);


    // Insert camera event
    await client.query(
      `INSERT INTO camera_events_log (
        event_id, timestamp, type, device_id, baseline_id, diff_score, consecutive_frames, classification
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id) DO NOTHING`,
      [
        eventId,
        timestamp,
        type,
        deviceId,
        baselineId || null,
        diffScore || null,
        consecutiveFrames || null,
        classification || null,
      ]
    );

    // Correlate with recent RFID events (within window)
    const recentRfid = await client.query(
      `SELECT * FROM rfid_events_log 
       WHERE device_id = $1 
         AND scanned_at >= NOW() - INTERVAL '${CAM_CORRELATION_WINDOW} seconds'`,
      [deviceId]
    );

    let correlation = null;
    if (recentRfid.rows.length > 0) {
      correlation = { matchedRfid: recentRfid.rows[0] };
    }

    await client.query('COMMIT');

    // Respond with info about correlation/mismatch
    if (correlation) {
      return res.status(200).json({ success: true, message: 'Camera event correlated with recent RFID', correlation });
    }
    return res.status(200).json({ success: true, message: 'Camera event recorded (no recent RFID activity)' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error processing camera event:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;

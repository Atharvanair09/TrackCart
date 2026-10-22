const express = require('express');
const crypto = require('crypto');
const { pool, verifyPassword } = require('../db');

const router = express.Router();

/**
 * Helper to extract Bearer token from headers
 */
function extractBearerToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return req.headers['x-admin-token'] || req.body?.token || req.query?.token || null;
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Both email and password are required',
    });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT admin_id, email, password_hash, salt, full_name, role FROM admins WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid administrator credentials',
      });
    }

    const admin = result.rows[0];
    const isValid = verifyPassword(password, admin.password_hash, admin.salt);

    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid administrator credentials',
      });
    }

    // Generate secure session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await client.query(
      'INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES ($1, $2, $3)',
      [token, admin.admin_id, expiresAt]
    );

    // Update last_login
    await client.query(
      'UPDATE admins SET last_login = CURRENT_TIMESTAMP WHERE admin_id = $1',
      [admin.admin_id]
    );

    return res.json({
      success: true,
      message: 'Authentication successful',
      token,
      admin: {
        adminId: admin.admin_id,
        email: admin.email,
        fullName: admin.full_name,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error('Error during admin login:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication',
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/auth/verify
 * Verifies session token from Authorization header
 */
router.get('/verify', async (req, res) => {
  const token = extractBearerToken(req);

  if (!token) {
    return res.status(401).json({ valid: false, message: 'Missing session token' });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT a.admin_id, a.email, a.full_name, a.role, s.expires_at
      FROM admin_sessions s
      JOIN admins a ON s.admin_id = a.admin_id
      WHERE s.token = $1 AND s.expires_at > CURRENT_TIMESTAMP
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(401).json({ valid: false, message: 'Invalid or expired session' });
    }

    const admin = result.rows[0];
    return res.json({
      valid: true,
      admin: {
        adminId: admin.admin_id,
        email: admin.email,
        fullName: admin.full_name,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error('Error verifying token:', err);
    return res.status(500).json({ valid: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/auth/logout
 * Invalidate session token
 */
router.post('/logout', async (req, res) => {
  const token = extractBearerToken(req);

  if (token) {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    } catch (err) {
      console.error('Error during logout:', err);
    } finally {
      client.release();
    }
  }

  return res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;

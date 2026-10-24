const { pool } = require('./db');
const { sendPushNotification } = require('./pushService');
const { releaseReservation } = require('./services/inventory');

/**
 * Background worker that handles inactivity notifications and session expiry.
 */
function startSessionExpiryWorker() {
  setInterval(async () => {
    // Fetch all active sessions with last_activity_at at least 10 minutes ago
    const client = await pool.connect();
    let sessions = [];
    try {
      const result = await client.query(
        `SELECT session_id, last_activity_at FROM shopping_sessions
         WHERE status = 'active' AND last_activity_at <= NOW() - INTERVAL '10 minutes'`
      );
      sessions = result.rows;
    } catch (err) {
      console.error('Failed to fetch sessions for notifications/expiry:', err);
      client.release();
      return;
    }
    client.release();

    for (const { session_id: sessionId, last_activity_at: lastActivity } of sessions) {
      const sessClient = await pool.connect();
      try {
        await sessClient.query('BEGIN');

        // Lock the session row
        await sessClient.query(
          `SELECT session_id FROM shopping_sessions WHERE session_id = $1 FOR UPDATE`,
          [sessionId]
        );

        // Re‑validate session state
        const validation = await sessClient.query(
          `SELECT session_id, last_activity_at, status, expired_at FROM shopping_sessions
           WHERE session_id = $1 AND status = 'active' AND expired_at IS NULL`,
          [sessionId]
        );

        if (validation.rowCount === 0) {
          await sessClient.query('ROLLBACK');
          sessClient.release();
          continue;
        }

        const sessionRow = validation.rows[0];
        const inactivityMins = Math.floor(
          (new Date() - new Date(sessionRow.last_activity_at)) / 60000
        );

        // Send milestones 10,13,14
        const milestones = [10, 13, 14];
        for (const m of milestones) {
          if (inactivityMins >= m) {
            const alreadySent = await sessClient.query(
              `SELECT 1 FROM session_notifications WHERE session_id = $1 AND milestone = $2`,
              [sessionId, m]
            );
            if (alreadySent.rowCount === 0) {
              const subRes = await sessClient.query(
                `SELECT subscription_data FROM push_subscriptions WHERE session_id = $1`,
                [sessionId]
              );
              if (subRes.rows.length > 0) {
                const subscription = subRes.rows[0].subscription_data;
                const payload = {
                  title: 'Cart Inactivity Warning',
                  body: `Your cart has been inactive for ${inactivityMins} minutes. ${15 - inactivityMins} minute(s) left before session expires.`,
                  icon: '/favicon.svg',
                  data: { sessionId },
                };
                try {
                  await sendPushNotification(subscription, payload);
                  await sessClient.query(
                    `INSERT INTO session_notifications (session_id, milestone) VALUES ($1, $2)`,
                    [sessionId, m]
                  );
                } catch (e) {
                  console.error('Push notification failed for', sessionId, 'milestone', m, e);
                }
              }
            }
          }
        }

        // If inactivity >=15, expire the session
        if (inactivityMins >= 15) {
          // Release reservations
          const reservationOps = await sessClient.query(
            `SELECT id, operation_key FROM inventory_operations
             WHERE session_id = $1
               AND operation_type = 'reservation'
               AND status = 'completed'
             FOR UPDATE`,
            [sessionId]
          );
          for (const { id: opId, operation_key: reservationKey } of reservationOps.rows) {
            const movements = await sessClient.query(
              `SELECT product_id, quantity FROM inventory_movements
               WHERE operation_id = $1
                 AND movement_type = 'reservation'`,
              [opId]
            );
            for (const { product_id: productId, quantity } of movements.rows) {
              const releaseKey = `${reservationKey}-release-${productId}`;
              await releaseReservation({
                operationKey: releaseKey,
                reservationOperationKey: reservationKey,
                productId,
                quantity: Number(quantity),
                externalClient: sessClient,
              });
            }
          }

          // Clean up
          await sessClient.query('DELETE FROM cart_items WHERE session_id = $1', [
            sessionId,
          ]);
          await sessClient.query('DELETE FROM push_subscriptions WHERE session_id = $1', [
            sessionId,
          ]);
          await sessClient.query(
            `UPDATE shopping_sessions SET status = 'expired', expired_at = CURRENT_TIMESTAMP WHERE session_id = $1`,
            [sessionId]
          );
        }

        await sessClient.query('COMMIT');
      } catch (err) {
        try {
          await sessClient.query('ROLLBACK');
        } catch (_) {}
        console.error('Session expiry worker error for session', sessionId, ':', err);
      } finally {
        sessClient.release();
      }
    }
  }, 60 * 1000);
}

module.exports = { startSessionExpiryWorker };

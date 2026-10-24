const { pool } = require('./db');
const { releaseReservation } = require('./services/inventory');

/**
 * Background worker that expires inactive shopping sessions.
 * Runs every 60 seconds and expires sessions that have been idle for 15 minutes.
 * It releases any reserved inventory, cleans up cart items and push subscriptions,
 * and marks the session as expired.
 */
function startSessionExpiryWorker() {
  setInterval(async () => {
    // First, fetch list of stale sessions without holding a transaction.
    let staleSessions = [];
    const fetchClient = await pool.connect();
    try {
      const result = await fetchClient.query(
        `SELECT session_id FROM shopping_sessions 
         WHERE status = 'active' 
           AND last_activity_at <= NOW() - INTERVAL '15 minutes' 
         FOR UPDATE`
      );
      staleSessions = result.rows;
    } catch (err) {
      console.error('Failed to fetch stale sessions:', err);
      fetchClient.release();
      return;
    }
    fetchClient.release();

    // Process each stale session in its own transaction.
    for (const { session_id: sessionId } of staleSessions) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the session row to prevent concurrent modifications.
        await client.query(
          `SELECT session_id FROM shopping_sessions 
           WHERE session_id = $1 
           FOR UPDATE`,
          [sessionId]
        );
        // Re-validate session state after acquiring lock
        const validationResult = await client.query(
          `SELECT session_id FROM shopping_sessions 
           WHERE session_id = $1 
             AND status = 'active' 
             AND expired_at IS NULL 
             AND last_activity_at <= NOW() - INTERVAL '15 minutes'`,
          [sessionId]
        );
        if (validationResult.rowCount === 0) {
          // Session no longer eligible; skip cleanup and commit safely
          await client.query('COMMIT');
          continue; // move to next stale session
        }

        // Release any completed reservations attached to this session.
        const reservationOps = await client.query(
          `SELECT id, operation_key FROM inventory_operations 
           WHERE session_id = $1 
             AND operation_type = 'reservation' 
             AND status = 'completed' 
           FOR UPDATE`,
          [sessionId]
        );

        for (const { id: opId, operation_key: reservationKey } of reservationOps.rows) {
          const movements = await client.query(
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
              externalClient: client,
            });
          }
        }

        // Clean up cart items and push subscriptions.
        await client.query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
        await client.query('DELETE FROM push_subscriptions WHERE session_id = $1', [sessionId]);

        // Mark the session as expired.
        await client.query(
          `UPDATE shopping_sessions 
           SET status = 'expired', expired_at = CURRENT_TIMESTAMP 
           WHERE session_id = $1`,
          [sessionId]
        );

        await client.query('COMMIT');
      } catch (err) {
        // Roll back only this session's transaction.
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        console.error('Session expiry worker error for session', sessionId, ':', err);
      } finally {
        client.release();
      }
    }
  }, 60 * 1000); // Run every minute
}

module.exports = { startSessionExpiryWorker };

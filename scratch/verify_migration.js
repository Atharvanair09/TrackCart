const { pool } = require('./db');

async function run() {
  try {
    const results = {};
    // 1. migration recorded
    const migRes = await pool.query("SELECT migration_name FROM schema_migrations WHERE migration_name = '20261025_session_expiration.sql'");
    results.migrationRecorded = migRes.rowCount > 0 ? 'YES' : 'NO';
    // 2. columns existence
    const colsRes = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='shopping_sessions' AND column_name IN ('last_activity_at','expired_at')`);
    const cols = colsRes.rows.map(r=>r.column_name);
    results.lastActivityAt = cols.includes('last_activity_at') ? 'YES' : 'NO';
    results.expiredAt = cols.includes('expired_at') ? 'YES' : 'NO';
    // 3. push_subscriptions table exists
    const pushRes = await pool.query("SELECT to_regclass('public.push_subscriptions') AS tbl");
    results.pushSubscriptionsTable = pushRes.rows[0].tbl ? 'YES' : 'NO';
    // 4. indexes existence
    const idxRes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='shopping_sessions' AND indexname IN ('idx_active_sessions_last_activity','idx_sessions_expired_at')`);
    const idxNames = idxRes.rows.map(r=>r.indexname);
    results.idxActiveSessionsLastActivity = idxNames.includes('idx_active_sessions_last_activity') ? 'YES' : 'NO';
    results.idxSessionsExpiredAt = idxNames.includes('idx_sessions_expired_at') ? 'YES' : 'NO';
    const idxPushRes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='push_subscriptions' AND indexname='idx_push_subscriptions_session_id'`);
    results.idxPushSubscriptionsSessionId = idxPushRes.rowCount > 0 ? 'YES' : 'NO';
    // 5. active sessions with NULL last_activity_at
    const nullRes = await pool.query("SELECT session_id FROM shopping_sessions WHERE status='active' AND last_activity_at IS NULL LIMIT 5");
    results.activeSessionsNullLastActivity = nullRes.rowCount > 0 ? {count:nullRes.rowCount, sample:nullRes.rows.map(r=>r.session_id)} : 'NONE';
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('ERROR', e.message);
  } finally {
    await pool.end();
  }
}
run();

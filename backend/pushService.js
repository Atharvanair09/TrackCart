// Push service configuration using web-push
const webPush = require('web-push');

// Load VAPID keys from environment variables
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!vapidPublicKey || !vapidPrivateKey) {
  console.warn('[pushService] VAPID keys are not set. Push notifications will be disabled.');
} else {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

/**
 * Sends a push notification to a given subscription.
 * @param {Object} subscription - The push subscription object (as stored in DB).
 * @param {Object} payload - JSON payload to send.
 * @returns {Promise<void>}
 */
async function sendPushNotification(subscription, payload) {
  if (!vapidPublicKey || !vapidPrivateKey) {
    // No VAPID config – silently ignore
    return;
  }
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    // If the subscription is invalid or expired, propagate error to caller for cleanup.
    console.error('[pushService] Failed to send push notification:', err);
    throw err;
  }
}

module.exports = {
  sendPushNotification,
};

// Frontend Push Notification helper
const API_BASE = import.meta.env.VITE_API_URL || '/api';

export async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push messaging is not supported');
    return;
  }
  const sessionId = localStorage.getItem('smart_cart_session_id');
  if (!sessionId) { console.warn('No sessionId available; push init deferred'); return; }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered', registration);

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted');
      return;
    }

        // Ensure we have a push subscription; reuse if exists
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      // Get VAPID public key from backend
      const resp = await fetch(`${API_BASE}/push/publicKey`);
      if (!resp.ok) {
        console.error('Failed to obtain VAPID public key');
        return;
      }
      const { publicKey } = await resp.json();
      const convertedVapidKey = urlBase64ToUint8Array(publicKey);
      // Create new subscription
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedVapidKey,
      });
    }

        // Send subscription to backend (sessionId already validated)
    const response = await fetch(`${API_BASE}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, subscription }),
    });
    if (!response.ok) {
      console.error('Failed to register push subscription', response.status);
      return;
    }
    const result = await response.json();
    console.log('Push subscription registered', result);
  } catch (err) {
    console.error('Error during push setup', err);
  }
}

// Utility to convert VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

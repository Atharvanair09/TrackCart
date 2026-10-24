// Frontend Push Notification helper

export async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push messaging is not supported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered', registration);

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted');
      return;
    }

    // Get VAPID public key from backend
    const resp = await fetch('/api/push/publicKey');
    if (!resp.ok) {
      console.error('Failed to obtain VAPID public key');
      return;
    }
    const { publicKey } = await resp.json();
    const convertedVapidKey = urlBase64ToUint8Array(publicKey);

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey,
    });

    // Send subscription to backend (assuming sessionId is available globally or via localStorage)
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      console.warn('No sessionId found for push subscription');
      return;
    }
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, subscription }),
    });
    console.log('Push subscription sent to server');
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

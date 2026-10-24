// Service Worker for Web Push notifications
self.addEventListener('push', function(event) {
  if (!event.data) {
    console.warn('Push event but no data');
    return;
  }
  const payload = event.data.json();
  const title = payload.title || 'Cart Notification';
  const options = {
    body: payload.body,
    icon: payload.icon || '/favicon.svg',
    data: payload.data || {}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const clickUrl = event.notification.data && event.notification.data.url;
  if (clickUrl) {
    event.waitUntil(clients.openWindow(clickUrl));
  }
});

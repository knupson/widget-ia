// Service Worker mínimo: sólo permite instalar la PWA en Android.
// Sin caché a propósito: el servidor responde con no-cache (estado en vivo, SSE y API),
// así que este worker no guarda ni sirve nada. El handler de fetch queda vacío (passthrough a red).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {});

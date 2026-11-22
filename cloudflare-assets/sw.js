// FIT-CONNECT: do not cache medical/body records, authenticated pages, or API traffic.
// This service worker exists only for installability and always uses the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
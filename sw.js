/**
 * EcomDx Preventa - Service Worker for Offline Catalog Navigation
 * App 100% móvil y offline: shell + datos + fotos vistas quedan en caché.
 */
const CACHE_NAME = 'ecomdx-preventa-v1.1';
const ASSETS_TO_CACHE = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  '../images/logo.png',
  '../shared-data/catalog_data.js',
  '../shared-data/catalog_bundle.json'
];
const OFFLINE_LOGO = '../images/logo.png';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Fotos: cache-first (funcionan sin red si ya se vieron una vez)
  if (req.destination === 'image') {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        }).catch(() => caches.match(OFFLINE_LOGO));
      })
    );
    return;
  }

  // Navegación y demás: network-first con fallback a caché (ignora query strings)
  event.respondWith(
    fetch(req).catch(() => {
      return caches.match(req).then((hit) => {
        if (hit) return hit;
        return caches.match(req, { ignoreSearch: true });
      });
    })
  );
});

/**
 * EcomDx Preventa - Service Worker for Offline Catalog Navigation
 * App 100% móvil y offline: shell + datos + fotos vistas quedan en caché.
 * Todos los archivos están dentro de la misma carpeta preventa-app/.
 */
const CACHE_NAME = 'ecomdx-preventa-v1.3';
const ASSETS_TO_CACHE = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './catalog_data.js',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];
const OFFLINE_LOGO = './logo.png';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll falla si algún recurso no existe; usamos add individual para tolerar errores
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url).catch(() => null))
      );
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

  // Fotos de productos: cache-first (funcionan sin red si ya se vieron una vez)
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

  // Navegación y demás: network-first con fallback a caché
  event.respondWith(
    fetch(req).catch(() => {
      return caches.match(req).then((hit) => {
        if (hit) return hit;
        return caches.match(req, { ignoreSearch: true });
      });
    })
  );
});

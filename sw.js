/*
 * Service worker de app-shell de Listo10 (escrito a mano, sin dependencias).
 *
 * Estrategia:
 *  - Navegaciones (el index): stale-while-revalidate. Se responde al instante
 *    desde caché y se revalida en red actualizando la copia, así una versión
 *    nueva desplegada se impone en la siguiente recarga sin bloquear nada.
 *  - Assets con hash de contenido (_expo/static/ y assets/): cache-first sin
 *    revalidación — el hash garantiza que un mismo nombre nunca cambia.
 *  - Resto de ficheros del scope (manifest, iconos, favicon): stale-while-
 *    revalidate.
 *  - Nada de skipWaiting: un SW nuevo espera a que se cierren todas las
 *    pestañas antes de activarse y podar cachés, para no retirar assets que
 *    una página antigua abierta aún puede pedir (prudente). La frescura del
 *    contenido no depende de ello: la trae el SWR del index.
 *
 * Precache: tras el primer load la página manda {type: 'PRECACHE'} y el SW
 * baja en segundo plano TODO el juego local (bundle, chunk online, fuentes,
 * sonidos, iconos) según el manifiesto que scripts/inject-sw-precache.mjs
 * inyecta en este fichero al exportar (lo invoca scripts/check-preloads.mjs,
 * es decir, `npm run predeploy`). Sin inyección (expo start / export a pelo)
 * MANIFEST queda en null: no hay precache, solo caché en tiempo de ejecución,
 * y el juego sigue funcionando exactamente igual.
 *
 * Las peticiones a otros orígenes (Supabase, modo online) no se tocan.
 */

/* eslint-disable no-restricted-globals */
'use strict';

const MANIFEST = {"version":"6c06532cec79","urls":["_expo/static/js/web/OnlineScreen-95328508c547cd3b835cbb564c5be9a5.js","_expo/static/js/web/index-0eb3364ae08d77eafe283469b112bc91.js","apple-touch-icon.png","assets/assets/fonts/Baloo2_700Bold.3bfafc53aa7c948fa30e109406247ee1.woff2","assets/assets/fonts/Baloo2_800ExtraBold.d5b92866e243a95376177e58be5b6659.woff2","assets/assets/fonts/Nunito_600SemiBold.bd41e0fb96cd05f9ff1a634a8fb03dfa.woff2","assets/assets/fonts/Nunito_700Bold.70952a70f990add222be9d11db69b6c1.woff2","assets/assets/fonts/Nunito_800ExtraBold.8cfb139bd1c0ca841d5dcca5992ebe5a.woff2","assets/assets/fonts/Nunito_900Black.229a4ed2fd5039d3c4c9c2f4ba7dba9d.woff2","assets/assets/sounds/acierto.b30f620beaadcc0e928a331b4c27b320.wav","assets/assets/sounds/fallo.7d2999cb0e3eddf59b887134c2447e27.wav","assets/assets/sounds/plantada.26bbcd46d727c298ca34282e403f41b2.wav","assets/assets/sounds/traspaso.7c166436b41d51d95378e24f3a48bb12.wav","assets/assets/sounds/victoria.9431b5a55816c0fd246d8161d0743348.wav","favicon.ico","icon-192.png","icon-512.png","icon-maskable-512.png","manifest.json"]};

const BASE = new URL(self.registration.scope).pathname; // '/listo10-web/'
const VERSION = MANIFEST && MANIFEST.version ? MANIFEST.version : 'dev';
const SHELL_CACHE = 'listo10-shell-' + VERSION;
const ASSETS_CACHE = 'listo10-assets';

// Un mismo nombre de fichero aquí nunca cambia de contenido: el hash va en
// el propio nombre (bundle/chunks de Metro, fuentes y sonidos exportados).
function isImmutableAsset(pathname) {
  return (
    pathname.startsWith(BASE + '_expo/static/') || pathname.startsWith(BASE + 'assets/')
  );
}

async function precacheAll() {
  if (!MANIFEST || !Array.isArray(MANIFEST.urls)) return;
  const assets = await caches.open(ASSETS_CACHE);
  const wanted = new Set(MANIFEST.urls.map((url) => new URL(url, self.location.href).href));
  // Poda: fuera lo que ya no está en el manifiesto de esta versión.
  for (const request of await assets.keys()) {
    if (!wanted.has(request.url)) await assets.delete(request);
  }
  // Descarga tolerante: un fichero que falle no tumba el resto (se
  // reintentará en el siguiente load o al pedirlo en runtime).
  await Promise.allSettled(
    MANIFEST.urls.map(async (url) => {
      const absolute = new URL(url, self.location.href).href;
      if (await assets.match(absolute)) return;
      const response = await fetch(absolute, { cache: 'no-cache' });
      if (response.ok) await assets.put(absolute, response);
    }),
  );
}

// Stale-while-revalidate sobre una caché y una clave concretas.
async function staleWhileRevalidate(cacheName, key, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  const revalidation = fetch(request)
    .then(async (response) => {
      if (response && response.ok) await cache.put(key, response.clone());
      return response;
    });
  if (cached) {
    revalidation.catch(() => {}); // sin red: seguimos con la copia local
    return cached;
  }
  try {
    return await revalidation;
  } catch (error) {
    const retry = await cache.match(key);
    if (retry) return retry;
    throw error;
  }
}

async function cacheFirst(request) {
  const assets = await caches.open(ASSETS_CACHE);
  const cached = await assets.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await assets.put(request, response.clone());
  return response;
}

self.addEventListener('install', (event) => {
  // Deja el shell listo para funcionar sin red desde la primera visita.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((shell) => shell.add(new Request(BASE, { cache: 'reload' })))
      .catch(() => {}), // sin red durante la instalación: el SWR lo cacheará después
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Poda de shells de versiones anteriores; la caché de assets es
      // compartida (nombres inmutables) y se poda en precacheAll().
      for (const key of await caches.keys()) {
        if (key.startsWith('listo10-shell-') && key !== SHELL_CACHE) {
          await caches.delete(key);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE') {
    event.waitUntil(precacheAll().catch(() => {}));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase y demás: a la red
  if (!url.pathname.startsWith(BASE)) return;

  if (request.mode === 'navigate') {
    // Cualquier navegación dentro del scope sirve el mismo shell (SPA).
    event.respondWith(staleWhileRevalidate(SHELL_CACHE, BASE, request));
    return;
  }
  if (isImmutableAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(ASSETS_CACHE, request, request));
});

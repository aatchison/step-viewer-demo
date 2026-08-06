// sw.js — offline / CDN-blip resilience for the STEP viewer demo.
//
// Every core dependency loads from jsdelivr at runtime (three.module.js + addons,
// occt-import-js.js and its sibling .wasm) and the samples come from the origin,
// so a page reload while offline — or during a transient jsdelivr blip — dies on
// a blank engine-error panel. This service worker precaches the exact pinned URLs
// the app hardcodes and serves them cache-first, so a warm reload works fully
// offline and a CDN hiccup is answered from cache. Zero-build and fully
// GitHub-Pages compatible: HTTPS + a same-origin SW, no backend.
//
// Bump CACHE_NAME whenever a pinned version below changes so the activate handler
// evicts the stale cache (otherwise a version bump would keep serving old WASM).
const CACHE_NAME = 'step-viewer-cache-v1';

// Keep these pins in lockstep with the importmap in index.html and OCCT_VERSION
// in src/step.js. Pinning by the exact versioned URL keeps the cache key stable
// across reloads (an unpinned "latest" would churn the cache on every CDN update).
const THREE_VERSION = '0.160.0';
const OCCT_VERSION = '0.0.23';
const THREE_BASE = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/`;
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

// Everything the app needs to boot and render a sample with no network:
//   • the app shell (page + ES modules + parse worker + i18n table)
//   • the pinned CDN deps — three core, every addon actually imported, and occt's
//     .js + sibling .wasm
//   • the four .step gallery samples plus the .iges sample (the IGES gallery pill)
// Addons: the issue names OrbitControls/RoomEnvironment/ViewHelper, but the module
// also imports GLTFExporter (STL/GLTF export) which in turn imports utils/
// TextureUtils.js — both are precached too, otherwise export would break offline.
// All three named addons + TextureUtils import only 'three', so this list is the
// complete transitive addon closure at three@0.160.0.
const PRECACHE_URLS = [
  // App shell (same-origin, relative to the SW scope).
  './',
  './index.html',
  './src/step.js',
  './src/step.worker.js',
  './src/i18n.js',
  // Bundled gallery models.
  './samples/sample.step',
  './samples/block.step',
  './samples/tetra.step',
  './samples/pyramid.step',
  './samples/cube.iges',
  // three.js core + addon closure (cross-origin, permissive CORS on jsdelivr).
  `${THREE_BASE}build/three.module.js`,
  `${THREE_BASE}examples/jsm/controls/OrbitControls.js`,
  `${THREE_BASE}examples/jsm/environments/RoomEnvironment.js`,
  `${THREE_BASE}examples/jsm/helpers/ViewHelper.js`,
  `${THREE_BASE}examples/jsm/exporters/GLTFExporter.js`,
  `${THREE_BASE}examples/jsm/utils/TextureUtils.js`,
  // occt-import-js engine + its WASM binary.
  `${OCCT_BASE}occt-import-js.js`,
  `${OCCT_BASE}occt-import-js.wasm`,
];

// The set of absolute URLs we own, resolved against the SW scope so a same-origin
// './index.html' entry compares equal to the browser's absolute request URL. The
// fetch handler consults this to decide cache-first vs. straight passthrough.
const PRECACHE_SET = new Set(PRECACHE_URLS.map((u) => new URL(u, self.location).href));

// Install: open the versioned cache and precache every pinned URL. Each put is
// added individually and its failure swallowed, so one flaky cross-origin fetch
// (jsdelivr blip mid-install) can't reject the whole install — the app still runs
// online and the missing entry is filled on first cache-first miss (see fetch).
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            // Non-fatal: log and continue so install always resolves.
            console.warn('[sw] precache skipped:', url, err);
          })
        )
      );
      // Take over on next reload without waiting for all tabs to close.
      await self.skipWaiting();
    })()
  );
});

// Activate: drop any cache whose name isn't the current CACHE_NAME so a pinned-
// version bump (new CACHE_NAME) evicts the stale WASM/module set, then claim open
// clients so the new worker controls this page immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Fetch: cache-first (fallback to network) for the pinned set only; every other
// request passes straight through untouched. On a cache miss we hit the network
// and, on success, warm the cache so an install-time skip self-heals. If the
// network also fails we fall back to any cached copy one last time (undefined ⇒
// the browser sees a normal network error, exactly as without the SW).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only GETs are cacheable; leave POST/HEAD/etc. alone.
  if (req.method !== 'GET') return;
  // Not one of ours → don't intercept; let the network handle it normally.
  if (!PRECACHE_SET.has(new URL(req.url).href)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Only cache real successes (status 200). An opaque/error response is
        // returned to the caller but never poisons the cache.
        if (res && res.ok) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        // Offline and not yet cached: last-ditch match (may be undefined, which
        // surfaces as a normal network failure to the app's own retry path).
        return (await cache.match(req)) || Promise.reject(err);
      }
    })()
  );
});

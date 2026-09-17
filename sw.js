/* NRDS Tahiti — Service Worker v4
 * Intercepts only: same-origin app shell + map tiles.
 * Does NOT touch esm.sh, supabase.co, or any other cross-origin request
 * (intercepting esm.sh ES-module imports breaks Supabase on mobile). */

var CACHE = 'nrds-v4';
var TILE_CACHE = 'nrds-tiles-v1';
var BASE = new URL(self.location.href).pathname.replace('sw.js', '');

var PRECACHE = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'data/management_unit.json',
  BASE + 'data/derat_tahiti.json',
  BASE + 'data/espece.json',
  BASE + 'data/bird_species.json',
  BASE + 'data/live/habitat_restoration.json',
  BASE + 'data/live/deratisation.json',
  BASE + 'data/live/deratisation_checks.json',
  BASE + 'data/offline_tiles.json',
];

/* Install: pre-cache app shell. Each URL cached independently so one
 * 404 doesn't abort the whole install. */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      var fetches = PRECACHE.map(function(url) {
        return cache.add(url).catch(function() {});
      });
      return Promise.all(fetches);
    }).then(function() { return self.skipWaiting(); })
  );
});

/* Activate: delete old caches, claim all clients immediately. */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(k) { return k !== CACHE && k !== TILE_CACHE; })
          .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
  /* Separate waitUntil so it runs alongside the cache cleanup above without
   * delaying clients.claim() — this can take a while on a slow connection and
   * the app shell shouldn't wait on it. See precacheOfflineTiles() below. */
  e.waitUntil(precacheOfflineTiles());
});

/* ── Offline map tiles for the 3 valleys (Papehue, Maruapo, Hopa) ──
 * Marco's field team sometimes forgets to open the app while still in signal
 * range, so the map (satellite imagery) needs to already be cached before
 * they ever go looking for it, not lazily as they pan around. data/offline_tiles.json
 * (built by scripts/generate-offline-tiles.mjs from the real valley geometry,
 * with a ~1.1km buffer for approach trails) lists every Esri World Imagery
 * tile z/x/y covering those valleys at zoom 12-18. This walks that list and
 * fetches whatever isn't already in TILE_CACHE — cheap/no-op on repeat runs
 * since each tile is skipped once cached. Runs on every activate() (i.e. every
 * time this file changes and the new SW takes over) and on-demand via a
 * postMessage('PRECACHE_TILES') from the page (see index.html), so it also
 * retries opportunistically whenever the phone comes back online. */
var TILE_FETCH_CONCURRENCY = 4;

function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function reportTileProgress(done, total) {
  self.clients.matchAll().then(function(clients) {
    clients.forEach(function(c) {
      c.postMessage({ type: 'offlineTilesProgress', done: done, total: total });
    });
  });
}

function precacheOfflineTiles() {
  return fetch(BASE + 'data/offline_tiles.json', { cache: 'no-store' })
    .then(function(resp) { return resp.ok ? resp.json() : null; })
    .then(function(manifest) {
      if (!manifest || !manifest.tiles || !manifest.tiles.length) return;
      return caches.open(TILE_CACHE).then(function(cache) {
        var tiles = manifest.tiles;
        var total = tiles.length;
        var done = 0;
        var i = 0;
        function nextBatch() {
          if (i >= tiles.length) {
            reportTileProgress(total, total);
            return Promise.resolve();
          }
          var batch = tiles.slice(i, i + TILE_FETCH_CONCURRENCY);
          i += TILE_FETCH_CONCURRENCY;
          return Promise.all(batch.map(function(t) {
            var req = new Request(tileUrl(manifest.urlTemplate, t.z, t.x, t.y));
            return cache.match(req).then(function(hit) {
              done++;
              if (hit) return;
              return fetch(req).then(function(resp) {
                if (resp && resp.ok) return cache.put(req, resp);
              }).catch(function() {}); // offline / one bad tile — skip, next trigger retries it
            });
          })).then(function() {
            reportTileProgress(done, total);
            return nextBatch();
          });
        }
        return nextBatch();
      });
    })
    .catch(function() {}); // no network right now — fine, activate() shouldn't fail over this
}

self.addEventListener('message', function(e) {
  if (e.data === 'PRECACHE_TILES') {
    // ExtendableMessageEvent.waitUntil isn't supported on every engine (notably
    // older Safari) — fall back to just calling it without extending the SW's
    // lifetime guarantee; best-effort either way, retried on the next trigger.
    if (typeof e.waitUntil === 'function') e.waitUntil(precacheOfflineTiles());
    else precacheOfflineTiles();
  }
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch(err) { return; }

  /* ── Map tiles: cache-first, populate on first view ──
   * Only images — safe to cache as opaque responses. */
  if (
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('tile.openstreetmap.org')
  ) {
    e.respondWith(
      caches.open(TILE_CACHE).then(function(cache) {
        return cache.match(req).then(function(hit) {
          if (hit) return hit;
          return fetch(req).then(function(resp) {
            if (resp && resp.ok && resp.status === 200) {
              cache.put(req, resp.clone());
            }
            return resp;
          }).catch(function() {
            return new Response('', { status: 503, statusText: 'Tile offline' });
          });
        });
      })
    );
    return;
  }

  /* ── App shell (the page itself): network-first ──
   * This is the file that actually changes on every deploy — cache-first here meant a
   * fix could sit deployed on GitHub Pages for days while every phone kept serving the
   * cached-before-the-fix version (each reload silently re-cached the newer copy in the
   * background, but only *displayed* it one reload later — always one version behind).
   * Try the network first so an online reload always gets the latest app code; only fall
   * back to the last-known-good cached copy when there's truly no connection (in the
   * valleys). */
  var isAppShell = req.mode === 'navigate' || url.pathname === BASE || url.pathname === BASE + 'index.html';
  /* ── data/*.json: network-first, same reasoning as the app shell ──
   * All of data/*.json (including data/live/*) is now refreshed automatically every 6h by
   * .github/workflows/sync-metabase.yml — cache-first here meant a phone that had ever loaded
   * the app would keep showing the exact data snapshot from its first visit forever, silently
   * never picking up new NRDS entries (2026-08-15: this is why Marco's new Hopa observation
   * never appeared on the map even though the sync itself was working correctly). */
  var isDataJson = url.pathname.indexOf(BASE + 'data/') === 0;
  if (url.origin === self.location.origin && (isAppShell || isDataJson)) {
    /* GitHub Pages serves every file with Cache-Control: max-age=600 -- a plain fetch(req) still
     * honors that and can be silently answered from the browser's own HTTP disk cache without
     * ever reaching the network, defeating "network-first" for up to 10 minutes after any page
     * loaded that resource (confirmed 2026-09-02: this, not the Cache API above, is why a reload
     * without a manual cache-clear kept showing stale data). { cache: 'no-store' } forces the
     * browser to actually hit the network; we still keep our own copy via the Cache API put()
     * below for the offline fallback. */
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(function(resp) {
        if (resp && resp.ok) caches.open(CACHE).then(function(c) { c.put(req, resp.clone()); });
        return resp;
      }).catch(function() {
        return caches.match(req).then(function(hit) { return hit || new Response('App offline', { status: 503 }); });
      })
    );
    return;
  }

  /* ── Everything else same-origin: manifest, icons — cache-first ──
   * These only change on a code deploy (rare, and always alongside index.html which is
   * network-first anyway), so cache-first (instant, works offline) is still the right
   * tradeoff for them.
   * On miss: fetch from network and add to cache.
   * On network error with cache hit: return stale cache. */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function(hit) {
        var networkFetch = fetch(req).then(function(resp) {
          if (resp && resp.ok) {
            caches.open(CACHE).then(function(c) { c.put(req, resp.clone()); });
          }
          return resp;
        }).catch(function() {
          return hit || new Response('App offline', { status: 503 });
        });
        return hit || networkFetch;
      })
    );
    return;
  }

  /* Everything else (esm.sh, supabase.co, analytics, …) — do NOT intercept.
   * Returning without calling e.respondWith() lets the browser handle normally. */
});

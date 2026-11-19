/* NRDS Tahiti — Service Worker v5 (2026-11-18)
 * Intercepts only: same-origin app shell/data + map tiles.
 * Does NOT touch esm.sh, supabase.co, or any other cross-origin request
 * (intercepting esm.sh ES-module imports breaks Supabase on mobile).
 *
 * v5 fixes (Marco, 2026-11-18: "offline the installed app became a very old version" and
 * "when the signal comes back for a moment and disappears again I lose the maps"):
 *  1. The offline copy of index.html / data/*.json was NEVER refreshed after the first install:
 *     the network-first handler called resp.clone() inside caches.open().then(), i.e. after the
 *     response had already been handed to the page, whose body was then already being read ->
 *     clone() threw "body already used" and the put silently failed. Every phone kept the copy
 *     from the day its service worker was first installed (v4 = mid-September). Now the clone is
 *     taken synchronously, before the response is returned, and the put is kept alive with
 *     waitUntil().
 *  2. One canonical cache key for the page (index.html), whatever URL opened it ('./', './index.html',
 *     './?x', './#map'), so the offline fallback always finds the latest copy.
 *  3. Network-first with a timeout: on a weak / flickering connection ("lie-fi") the request used to
 *     hang for a minute or more, leaving a blank app. Now, if the network has not answered within a
 *     few seconds, the cached copy is shown at once and the network keeps going in the background to
 *     refresh the cache for next time.
 *  4. Map tiles are fetched in CORS mode, so tiles viewed while online are also kept for offline use
 *     (Leaflet's <img> requests are no-cors -> opaque responses, which were never cached). Each tile
 *     download has a timeout so the offline-map pre-download can no longer stall forever on lie-fi.
 *  5. The new cache is only used if index.html was actually downloaded at install, so an update on a
 *     bad connection can never leave the phone without an offline app.
 */

var CACHE = 'nrds-v5';
var TILE_CACHE = 'nrds-tiles-v1'; // unchanged on purpose: tiles already downloaded on the phones stay valid
var BASE = new URL(self.location.href).pathname.replace('sw.js', '');
var SHELL_KEY = BASE + 'index.html';
var SHELL_TIMEOUT_MS = 4000;
var DATA_TIMEOUT_MS = 5000;
var TILE_TIMEOUT_MS = 15000;

var PRECACHE_DATA = [
  BASE + 'manifest.json',
  BASE + 'icon-192.png',
  BASE + 'data/management_unit.json',
  BASE + 'data/derat_tahiti.json',
  BASE + 'data/espece.json',
  BASE + 'data/bird_species.json',
  BASE + 'data/monarch_territories.json',
  BASE + 'data/live/habitat_restoration.json',
  BASE + 'data/live/habitat_restoration_espece.json',
  BASE + 'data/live/deratisation.json',
  BASE + 'data/live/deratisation_checks.json',
  BASE + 'data/live/fond_vert_recovered.csv',
  BASE + 'data/live/fond_vert_recovered_species.csv',
  BASE + 'data/offline_tiles.json',
];

function fetchWithTimeout(input, init, ms) {
  if (typeof AbortController === 'undefined') return fetch(input, init);
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, ms);
  init = Object.assign({}, init || {}, { signal: ctrl.signal });
  return fetch(input, init).then(function(r) { clearTimeout(timer); return r; },
                                 function(err) { clearTimeout(timer); throw err; });
}

/* Install: the page itself is REQUIRED (install fails -> the old service worker and its offline copy
 * stay in charge); everything else is best effort. cache:'reload' skips the browser HTTP cache so we
 * never store an outdated copy. */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return fetch(new Request(SHELL_KEY, { cache: 'reload' })).then(function(resp) {
        if (!resp || !resp.ok) throw new Error('index.html not downloaded');
        return cache.put(SHELL_KEY, resp);
      }).then(function() {
        return Promise.all(PRECACHE_DATA.map(function(url) {
          return fetch(new Request(url, { cache: 'reload' })).then(function(resp) {
            if (resp && resp.ok) return cache.put(url, resp);
          }).catch(function() {});
        }));
      });
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
    }).then(function() {
      return self.clients.claim();
    }).then(function() {
      /* Started here but NOT awaited: while the activate event is still extended, the browser holds
       * back every fetch of the page, so v4 (which kept activate alive for the whole tile download,
       * ~1900 tiles) froze the app for minutes after each update. The page also asks for it with
       * postMessage('PRECACHE_TILES'), whose waitUntil does not block anything. */
      precacheOfflineTiles();
    })
  );
});

/* ── Offline map tiles for the valleys ──
 * data/offline_tiles.json (built by scripts/generate-offline-tiles.mjs from the real valley geometry,
 * with a ~1.1 km buffer) lists every Esri World Imagery tile z/x/y covering the valleys at zoom 12-18.
 * This walks that list and fetches whatever isn't already in TILE_CACHE — a no-op for tiles already
 * cached. Runs on every activate and on demand via postMessage('PRECACHE_TILES') from the page (on
 * load, when the connection returns, when a new service worker takes over). */
var TILE_FETCH_CONCURRENCY = 6;
var precacheRunning = null;

function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function reportTileProgress(done, total, missing) {
  self.clients.matchAll().then(function(clients) {
    clients.forEach(function(c) {
      c.postMessage({ type: 'offlineTilesProgress', done: done, total: total, missing: missing || 0 });
    });
  });
}

function fetchTile(url) {
  return fetchWithTimeout(url, { mode: 'cors', credentials: 'omit' }, TILE_TIMEOUT_MS);
}

function precacheOfflineTiles() {
  if (precacheRunning) return precacheRunning; // flickering connection -> many 'online' events; run one pass at a time
  precacheRunning = fetch(BASE + 'data/offline_tiles.json', { cache: 'no-store' })
    .then(function(resp) { return resp.ok ? resp.json() : null; })
    .catch(function() { return caches.match(BASE + 'data/offline_tiles.json').then(function(r) { return r ? r.json() : null; }); })
    .then(function(manifest) {
      if (!manifest || !manifest.tiles || !manifest.tiles.length) return;
      return caches.open(TILE_CACHE).then(function(cache) {
        var tiles = manifest.tiles;
        var total = tiles.length;
        var done = 0, missing = 0, i = 0;
        function nextBatch() {
          if (i >= tiles.length) {
            reportTileProgress(total - missing, total, missing);
            return Promise.resolve();
          }
          var batch = tiles.slice(i, i + TILE_FETCH_CONCURRENCY);
          i += TILE_FETCH_CONCURRENCY;
          return Promise.all(batch.map(function(t) {
            var url = tileUrl(manifest.urlTemplate, t.z, t.x, t.y);
            return cache.match(url).then(function(hit) {
              if (hit) { done++; return; }
              return fetchTile(url).then(function(resp) {
                if (resp && resp.ok) { done++; return cache.put(url, resp); }
                missing++;
              }).catch(function() { missing++; }); // offline / one bad tile: next trigger retries it
            });
          })).then(function() {
            reportTileProgress(done, total, missing);
            return nextBatch();
          });
        }
        return nextBatch();
      });
    })
    .catch(function() {})
    .then(function() { precacheRunning = null; });
  return precacheRunning;
}

self.addEventListener('message', function(e) {
  if (e.data === 'PRECACHE_TILES') {
    if (typeof e.waitUntil === 'function') e.waitUntil(precacheOfflineTiles());
    else precacheOfflineTiles();
  }
});

/* Network-first with timeout and cache fallback, for the page and data/*.json. */
function networkFirst(e, cacheKey, timeoutMs) {
  var req = e.request;
  var putDone = null;
  /* GitHub Pages serves every file with Cache-Control: max-age=600 — { cache: 'no-store' } makes the
   * browser really hit the network instead of its own HTTP cache (2026-09-02). */
  var network = fetch(req, { cache: 'no-store' }).then(function(resp) {
    if (resp && resp.ok) {
      var copy = resp.clone(); // synchronously, BEFORE the page starts reading the body (v5 fix 1)
      putDone = caches.open(CACHE).then(function(c) { return c.put(cacheKey, copy); }).catch(function() {});
    }
    return resp;
  });
  e.waitUntil(network.then(function() { return putDone; }, function() {}));

  e.respondWith(new Promise(function(resolve) {
    var settled = false;
    function done(r) { if (!settled) { settled = true; resolve(r); } }
    function fromCache(fallback) {
      return caches.match(cacheKey).then(function(hit) {
        if (hit) done(hit); else if (fallback) done(fallback);
      });
    }
    var timer = setTimeout(function() { fromCache(null); }, timeoutMs);
    network.then(function(resp) {
      clearTimeout(timer);
      if (resp && resp.ok) done(resp);
      else fromCache(resp); // server error: prefer the last good copy
    }, function() {
      clearTimeout(timer);
      fromCache(new Response('App offline — open it once with a connection to store it on this phone.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    });
  }));
}

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch(err) { return; }

  /* ── Map tiles: cache-first, populate on first view ── */
  if (url.hostname.indexOf('arcgisonline.com') !== -1 || url.hostname.indexOf('tile.openstreetmap.org') !== -1) {
    e.respondWith(
      caches.open(TILE_CACHE).then(function(cache) {
        return cache.match(req.url).then(function(hit) {
          if (hit) return hit;
          return fetchTile(req.url).then(function(resp) {
            if (resp && resp.ok) cache.put(req.url, resp.clone());
            return resp;
          }).catch(function() {
            return new Response('', { status: 503, statusText: 'Tile offline' });
          });
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // esm.sh, supabase.co, … — not intercepted

  /* ── The page itself: network-first, one canonical cache key ── */
  var isAppShell = req.mode === 'navigate' || url.pathname === BASE || url.pathname === SHELL_KEY;
  if (isAppShell) { networkFirst(e, SHELL_KEY, SHELL_TIMEOUT_MS); return; }

  /* ── data/*: network-first (refreshed every few hours by .github/workflows/sync-metabase.yml) ── */
  if (url.pathname.indexOf(BASE + 'data/') === 0) { networkFirst(e, url.origin + url.pathname, DATA_TIMEOUT_MS); return; }

  /* ── Everything else same-origin (manifest, icons, splash): cache-first ── */
  e.respondWith(
    caches.match(req).then(function(hit) {
      if (hit) return hit;
      return fetch(req).then(function(resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(req, copy); });
        }
        return resp;
      }).catch(function() {
        return new Response('App offline', { status: 503 });
      });
    })
  );
});

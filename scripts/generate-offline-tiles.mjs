// Generates data/offline_tiles.json — the list of Esri World Imagery tile
// coordinates covering the 3 SOP Manu valleys (Papehue, Maruapo, Hopa), so the
// service worker can pre-download them in the background and satellite
// imagery is available offline even on a phone that never manually opened
// the Map tab while it had a connection.
//
// Re-run this (`npm run generate-offline-tiles`) if the valley boundaries in
// data/management_unit.json or the station registry in data/derat_tahiti.json
// change enough to shift outside the current buffered bounding box — check
// git diff on this file's `valleys` block to see if it moved meaningfully.

import { readFileSync, writeFileSync } from 'node:fs';

const MIN_ZOOM = 12;
const MAX_ZOOM = 18; // native max for World_Imagery is 19; 18 keeps the one-time
                      // download in the low tens of MB instead of ~150MB+ at 19.
const BUFFER_DEG = 0.01; // ~1.1km — covers approach trails around each valley's
                          // known management-unit/station extent, not just the polygons themselves.

function extendBounds(bounds, valley, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  if (!bounds[valley]) {
    bounds[valley] = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
  }
  const b = bounds[valley];
  if (lon < b.minLon) b.minLon = lon;
  if (lon > b.maxLon) b.maxLon = lon;
  if (lat < b.minLat) b.minLat = lat;
  if (lat > b.maxLat) b.maxLat = lat;
}

function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2y(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}

const managementUnits = JSON.parse(readFileSync('data/management_unit.json', 'utf8'));
const deratStations = JSON.parse(readFileSync('data/derat_tahiti.json', 'utf8'));

const bounds = {};
for (const row of managementUnits) {
  const valley = row.Vallee;
  if (!valley) continue;
  const nums = String(row.Geometry || '').match(/-?\d+\.\d+/g);
  if (!nums) continue;
  for (let i = 0; i < nums.length; i += 2) {
    extendBounds(bounds, valley, parseFloat(nums[i]), parseFloat(nums[i + 1]));
  }
}
for (const row of deratStations) {
  const valley = row.Vallee;
  if (!valley) continue;
  extendBounds(bounds, valley, row.Longitude, row.Latitude);
}

const valleySummary = {};
const tileSet = new Map(); // "z/x/y" -> {z,x,y}, de-duplicated across overlapping valley buffers

for (const valley of Object.keys(bounds)) {
  const b = bounds[valley];
  valleySummary[valley] = { ...b, bufferDeg: BUFFER_DEG };
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const x1 = lon2x(b.minLon - BUFFER_DEG, z);
    const x2 = lon2x(b.maxLon + BUFFER_DEG, z);
    const y1 = lat2y(b.maxLat + BUFFER_DEG, z);
    const y2 = lat2y(b.minLat - BUFFER_DEG, z);
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        tileSet.set(`${z}/${x}/${y}`, { z, x, y });
      }
    }
  }
}

const tiles = Array.from(tileSet.values()).sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);

const manifest = {
  generatedAt: new Date().toISOString(),
  provider: 'esri-world-imagery',
  urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  bufferDeg: BUFFER_DEG,
  valleys: valleySummary,
  tileCount: tiles.length,
  tiles,
};

writeFileSync('data/offline_tiles.json', JSON.stringify(manifest));
console.log(`Wrote data/offline_tiles.json — ${tiles.length} tiles across ${Object.keys(bounds).length} valleys, zoom ${MIN_ZOOM}-${MAX_ZOOM}.`);

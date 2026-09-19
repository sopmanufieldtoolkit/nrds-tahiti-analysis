// Pulls current data from the shared Metabase instance (metabase.nrds.io) and writes it
// into data/*.json in the same shape the app already expects, plus data/live/*.json for
// tables the app doesn't consume yet. Run by .github/workflows/sync-metabase.yml on a
// schedule, or locally with METABASE_API_TOKEN set in the environment.
//
// Auth: personal API key from Sam Aruch (NRDS/Metabase admin), scoped to a dedicated
// "tahiti" API-key user (not a real login), group_ids [1,104], can_create_native_queries:
// false (no raw SQL). Never commit the token itself — it must only exist as the
// METABASE_API_TOKEN GitHub Actions secret.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import wkx from 'wkx';

const BASE_URL = 'https://metabase.nrds.io';
const DATABASE_ID = 2;
const TOKEN = process.env.METABASE_API_TOKEN;
if (!TOKEN) {
  console.error('Missing METABASE_API_TOKEN environment variable.');
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');

const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithRetry(url, options, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      const reason = e.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : e.message;
      if (i === attempts) throw new Error(`Fetch failed after ${attempts} attempts: ${reason}`);
      console.warn(`Fetch failed (attempt ${i}/${attempts}): ${reason}. Retrying...`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    } finally {
      clearTimeout(timer);
    }
  }
}

// This Metabase instance silently ignores the standard MBQL `limit`+`offset` pair on
// `/api/dataset` for `source-table` queries — every page comes back identical to page 1
// (confirmed 2026-08-13: offset=0, offset=5, and offset=4067 on a 4072-row table all
// returned the exact same 5 rows). This caused an infinite pagination loop in production
// against a shared instance, since `rows.length < pageSize` never became true. The `page:
// {page, items}` clause works correctly (verified: page 2 returns genuinely different rows)
// and is used instead. Do not switch back to limit/offset without re-verifying against real
// data first — this may be instance/version-specific, not a general Metabase behavior.
async function getTableMetadata(tableId) {
  const res = await fetchWithRetry(`${BASE_URL}/api/table/${tableId}/query_metadata`, {
    headers: { 'X-API-Key': TOKEN },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch metadata for table ${tableId}: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function findField(meta, tableId, fieldName) {
  const field = meta.fields.find((f) => f.name === fieldName);
  if (!field) throw new Error(`Field "${fieldName}" not found in table ${tableId}`);
  return field;
}

const MAX_PAGES = 500; // safety cap (500 * 2000 = 1M rows) so a repeat of the offset bug can't hammer the server forever

// orderByFields: column name(s) to sort by for deterministic pagination. A single column is
// enough when it's a genuine per-row unique id; child tables where that column repeats per
// parent (e.g. Dératisation Checks' survey_id is the parent patrol's id, not a unique row id)
// need a second tiebreaker column passed here too.
//
// excludeFields: column names to leave out of the query entirely. Needed because this Metabase
// instance's "select all columns" default (used when no `fields` clause is given) queries every
// column its OWN cached table metadata still lists — including one dropped from the underlying
// Postgres table without a schema resync (admin-only, unavailable to this API key; see
// data/live/README.md's 2026-08-25 note). Passing an explicit `fields` list that skips the
// now-missing column(s) avoids ever generating a SELECT for them, sidestepping the stale-cache
// query failure entirely — no admin resync needed for the sync itself to keep working.
//
// This turned out not to be a one-off: a second, different column went stale the very next day
// (unit_name_sb_2024_id — Metabase's error even hinted at the replacement, unit_name_sb_2025_id —
// from an unrelated Management Unit template edit). Rather than manually chasing each new dead
// column as templates keep changing, queryTable() below auto-detects Postgres's "column ... does
// not exist" error, excludes that column, and retries — excludeFields above stays for callers who
// already know a column is dead (skips the wasted failing request), but isn't required for the
// sync to survive future template edits.
const STALE_COLUMN_RE = /column\s+[\w."]*\.([a-zA-Z0-9_]+)\s+does not exist/i;
const MAX_AUTO_EXCLUDE = 10; // safety cap — a real, unrelated failure shouldn't retry forever

async function queryTable(tableId, label, orderByFields = ['survey_id'], excludeFields = [], _autoExcluded = new Set()) {
  const start = Date.now();
  console.log(`Querying ${label} (table ${tableId})...`);
  const meta = await getTableMetadata(tableId);
  const excludeSet = new Set([...excludeFields, ..._autoExcluded]);
  const selectFields = meta.fields.filter((f) => !excludeSet.has(f.name));
  const fields = selectFields.map((f) => ['field', f.id, null]);
  const orderBy = orderByFields.map((name) => [['field', findField(meta, tableId, name).id, null], 'asc']);
  const rows = [];
  const cols = selectFields.map((f) => f.name);
  const pageSize = 2000;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      throw new Error(`Table ${tableId} (${label}) exceeded ${MAX_PAGES} pages — aborting, likely a pagination bug.`);
    }
    const pageStart = Date.now();
    const res = await fetchWithRetry(`${BASE_URL}/api/dataset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': TOKEN,
      },
      body: JSON.stringify({
        database: DATABASE_ID,
        type: 'query',
        query: { 'source-table': tableId, fields, 'order-by': orderBy, page: { page, items: pageSize } },
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      const staleMatch = bodyText.match(STALE_COLUMN_RE);
      if (staleMatch && !_autoExcluded.has(staleMatch[1]) && _autoExcluded.size < MAX_AUTO_EXCLUDE) {
        console.warn(`Column "${staleMatch[1]}" on table ${tableId} (${label}) no longer exists in Postgres but Metabase's schema cache still lists it — excluding it and retrying.`);
        return queryTable(tableId, label, orderByFields, excludeFields, new Set([..._autoExcluded, staleMatch[1]]));
      }
      throw new Error(`Metabase query failed for table ${tableId}: HTTP ${res.status} ${bodyText}`);
    }
    const json = await res.json();
    rows.push(...json.data.rows);
    console.log(`  page ${page}: +${json.data.rows.length} rows (${Date.now() - pageStart}ms)`);
    if (json.data.rows.length < pageSize) break;
  }
  console.log(`Done ${label}: ${rows.length} rows total (${Date.now() - start}ms)`);
  return { cols, rows };
}

// mapping: array of [outputKey, sourceColName | (rawObj) => value]
function mapRows({ cols, rows }, mapping) {
  return rows.map((row) => {
    const raw = {};
    cols.forEach((c, i) => { raw[c] = row[i]; });
    const out = {};
    for (const [outKey, source] of mapping) {
      out[outKey] = typeof source === 'function' ? source(raw) : raw[source] ?? '';
    }
    return out;
  });
}

function ewkbHexToEwkt(hex) {
  if (!hex) return '';
  try {
    return wkx.Geometry.parse(Buffer.from(hex, 'hex')).toEwkt();
  } catch (e) {
    console.warn('Failed to parse geometry hex, leaving blank:', e.message);
    return '';
  }
}

function pointEwkt(lon, lat) {
  if (lon == null || lat == null) return '';
  return `SRID=4326;POINT (${lon} ${lat})`;
}

async function writeJson(relPath, data) {
  const full = path.join(ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data), 'utf-8');
  console.log(`Wrote ${relPath} (${data.length} rows)`);
}

// ---- Tables already consumed by the app (data/*.json) — mapped to match the existing shape ----

const MANAGEMENT_UNIT_MAP = [
  ['Identifier', 'survey_id'],
  ['Nom', 'nom'],
  ['Vallee', 'vallee'],
  ['Site', 'site'],
  ['Nom_prov', 'nom_prov'],
  ['Veg_2023', 'veg_2023'],
  ['Veg_2024', 'veg_2024'],
  ['SB_2023', 'sb_2023'],
  ['SB_2024', 'sb_2024'],
  ['Plant_2023', 'plant_2023'],
  ['Plant_2024', 'plant_2024'],
  ['Surface', 'surface'],
  ['Geometry', (r) => ewkbHexToEwkt(r.geometry)],
];

const DERAT_TAHITI_MAP = [
  ['Identifier', 'survey_id'],
  ['Station', 'station'],
  ['Ligne_stat', 'ligne_stat'],
  ['Zone', 'zone'],
  ['Vallee', 'vallee'],
  ['Waypoint', 'waypoint'],
  ['X', 'x'],
  ['Y', 'y'],
  ['Altitude', 'altitude'],
  ['Date', 'date'],
  ['Heure 1', 'heure_1'],
  ['Heure 2', 'heure_2'],
  ['Vegetation', 'vegetation'],
  ['Sous bois', 'sous_bois'],
  ['Plantation', 'plantation'],
  ['Pente', 'pente'],
  ['Situation', 'situation'],
  ['Flore', 'flore'],
  ['Nombre', 'nombre'],
  ['Type', 'type'],
  ['Autre', 'autre'],
  ['Num_Stat', 'num_sta1'],
  ['Num_stat2', 'num_stat2'],
  ['Geometry', (r) => pointEwkt(r.geometry_long, r.geometry_lat)],
  ['Latitude', 'geometry_lat'],
  ['Longitude', 'geometry_long'],
  ['Last Check', 'last_chec1'],
];

// Verified against known-good values in the app's existing espece.json (e.g. Identifier
// 3952716 = Pandanus/Native): Metabase's own sync mislabels these three columns — the real
// "Common Name" lands in "common_nam1" (truncated) and the real "Type" lands in
// "common_name". Do not "fix" this mapping without re-verifying against real data first.
const ESPECE_MAP = [
  ['Identifier', 'survey_id'],
  ['Name', 'name'],
  ['Common Name', 'common_nam1'],
  ['Type', 'common_name'],
];

// Habitat Restoration Espèce (table 9727) -- confirmed via a diagnostic-only run (2026-09-19,
// see main()) to be a full per-species EXPLOSION of the Habitat Restoration template: every
// parent column is repeated on each row, one row per species planted, with esp_ce_* holding
// exactly one distinct species per row (unlike table 6995's single collapsed esp_ce_* value).
// Verified real column names + a real sample row (survey_id 4753214: esp_ce_esp_ce_name="Apape",
// esp_ce_esp_ce_common_name="Apape", esp_ce_esp_ce_type="Native", esp_ce_number=1) before writing
// this -- do not go back to guessing columns by regex here (see main()'s comment for what that
// broke on 2026-09-19: it silently picked esp_ce_esp_ce_name_id and number_of_person instead).
const HABITAT_ESPECE_MAP = [
  ['Identifier', 'survey_id'],
  ['Espèce', (r) => [r.esp_ce_esp_ce_name, r.esp_ce_esp_ce_common_name, r.esp_ce_esp_ce_type].join(' | ')],
  ['Number', 'esp_ce_number'],
];

// ---- Tables not yet used by the app UI (data/live/*.json) — plain pass-through ----

const DERATISATION_MAP = [
  ['Identifier', 'survey_id'],
  ['Date', 'date'],
  ['Observer', 'observer'],
  ['Zone', 'zone'],
  ['Passage', 'passage'],
  // 'Ligne_stat' and 'Conso_Ligne' added 2026-09-02 (Select, Source: Templates -> Derat Tahiti /
  // Select, Source: Custom 0-4) as an alternative to logging Conso per individual rat station:
  // Conso_Ligne lets a whole line get one score instead of one Checks row per station. Confirmed
  // via a debug run (2026-09-02) that Metabase names a Templates-sourced Select's column
  // "{question}_{linked field}", not just the question name -- Ligne_stat's real column is
  // 'ligne_stat_ligne_stat', not the guessed 'ligne_stat'. Conso_Ligne (plain Custom source) needed
  // no such fix.
  ['Ligne_stat', 'ligne_stat_ligne_stat'],
  // Companion "_id" column: the linked Derat Tahiti record's own Identifier, not just its display
  // name -- lets consumers match the exact record instead of re-deriving it from the name.
  ['Ligne_stat_Id', 'ligne_stat_ligne_stat_id'],
  ['Conso_Ligne', 'conso_ligne'],
  // 'Vallee' added 2026-09-02 (Select, Source: Templates -> Vallee -- the same 3-option reference
  // template Habitat Restoration's own Valley field uses, column 'valle1_vallee' there) after a
  // real submission picked the wrong Derat Tahiti station (Station_Id resolved to Maruapo's "E4"
  // instead of the intended Hopa's "E4" -- station codes collide across valleys and the picker
  // shows no valley context to disambiguate). An explicit, unambiguous 3-option valley field is
  // far less error-prone than picking the right duplicate-coded station, so consumers should
  // prefer this over Station_Id/Ligne_stat_Id-derived valley when present. Column name confirmed
  // via a debug run (2026-09-02): 'vallee_vallee', matching the guessed
  // "{question}_{linked field}" convention from Ligne_stat/Station above.
  ['Vallee', 'vallee_vallee'],
];

const DERATISATION_CHECKS_MAP = [
  ['Identifier', 'survey_id'],
  ['Date', 'date'],
  ['Observer', 'observer'],
  ['Zone', 'zone'],
  ['Passage', 'passage'],
  ['Derat', 'derat'],
  ['Conso', 'conso'],
  // 'Station' question added 2026-09-01 (Select, Source: Templates -> Derat Tahiti), replacing
  // free-text 'Derat' as the intended way to pick a station going forward. Real column name
  // confirmed via a debug run (2026-09-02): Metabase names a Templates-sourced Select's column
  // "{section}_{question}_{linked field}", not just the question name -- 'checks_station_station',
  // not the originally guessed 'station'.
  ['Station', 'checks_station_station'],
  // Companion "_id" column: the linked Derat Tahiti record's own Identifier for this exact station
  // pick. Station *codes* collide across valleys (e.g. "E4" exists in Maruapo, Hopa and Papehue
  // alike), and this app's old valley-from-Zone-prefix heuristic breaks whenever Zone doesn't
  // follow the "Valley-Letter" convention (free text, no validation -- confirmed 2026-09-02 with a
  // real submission using Zone "HK"). Matching on this id instead sidesteps both problems entirely.
  ['Station_Id', 'checks_station_station_id'],
];

const HISTORICAL_MANAGEMENT_UNITS_MAP = [
  ['Identifier', 'survey_id'],
  ['Nom', 'nom'],
  ['Valley', 'valley'],
  ['Site', 'site'],
  ['Date', 'date'],
  ['Superficie_2D', 'superficie_2d'],
  ['Superficie_3D', 'superficie_3d'],
  ['Vegetation', 'vegetation'],
  ['Gestion_Sous_Bois', 'gestion_sous_bois'],
  ['Plantations', 'plantations'],
];

async function main() {
  const mu = await queryTable(6980, 'Management Unit');
  const dt = await queryTable(6982, 'Derat Tahiti');
  const es = await queryTable(6997, 'Espece');
  const dr = await queryTable(6981, 'Deratisation');
  const dc = await queryTable(8446, 'Dératisation Checks', ['survey_id', 'derat']);
  const hist = await queryTable(9447, 'Historical Management Units');
  // 2026-08-25: Marco removed the "% cleaned at the end of the day" / "% cleaned at arrival" /
  // "% evaluation" questions from the NRDS "Habitat Restoration" template (see
  // habitatrestorationchangelog.md) — the underlying Postgres columns are gone, but Metabase's
  // own table-metadata cache still lists them (needs an admin schema resync to update, which
  // this API key can't do — confirmed via a live 403 on POST /api/database/2/sync_schema).
  // Excluding them here keeps the sync working without waiting on that resync.
  const hr = await queryTable(6995, 'Habitat Restoration', ['survey_id'],
    ['surface_that_has_been_cleaned_', '_cleaned_at_arrival', '_evaluation']);

  await writeJson('data/management_unit.json', mapRows(mu, MANAGEMENT_UNIT_MAP));
  await writeJson('data/derat_tahiti.json', mapRows(dt, DERAT_TAHITI_MAP));
  await writeJson('data/espece.json', mapRows(es, ESPECE_MAP));

  await writeJson('data/live/deratisation.json', mapRows(dr, DERATISATION_MAP));
  await writeJson('data/live/deratisation_checks.json', mapRows(dc, DERATISATION_CHECKS_MAP));
  await writeJson('data/live/historical_management_units.json', mapRows(hist, HISTORICAL_MANAGEMENT_UNITS_MAP));

  // Habitat Restoration's Metabase columns are known to be truncated/mangled by NRDS's own
  // sync (e.g. esp_ce_esp_ce_name, pr_cision_localisation_rat_st, _cleaned_at_arrival) — see
  // data/live/README.md. Passed through with raw column names rather than guessed renames.
  await writeJson('data/live/habitat_restoration.json', mapRows(hr, hr.cols.map((c) => [c, c])));

  // Habitat Restoration Espèce (table 9727, HABITAT_ESPECE_MAP above) — the real one-row-per-
  // species source, fixed 2026-09-19 after two false starts (see data/live/README.md for the
  // full history: upstream gap confirmed by Sam Aruch -> exact table id given -> a first regex-
  // based column guess silently picked the wrong columns and briefly overwrote good data,
  // reverted -> real columns verified via a live sample row -> mapping hardcoded above). Only
  // written when the query succeeds with at least one real Espèce value, so a transient failure
  // or a future schema change can't silently blank out data/live/habitat_restoration_espece.json.
  try {
    const se = await queryTable(9727, 'Habitat Restoration Espèce');
    const mapped = mapRows(se, HABITAT_ESPECE_MAP).filter((r) => r['Espèce'] && r['Espèce'] !== ' | | ');
    if (mapped.length > 0) {
      await writeJson('data/live/habitat_restoration_espece.json', mapped);
      console.log('Habitat Restoration Espèce (table 9727): using it as the full per-action species source.');
    } else {
      console.log('Habitat Restoration Espèce (table 9727) returned no usable rows — leaving data/live/habitat_restoration_espece.json untouched.');
    }
  } catch (e) {
    console.warn('Habitat Restoration Espèce (table 9727) query failed (non-fatal, rest of the sync is unaffected):', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

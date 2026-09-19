// Fallback path for data/live/habitat_restoration.json when the NRDS -> Metabase replication
// for this one table stalls, as it did 2026-08-25 to (at least) 2026-08-28: three new Maruapo
// CUTTING rows (Maruapo-VA/VB/VD, logged 2026-08-27) were already visible in NRDS's own "Habitat
// Restoration" Excel export but never showed up in Metabase, while every other synced table kept
// updating fine via sync-metabase.mjs. Same class of issue documented there (a template edit
// breaking Metabase's schema/replication for this template) — fixing it properly needs Sam Aruch
// (Metabase admin) to resync, which this script sidesteps for a quick top-up in the meantime.
//
// Usage: node scripts/import-habitat-excel.mjs "path/to/Habitat Restoration (n).xlsx"
//   (Download it from app.nrds.io: the "Habitat Restoration" template's own Export > Excel.)
//
// Merges by Identifier (survey_id) into the existing data/live/habitat_restoration.json —
// Excel rows overwrite matching ids and add new ones, everything else already in the file is
// left alone, so a partial/filtered export can't delete rows Metabase already has. Output shape
// matches Metabase's own raw passthrough exactly (see nrdsRowToHabitatRow() in index.html) so
// the app itself needs zero changes to read data topped up this way.
//
// ALSO writes the full one-row-per-species breakdown (every species/count on each action, not
// just the first) to data/live/habitat_restoration_espece.json, merged the same way (by
// Identifier — an action reappearing in this Excel export has ALL of its species rows replaced
// by the fresh ones; actions not in this export are left untouched). This is the actual fix for
// the "only the first species shows up" bug (2026-09-18): the main Habitat Restoration table
// (both via Metabase and via this Excel export) only ever carries ONE species per action in its
// own esp_ce_* columns — kept here for backward-compat/display only — but the Excel export's own
// separate "Espèce" sheet DOES have every species as its own row (same shape as the old
// Section - Espèce.csv), and that sheet is what this script now reads in full instead of taking
// just its first match per Identifier. index.html's fetchHabitatRestoration() reads this file
// and prefers it over the single-species esp_ce_* fallback for any Identifier it covers.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import XLSX from 'xlsx';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_PATH = path.join(ROOT, 'data/live/habitat_restoration.json');
const SPECIES_OUT_PATH = path.join(ROOT, 'data/live/habitat_restoration_espece.json');

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error('Usage: node scripts/import-habitat-excel.mjs "path/to/Habitat Restoration.xlsx"');
  process.exit(1);
}

// SheetJS's cellDates:true hands back a Date built from the cell's naive (timezone-less) date
// serial as if it were UTC — reading it back with local getters shifts the calendar day by
// however far the machine's local zone sits from UTC (verified: this machine is UTC-10, and
// local getters turned an Aug-27 cell into Aug-26). Always read with the UTC getters instead.
function toIsoDate(v) {
  if (v == null || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (!isFinite(d)) return '';
  // Match Metabase's own no-milliseconds format exactly (e.g. "2026-08-27T00:00:00Z") so rows
  // untouched by a given import keep a byte-identical date string and don't show up as noise
  // in the git diff.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().replace('.000Z', 'Z');
}

// The Excel export folds a select field's secondary tag into the same cell, e.g. "MBJ | moitie"
// for Unit Name — same "Name | Common | Type" convention as the Espèce column. First segment is
// the zone code (unit_name_nom); second, when present, is the zone's sous-bois stage at the time
// of the action (unit_name_sb_2025 in Metabase's raw shape — unused by the app today, but kept
// for parity rather than silently dropped).
function segments(v) {
  const [first = '', second = ''] = String(v ?? '').split('|').map((s) => s.trim());
  return [first, second];
}

async function main() {
  // XLSX.readFile() relies on this library's own Node `fs` auto-detection, which doesn't kick
  // in reliably under Node's ESM loader — read the bytes ourselves and hand them to XLSX.read()
  // instead, which has no such dependency.
  const buf = await readFile(xlsxPath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const mainSheetName = wb.SheetNames.find((n) => /habitat restoration/i.test(n)) || wb.SheetNames[0];
  const speciesSheetName = wb.SheetNames.find((n) => /esp.ce/i.test(n));
  const mainRows = XLSX.utils.sheet_to_json(wb.Sheets[mainSheetName], { defval: '' });
  const speciesRows = speciesSheetName ? XLSX.utils.sheet_to_json(wb.Sheets[speciesSheetName], { defval: '' }) : [];

  // Every species row for a given action, not just the first — the actual fix (see comment
  // above the file's header).
  const speciesByIdent = new Map();
  for (const sr of speciesRows) {
    const ident = String(sr['Identifier'] ?? '');
    const raw = String(sr['Espèce'] ?? '').trim();
    if (!ident || !raw) continue;
    if (!speciesByIdent.has(ident)) speciesByIdent.set(ident, []);
    const [name = '', common = '', type = ''] = raw.split('|').map((s) => s.trim());
    speciesByIdent.get(ident).push({ name, common, type, number: sr['Number'] ?? '' });
  }
  // First species per action only, for the main row's own esp_ce_* columns — matches what
  // Metabase's parent table shape can hold (at most one), kept for backward-compat display only.
  // The full breakdown for every action goes into data/live/habitat_restoration_espece.json below.
  const firstSpeciesByIdent = new Map([...speciesByIdent].map(([id, list]) => [id, list[0]]));

  let existing = [];
  try {
    existing = JSON.parse(await readFile(OUT_PATH, 'utf-8'));
  } catch (e) {
    console.warn(`Could not read existing ${path.relative(ROOT, OUT_PATH)} (${e.message}) — starting from an empty file.`);
  }
  const bySurveyId = new Map(existing.map((r) => [String(r.survey_id), r]));

  let added = 0, updated = 0;
  for (const r of mainRows) {
    const surveyId = String(r['Identifier'] ?? '');
    if (!surveyId) continue;
    const sp = firstSpeciesByIdent.get(surveyId);
    const [unitNom, unitSb2025] = segments(r['Unit Name']);
    const row = {
      template_id: '', survey_id: isFinite(+surveyId) ? +surveyId : surveyId, tag: '',
      date: toIsoDate(r['Date']), name: r['Name'] || '',
      type_of_day_work: r['Type of day work'] || '', number_of_person: r['Number of Person'] ?? '',
      action: r['Action'] || '', valle1_vallee_id: '', valle1_vallee: r['Valley'] || '',
      rat_line_ligne_stat_id: '', rat_line_ligne_stat: r['Rat line'] || '', cleaned: r['Cleaned'] || '',
      unit_name_nom_id: '', unit_name_nom: unitNom,
      unit_name_sb_2025_id: '', unit_name_sb_2025: unitSb2025,
      pr_cision_localisation_rat_st: r['Précision Localisation (rat station name)'] || '',
      number_of_hours: r['Number of hours'] ?? '', comment: r['Comment'] || '',
      esp_ce_esp_ce_common_name_id: '', esp_ce_esp_ce_common_name: sp?.common || '',
      esp_ce_esp_ce_name_id: '', esp_ce_esp_ce_name: sp?.name || '',
      esp_ce_esp_ce_type: sp?.type || '', esp_ce_number: sp?.number ?? '',
      survey_url: '', added: '', added_by: '', added_by_id: '', team_id: '', team: '',
    };
    if (bySurveyId.has(surveyId)) updated++; else added++;
    bySurveyId.set(surveyId, row);
  }

  const merged = [...bySurveyId.values()].sort((a, b) => (+a.survey_id || 0) - (+b.survey_id || 0));
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(merged), 'utf-8');
  console.log(`Merged ${mainRows.length} row(s) from Excel (${added} new, ${updated} updated) into ${path.relative(ROOT, OUT_PATH)} — ${merged.length} rows total.`);

  // Full per-species breakdown: identifiers present in THIS Excel export have all of their
  // existing species rows replaced by the fresh ones (an action's species list can shrink, e.g.
  // a data-entry fix on NRDS, and a stale extra row must not linger); identifiers absent from
  // this export (not re-exported this time) are left exactly as they already were.
  let existingSpecies = [];
  try {
    existingSpecies = JSON.parse(await readFile(SPECIES_OUT_PATH, 'utf-8'));
  } catch (e) {
    console.warn(`Could not read existing ${path.relative(ROOT, SPECIES_OUT_PATH)} (${e.message}) — starting from an empty file.`);
  }
  const identsInThisExport = new Set([...speciesByIdent.keys()]);
  const keptExisting = existingSpecies.filter((r) => !identsInThisExport.has(String(r.Identifier)));
  const freshSpecies = [...speciesByIdent.entries()].flatMap(([ident, list]) =>
    list.map((sp) => ({ Identifier: isFinite(+ident) ? +ident : ident, 'Espèce': [sp.name, sp.common, sp.type].join(' | '), Number: sp.number }))
  );
  const mergedSpecies = [...keptExisting, ...freshSpecies].sort((a, b) => (+a.Identifier || 0) - (+b.Identifier || 0));
  await writeFile(SPECIES_OUT_PATH, JSON.stringify(mergedSpecies), 'utf-8');
  console.log(`Merged species for ${identsInThisExport.size} action(s) from Excel into ${path.relative(ROOT, SPECIES_OUT_PATH)} — ${mergedSpecies.length} species row(s) total.`);
  console.log('Remember to commit and push data/live/habitat_restoration*.json for the change to reach the deployed app.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

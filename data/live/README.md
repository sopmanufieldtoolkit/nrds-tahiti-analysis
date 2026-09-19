Raw automated sync from Metabase (`metabase.nrds.io`), refreshed periodically by
`.github/workflows/sync-metabase.yml` / `scripts/sync-metabase.mjs`. Not yet read by the
app itself — these files exist so the current official-NRDS data is available for future
features (e.g. comparing against what's entered locally in this app).

**2026-08-30 — sync cadence is driven by an external cron, not GitHub's own `schedule:` trigger.**
GitHub's `schedule:` trigger for this workflow was found to be unreliable in practice — even with
the earlier :00/:15/:30/:45-offset fix, real runs (checked via the Actions API) were 2-5.5h apart,
not the intended 15min; this is a documented GitHub Actions platform limitation for sub-hourly
schedules, not something fixable by tweaking the cron string further. `schedule:` was removed from
the workflow entirely — only `workflow_dispatch` remains. Cadence is now driven by a free
**cron-job.org** job (set up outside this repo, in Marco's own cron-job.org account) that calls,
every 1h (changed 2026-08-31 from the original ~14min — the tighter cadence wasn't needed for
this kind of field data and was burning Actions minutes unnecessarily):
```
POST https://api.github.com/repos/sopmanufieldtoolkit/nrds-tahiti-analysis/actions/workflows/sync-metabase.yml/dispatches
Headers: Authorization: Bearer <fine-grained PAT, this repo only, Actions: Read and write, no other scopes>
         Accept: application/vnd.github+json
Body:    {"ref":"main"}
```
If the data ever looks stale again, check (in order): (1) is the cron-job.org job still enabled/not
expired (free accounts can require periodic re-confirmation), (2) has the PAT expired or been
revoked, (3) only then suspect the workflow/script itself (check the Actions tab for a red run).

Column names for `deratisation.json`, `deratisation_checks.json`, and
`historical_management_units.json` were cleaned up and cross-checked against known values.

`habitat_restoration.json` keeps Metabase's raw, unmodified column names
(e.g. `esp_ce_esp_ce_name`, `pr_cision_localisation_rat_st`, `_cleaned_at_arrival`). NRDS's
own sync into Metabase truncates/mangles some column names for this table, and at least one
other table (`Espece`) was found to have two columns silently swapped by that sync — verify
a given column's real meaning against actual values (or the original
`Habitat Restoration.csv` export) before building anything on top of it.

**2026-09-18 — `habitat_restoration_espece.json`: only-first-species-shown bug found and fixed.**
`habitat_restoration.json`'s own `esp_ce_*` columns hold at most ONE species per action —
Metabase's "Habitat Restoration Espèce" child table (the real one-row-per-species join,
equivalent to the old CSV era's `Section - Espèce.csv`) has synced completely empty from NRDS
every time it's been checked (2026-08-05 through at least 2026-09-18). Concretely: a real action
logged 2026-09-17 with 3 species (1 Mara, 2 Apape, 2 Ochrosia) only showed "1 Mara" in the app.
Fixed with a new file, `habitat_restoration_espece.json` (one row per species per action, same
`{Identifier, Espèce, Number}` shape as `tables.sectionEspece` elsewhere), which `index.html`'s
`_applyHabitatDataFromNrds()` now reads and prefers over the single-species `esp_ce_*` fallback
for any Identifier it covers. Two writers, both safe to no-op:
- `scripts/sync-metabase.mjs` looks up the Espèce child table by name each run and writes this
  file ONLY if Metabase ever actually returns real rows (self-healing if NRDS fixes the
  replication gap upstream) — an empty/missing table is logged and otherwise ignored, never
  overwrites this file with nothing.
- `scripts/import-habitat-excel.mjs` (manual fallback — download the "Habitat Restoration"
  template's Excel export from app.nrds.io, run the script) reads its real, already-complete
  "Espèce" sheet in full and merges by Identifier — this is the actual reliable source today,
  since the Metabase table isn't populated. Re-run it whenever a multi-species action looks
  wrong in the app; there's no automatic trigger for this path.

**2026-08-25 — NRDS template edit broke the sync, fixed without needing admin access.** Marco
edited the "Habitat Restoration" template on Kilo (see `habitatrestorationchangelog.md`,
sent to him by browser-Claude): removed 3 questions (`% cleaned at the end of the day` /
`% cleaned at arrival` / `% evaluation` — the columns behind `surface_that_has_been_cleaned_` /
`_cleaned_at_arrival` / `_evaluation`), added a new `number_of_hours` question, and renamed the
`action` option labels from French descriptive text to short codes (`CUTTING` / `MAINTENANCE` /
`PLANTATION`, retroactive for all historical rows too — NRDS stores the option by ID, not text).
Metabase's own table-metadata cache still listed the 3 removed columns (schema resync needed to
notice they're gone, which is an admin-only Metabase action — confirmed via a live 403 on
`POST /api/database/2/sync_schema` with the "tahiti" API key, `is_superuser: false`), so every
sync run failed with `column habitat_restoration.surface_that_has_been_cleaned_ does not exist`
— and since `queryTable()` used to just query "all fields Metabase knows about" implicitly, this
one broken column blocked the *entire* sync (nothing in `data/*.json` got refreshed at all, not
just this table, since main() only writes files after every `queryTable()` call succeeds).
**Fixed in `scripts/sync-metabase.mjs` without needing that admin resync**: `queryTable()` now
builds an explicit `fields` list from live table metadata and take an `excludeFields` param — the
Habitat Restoration call passes the 3 dead column names there, so the query never asks for them.
`index.html`'s `Action` comparisons (`CUTTING_ACTION` and the hardcoded French-label strings
throughout) were updated to the new short codes; `nrdsRowToHabitatRow()` was updated to stop
reading the 3 removed columns (harmless — they're just absent from `r` now, existing `?? ''` /
`|| ''` fallbacks already treat that as "no data" everywhere downstream) and to pass through the
new `number_of_hours` as `Number_of_Hours` (not consumed by any UI feature yet, same
staged-for-later pattern as everything else in this folder). **Consequence going forward**: NRDS
no longer collects a cleaning % for new CUTTING/MAINTENANCE entries at all (replaced by hours
worked) — every feature that reads `Pct_cleaned_arrival`/`Pct_cleaned_end_of_day` (map cleaning
layer, combined estimate, dashboard headline stat, etc.) will correctly show "no data" for any
post-2026-08-25 session, same as it already does for any older row missing that field — not a bug,
just an honest reflection of what NRDS collects now. If Marco ever wants a UI built around
`number_of_hours` as a replacement metric, that's a real design decision (what should "combined
estimate" mean when the underlying metric changed from a % to a headcount×hours figure) — don't
improvise one without asking.

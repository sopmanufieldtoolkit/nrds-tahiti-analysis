-- PFF (Little Fire Ant) épandage / treatment areas drawn via "Add Elements" → "New épandage area"
-- (Marco, 2026-09-29). Shown on the map under the PFF layer → "Shows épandage areas", each with a
-- popup (area, creation date, shapefile download). The first area (Zone S metho main 2, from
-- "NRDS work/pff area/S-métho.*") is embedded in index.html itself, not stored here.
--
-- geometry: GeoJSON Polygon, WGS84, [lon, lat], ring closed (first point repeated at the end).
-- Run once in the Supabase SQL editor.

create table if not exists public.pff_epandage_areas (
  id bigint generated always as identity primary key,
  name text not null,
  geometry jsonb not null,
  area_m2 numeric,
  created_at timestamptz not null default now()
);

alter table public.pff_epandage_areas enable row level security;

drop policy if exists "pff_epandage_areas public read" on public.pff_epandage_areas;
create policy "pff_epandage_areas public read"
  on public.pff_epandage_areas for select to anon using (true);

drop policy if exists "pff_epandage_areas public insert" on public.pff_epandage_areas;
create policy "pff_epandage_areas public insert"
  on public.pff_epandage_areas for insert to anon with check (true);

-- From 2026-10-30 Supabase no longer auto-grants Data API access to new public tables: the GRANT must
-- match exactly what the policies above allow (select + insert, no update/delete).
-- (no sequence grant needed: identity columns don't require USAGE on their sequence.)
grant select, insert on public.pff_epandage_areas to anon;

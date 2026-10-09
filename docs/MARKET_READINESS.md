# Market readiness review — civil engineering offices

An objective assessment of whether llull can be sold to, and used day to day by, civil engineering
firms. Reviewed 2026-10-09.

## Verdict

**Before this review: not sellable to civil engineers.** The building (BIM) and industrial-steel
workspaces were deep — walls to IFC4, portal frames with Eurocode-style checks, footings, takeoff —
but a civil engineer's daily work (survey → terrain → earthworks → roads → drainage) was absent:
no survey import, no terrain, no volumes, no alignments, no drainage, no LandXML, and no way to
open the DXF drawings every civil project starts from.

**After this review: sellable as a focused product to small and mid-size site / civil offices, and technically credible for road and drainage design offices**
(site development, platforms and access roads, storm drainage, early design and tender
quantities), and to firms that want AI agents to drive design through MCP. It is **not yet** a
replacement for Civil 3D / 12d on large highway or utility projects, and it has not yet been
validated by a pilot customer (see gaps).

## What a civil office can now do in llull

| Job                                   | Status | Commands |
| ------------------------------------- | ------ | -------- |
| Import a survey (CSV/TXT, DXF)        | Ready  | `import_survey_points`, `import_survey_dxf` |
| Open a client DXF background          | Ready  | `import_dxf` |
| Existing-ground model + contours      | Ready  | `create_surface`, `surface_report`, `surface_elevation` |
| Platform cut / fill, balance level    | Ready  | `add_platform`, `platform_earthworks`, `balance_platform` |
| Surface-to-surface volumes            | Ready  | `compare_surfaces` |
| Access road: alignment, profile, template, volumes, mass haul | Ready (spirals, superelevation) | `add_alignment`, `set_alignment_profile`, `set_road_section`, `alignment_report` |
| Long section and cross-section sheets | Ready (SVG) | `export_long_section`, `export_cross_sections` |
| Storm network design and check        | Ready (Tc / IDF, HGL, surcharge) | `add_manhole`, `add_pipe`, `check_drainage_network`, `size_drainage_pipes`, `drainage_schedule` |
| Exchange with Civil 3D / 12d / TBC    | Ready  | `export_landxml`, `export_civil_dxf` |
| Buildings on the site (BIM, IFC4)     | Ready  | building workspace ([`CONSTRUCTION.md`](CONSTRUCTION.md)) |
| Steel halls, footings, checks         | Ready  | industrial workspace ([`INDUSTRIAL.md`](INDUSTRIAL.md)) |
| AI agent drives the whole workflow    | Ready  | MCP toolset `civil`, prompt `design_site` |

Quality evidence: every capability is a pure command with unit tests (survey parsing, Delaunay
invariants, analytic volumes within 2 %, Manning / rational method against hand calculations,
alignment and vertical-curve geometry), a golden `build_project` plan replayed to identical
geometry, save / load round trips, and the repository's coverage gate (≥ 90 / 85 / 90 / 90).

## Second pass (same day): blockers closed in code

| Former gap | Now |
| ---------- | --- |
| DWG | `POST /import/dwg` + MCP `import_dwg` via LibreDWG / ODA File Converter on the server (503 with install steps when absent) |
| Highway geometry | clothoid spirals, superelevation runoff / runout, spiral-length and e-demand checks, LandXML spirals |
| Coordinate systems | CRS metadata, Helmert site calibration, grid-coordinate import / export |
| Civil drawings | true-scale civil plan sheets and plan-profile sheets with title block |
| Drainage depth | time of concentration, IDF curves, iterated sizing, HGL with surcharge / flooding, drainage long sections |

## Gaps that still limit sales (priority order)

1. **Validation with real users** — no pilot customer has used it yet; the next step is a pilot with
   two or three site-development offices, measuring time to first deliverable and collecting their
   national-standard presets (design speed tables, IDF curves, pipe catalogues).
2. **Commercial readiness** — user accounts, licensing / billing, multi-user permissions, per-user
   audit trail; engineering checks must still be signed by a qualified engineer.
3. **Native DWG without a server converter**, true projection transforms (EPSG library), lane
   widenings / intersections, breakline-enforced TINs, foul-water design.

## Gaps listed after the first pass (closed by the second pass; kept for history)


1. **DWG** — only ASCII DXF is read and written. Most clients send DWG; a DWG reader (e.g. a
   server-side ODA / LibreDWG converter) is the single biggest adoption barrier left.
2. **Highway geometry** — no clothoid spirals, superelevation runs, multiple templates / lane
   widenings, or intersections. Required for any public road design.
3. **Coordinate reference systems** — no CRS / projection metadata or transforms (Lambert, UTM,
   national grids); survey coordinates are taken as-is.
4. **Drawing production for civil** — long / cross sections are SVG; no civil plan sheets with
   title blocks, viewports and plotting styles (the building plan sheets exist).
5. **Drainage depth** — no hydraulic grade line, time-of-concentration iteration, IDF curves,
   foul / sanitary design, or national code presets.
6. **Terrain depth** — breaklines are not enforced, no point clouds, no surface editing (swap edge,
   delete triangle).
7. **Commercial readiness** — no user accounts / licensing / billing, multi-user permissions, audit
   trail per user, or certified validation of the engineering checks; checks must be stamped by a
   qualified engineer (the tools say so).

## Recommended next steps

1. DWG import / export via a server-side converter (keeps the core pure).
2. Spirals + superelevation in `alignmentGeometry` / `roadSection` (same command surface).
3. CRS metadata on the document and LandXML `CoordinateSystem` output.
4. Civil plan / profile sheets reusing the building sheet engine.
5. Pilot with two or three site-development offices; measure time-to-first-deliverable.

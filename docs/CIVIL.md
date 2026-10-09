# Civil / site engineering guide

llull's civil workspace covers the site work of a civil engineering office: from the topographic
survey to the earthworks, the road and the storm drainage, and the exchange files a contractor or a
Civil 3D / 12d user expects. Like everything in llull, each step is a command: the **Civil / Site**
panel and MCP agents (toolset `civil`, prompt `design_site`) use the same ones.

## Model

| Object      | Created by                                                                       | Generates (layers, NCS)                                          |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Point group | `import_survey_points`, `import_survey_dxf`                                      | point markers (`C-TOPO-PNTS`, up to 2000 points drawn)           |
| Surface     | `create_surface`, `update_surface`                                               | TIN mesh (`C-TOPO-TINN`), minor / major contours, labels         |
| Platform    | `add_platform`, `update_platform`, `balance_platform`                            | pad, outline, cut / fill batters, daylight line (`C-GRAD`)       |
| Alignment   | `add_alignment`, `update_alignment`, `set_alignment_profile`, `set_road_section` | centreline, stations, curve data, corridor + batters (`C-ROAD*`) |
| Manhole     | `add_manhole`, `update_manhole`                                                  | chamber, plan symbol, label (`C-STRM-STRC`)                      |
| Pipe        | `add_pipe`, `update_pipe`, `size_drainage_pipes`                                 | pipe barrel, plan line, "Ø300 PVC 1.00 %" label (`C-STRM-PIPE`)  |

The civil model (`CadDocument.civil`) is the source of truth; generated entities are read-only
(edit the object, or `delete_civil_object` — `cascade: true` also removes dependents) and are
re-derived when a file is opened. Lengths are stored in the document unit; reports are in metres,
m², m³, L/s. Work in metres (`set_units { units: 'm' }`) for real survey coordinates.

## Workflow

1. **Survey** — `import_survey_points { text, format: PENZD|PNEZD|PENZ|PNEZ|ENZ|NEZ, sourceUnit }`
   reads total-station / GNSS exports (header and `#` lines skipped, bad lines reported).
   `import_survey_dxf` extracts POINTs, 3D polyline / contour vertices, 3DFACE corners and numeric
   spot-height texts from a topographic DXF (filter by layer). `import_dxf` brings any ASCII DXF in
   as an editable background drawing (layers, blocks exploded, bulges, MTEXT).
2. **Terrain** — `create_surface` builds a Delaunay TIN (boundary clip, max edge length for concave
   sites) with contours; `surface_report` (area, elevation range, mean slope) and
   `surface_elevation` (spot levels and slopes) query it.
3. **Earthworks** — `add_platform` grades a pad into the terrain with cut / fill batters (H:V) and
   reports cut, fill and net volumes (grid method including the batters, daylight computed);
   `balance_platform` finds the level where cut × swell = fill; `compare_surfaces` gives the volumes
   between two surfaces (e.g. existing vs. design ground).
4. **Roads** — `add_alignment` (PIs + circular curve radii), `set_alignment_profile` (PVIs with
   parabolic vertical curves; grades and K values reported), `set_road_section` (lanes, shoulders,
   crossfall, batters). `alignment_report` lists every station (ground, design, cut / fill depth,
   section areas, cumulative volumes by average end areas, mass haul, CSV) and, with
   `designSpeedKmh`, checks minimum radii and K values. `export_long_section` and
   `export_cross_sections` draw the long section (with data band) and the cross-section sheet (SVG).
5. **Drainage** — `add_manhole` (rim from the surface when omitted, catchment area + runoff
   coefficient, point inflow) and `add_pipe` (inverts default to the manholes; cycles refused).
   `check_drainage_network` accumulates rational-method flows downstream (Q = C·i·A / 360) and
   checks each pipe: Manning full-bore capacity, part-full depth and velocity, self-cleansing and
   maximum velocity, cover, depth ratio. `size_drainage_pipes` picks the smallest commercial
   diameter that passes; `drainage_schedule` exports the manhole and pipe schedules (CSV).
6. **Deliverables** — `export_landxml` (LandXML 1.2: CgPoints, TIN surfaces, alignments with
   Line / Curve geometry and the design profile, storm pipe network) for Civil 3D, 12d, Trimble
   Business Center, OpenRoads; `export_civil_dxf` (points, contours at their elevation, labels,
   TIN / corridor / pad meshes as 3DFACEs).

## DWG import (via the server)

DWG is proprietary, so llull converts it to ASCII DXF on the server (core stays pure) and then runs
`import_dxf` / `import_survey_dxf` through the normal command path (live document, undo, live sync).
Install one converter on the server host:

- **LibreDWG** (free): `apt install libredwg-tools` (provides `dwg2dxf`). `LLULL_DWG2DXF=<path>`
  overrides the executable, `off` disables it.
- **ODA File Converter**: set `LLULL_ODA_CONVERTER=<executable>`; run as
  `<exe> in-dir out-dir ACAD2018 DXF 0 1 *.DWG` (used when `dwg2dxf` is missing).

`LLULL_DWG_TIMEOUT_MS` (default 60000) and `LLULL_DWG_MAX_BYTES` (default 50 MB) bound each
conversion; every request uses a private temp dir that is always removed.

- HTTP: `POST /import/dwg?target=drawing|survey&sourceUnit=m&layers=A,B` with the raw bytes
  (`application/octet-stream`) or JSON `{ "base64": "...", "target": "survey", "name": "..." }`.
  400 not a DWG (`AC10xx` header), 413 too large, 503 no converter installed, 504 timeout.
- MCP: `import_dwg { dwgBase64 | path, target, sourceUnit, layers, ... }` (toolset `exchange`).
- UI: Civil / Site panel › DWG file inputs (needs the server).

## Engineering assumptions (state them in your reports)

- Earthwork volumes: grid method (cell size chosen for ≥ ~2500 cells on the pad), batter cut / fill
  decided by the ground relative to pad level; no bulking except `swellFactor` in balancing.
- Road volumes: average end areas between computed sections; mass haul without bulking. Design
  speed checks use R_min = V² / (127 (e + f)) with e = 7 % and AASHTO-style side friction, and AASHTO-style
  tabulated minimum K values — check against your national standard.
- Drainage: Manning with a user n (default 0.013), full-bore and part-full circular sections,
  rational method with a single design intensity (no time-of-concentration iteration); pipe sizing
  is per pipe at its current slope (downstream pipes are not forced larger than upstream ones).
- These are design aids for a qualified engineer, not a substitute for one.

## Design depth added after the first review

- **Roads** — clothoid transition spirals per curve (`spirals` on `add_alignment` /
  `update_alignment`, TS / SC / CS / ST, exact Fresnel series; refused when Δ < 2θs) and
  superelevation (`set_superelevation { maxRate, runoffLength? }`: crown runout, runoff through the
  spiral, full rate on the circle, applied to the corridor, sections, volumes and
  `alignment_report`). Design checks add the minimum spiral length Ls ≥ V³ / (46.656 C R), C = 0.6
  m/s³, and the superelevation demand against `maxRate`. LandXML writes `<Spiral spiType="clothoid">`.
- **Drainage** — modified rational method: per-manhole `entryTimeMin`, time of concentration along
  every upstream path, IDF curve `idf { a, b, c }` (i = a / (t + b)^c), sizing iterated to
  convergence, flows split at diverging manholes by full-bore capacity share. Hydraulic grade line
  from the outfall (`outfallLevel`, friction slope, manhole losses `manholeLossK`), surcharge and
  flooding flags (`freeboardM`), and `export_drainage_long_section` (SVG with HGL and data band).
- **Coordinates** — `set_coordinate_system { name, epsg?, verticalDatum? }`,
  `set_site_calibration` (2D Helmert: grid = gridOrigin + k·R(θ)·(local − localOrigin)),
  `transform_coordinates`; survey import in grid coordinates; LandXML (`<CoordinateSystem>`) and
  civil DXF export in grid coordinates when calibrated.
- **Sheets** — `export_civil_plan_sheet { paper, scale }` (true-scale plan with title block, north
  arrow, scale bar, legend, grid ticks) and `export_plan_profile_sheet { alignmentId }` (station-
  aligned plan strip over the long section). Print the SVG to PDF at 100 %.

## Known limits

- One symmetric road template per alignment; no lane widenings, intersections or 3D breakline
  editing; the plan-profile sheet's plan strip is straightened along the alignment.
- Breaklines are not enforced in the TIN (they contribute vertices only); TIN meshes are not drawn
  on plan sheets (contours are).
- No foul-water design; storm pipes only in LandXML. LandXML pipe `slope` is written as a ratio
  (0.01 = 1 %) — check against your target software.
- Site calibration is a 2D similarity transform (no projection library): use the calibration your
  surveyor provides for the national grid.
- DWG needs the server with LibreDWG (`dwg2dxf`) or the ODA File Converter installed.

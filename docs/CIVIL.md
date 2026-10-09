# Civil / site engineering guide

llull's civil workspace covers the site work of a civil engineering office: from the topographic
survey to the earthworks, the road and the storm drainage, and the exchange files a contractor or a
Civil 3D / 12d user expects. Like everything in llull, each step is a command: the **Civil / Site**
panel and MCP agents (toolset `civil`, prompt `design_site`) use the same ones.

## Model

| Object      | Created by                                        | Generates (layers, NCS)                                    |
| ----------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Point group | `import_survey_points`, `import_survey_dxf`       | point markers (`C-TOPO-PNTS`, up to 2000 points drawn)     |
| Surface     | `create_surface`, `update_surface`                | TIN mesh (`C-TOPO-TINN`), minor / major contours, labels   |
| Platform    | `add_platform`, `update_platform`, `balance_platform` | pad, outline, cut / fill batters, daylight line (`C-GRAD`) |
| Alignment   | `add_alignment`, `update_alignment`, `set_alignment_profile`, `set_road_section` | centreline, stations, curve data, corridor + batters (`C-ROAD*`) |
| Manhole     | `add_manhole`, `update_manhole`                   | chamber, plan symbol, label (`C-STRM-STRC`)                |
| Pipe        | `add_pipe`, `update_pipe`, `size_drainage_pipes`  | pipe barrel, plan line, "Ø300 PVC 1.00 %" label (`C-STRM-PIPE`) |

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

## Known limits

- No spirals (clothoids) or superelevation transitions in alignments; one symmetric road template.
- Breaklines are not enforced in the TIN (they contribute vertices only).
- No foul-water design, hydraulic grade line or surcharge analysis; storm pipes only in LandXML.
- DWG and binary DXF must be saved as ASCII DXF first.

# Pilot kit — evaluate llull in a civil / site engineering office

This kit lets a civil engineering office decide, on its own and in under an hour, whether llull
can do its site-development work: survey → terrain → earthworks → access road → storm drainage →
drawings and LandXML for the contractor. It is written for the engineer who runs the evaluation;
no one from llull needs to be in the room.

| What                   | Where                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| One-click sample site  | empty app → **Civil site starter**                                                                                     |
| Sample survey (CSV)    | [`public/samples/pilot-site-survey.csv`](../public/samples/pilot-site-survey.csv) — 911 points, PENZD                  |
| Sample survey (DXF)    | [`public/samples/pilot-site-survey.dxf`](../public/samples/pilot-site-survey.dxf) — 3D-polyline contours + spot levels |
| Regenerate the samples | `node scripts/generate-civil-samples.mjs` (deterministic)                                                              |
| Engineering reference  | [`CIVIL.md`](CIVIL.md) — every command, the assumptions and the known limits                                           |
| Automated equivalent   | production gate scenario `civil-site-development` ([`PRODUCTION_GATE.md`](PRODUCTION_GATE.md))                         |
| Feedback               | **Feedback** button in the Civil / Site panel header, or the form at the end of this page                              |

The samples are an analytic hillside on a local site grid (easting 1000–1240 m, northing
5000–5180 m, levels 99.7–113.8 m) with a stream valley along the west side, an existing farm track
(`EP`), trees (`TREE`), stream-bed shots (`STR`) and a 7.5 m topographic grid (`TOPO`).

## Before you start (5 minutes)

- Open the app (your hosted URL, or `npm install && npm run dev` → http://localhost:5173). Chrome,
  Edge or Firefox; nothing to install for CSV / DXF work.
- DWG files need the optional server with a converter (LibreDWG `dwg2dxf` or the ODA File
  Converter) — see [CIVIL.md › DWG import](CIVIL.md#dwg-import-via-the-server). Without it, save
  your DWG as ASCII DXF from your CAD tool.
- Pick **one real, finished job** from your office to compare against: its survey file, the pad
  level and volumes your tool computed, the road layout, and the storm network with the pipe sizes
  you issued. The comparison is what makes the pilot worth doing.
- Feedback goes to the address your llull contact gave you; a build can preset it with
  `VITE_LLULL_FEEDBACK_EMAIL`, otherwise your mail client asks for the recipient.

## Five-minute look: the civil site starter

On the empty app, click **Civil site starter**. In a few seconds llull fetches the sample survey
and runs one `build_project` plan (one undo step): metres, survey import, TIN surface with 0.5 m
contours, a 50 × 40 m building pad balanced with a swell factor of 1.1, a 130 m access road with
clothoid transitions (R 60 m, Ls 40 m), profile, 3 m lanes and 6 % superelevation, and a
four-manhole storm network sized against an IDF curve. The Civil / Site panel lists every object;
use **Fit all into view** if the camera lost the site. Undo removes everything.

## Guided tutorial — your own data (45 minutes)

Work in the **Site** tab (Civil / Site panel), top to bottom. Every button runs a command; the
same commands are in the command palette (Ctrl/Cmd + K) and available to AI agents over MCP.

### 1. Survey (8 min)

1. If the panel says the document is in mm, click **Work in metres**.
2. **Survey file**: pick your total-station / GNSS export (CSV / TXT). Choose the column order
   (**Survey format**: PENZD, PNEZD, PENZ, PNEZ, ENZ, NEZ) and the **Survey unit**, name the group,
   **Import points**. Header and `#` lines are skipped; unreadable lines are listed in the status.
3. Or **Survey DXF file**: contours as 3D polylines, 3D points, 3D faces and spot-level texts
   become points (try `pilot-site-survey.dxf`). **Drawing DXF file** brings a client background
   drawing in as editable entities. DWG: **Survey DWG file** / **Drawing DWG file** (server).
4. Grid coordinates? Set the coordinate system and the site calibration your surveyor provides
   (Coordinate system section) before importing with grid coordinates (`import_survey_points`
   `coordinates: "grid"` in the palette).

Check: point count = rows in your file; codes kept.

### 2. Terrain (5 min)

**Create surface** with your contour interval (and **Maximum triangle edge** for a concave site so
long hull triangles are dropped). The row shows points, triangles and area.

Check: elevation range and plan area against your tool's surface; contours overlay your drawing.

### 3. Pad and balance (7 min)

**Add platform**: outline `x,y; x,y; …` (or draw a closed polyline and **From selection**), a
first-guess level, cut / fill batters (H:1V). Then type the **Swell factor** on the platform row
and **Balance**: llull sets the level where cut × swell = fill.

Check: balanced level, cut and fill volumes against your tool on the same outline and batters.

### 4. Access road (10 min)

1. **Add alignment**: PIs `x,y; x,y; …`, **Curve radii** per interior PI, **Spiral lengths** (clothoid
   each side, 0 = none), the ground surface, station interval.
2. On the alignment row: **Profile PVIs** (`station, elevation[, vertical curve length]` per line,
   first and last PVI at the road ends) → **Set profile**; lane, shoulder, crossfall, batters →
   **Set road section**; **Superelevation** (e.g. 0.06) → **Set superelevation**.
3. Type your **Design speed** and download **Report CSV**: stations, ground / design, cut / fill
   areas, cumulative volumes, mass haul, superelevation, and the design checks (minimum radius,
   spiral length, K values, superelevation demand). The status line says "all checks pass" or lists
   the failures.

Check: curve and spiral geometry (TS / SC / CS / ST stations), earthwork volumes, the check
results against your national standard (llull's tables are AASHTO-style — see CIVIL.md).

### 5. Storm drainage (10 min)

1. **Add manhole**: position, invert, the ground surface (rim = ground), catchment ha and runoff C.
   Add the outfall last.
2. **Add pipe** from / to in flow direction (PVC, n 0.013 by default).
3. Type your IDF curve **IDF a / b / c** (i = a / (t + b)^c mm/h; the constant **Rainfall
   intensity** is used while a, b or c is blank) → **Size pipes** picks the smallest commercial
   diameter per pipe (modified rational method, Tc iterated).
4. Type the receiving-water **Outfall level** → **Check network**: flows, capacity, velocity, cover,
   hydraulic grade line, surcharged pipes and flooding manholes. **Schedule CSV** issues the
   manhole and pipe schedules; `export_drainage_long_section` (palette) draws the HGL long section.

Check: pipe sizes and HGL against your tool with the same IDF, Tc and losses.

### 6. Drawings and exchange (5 min)

- Alignment row: pick the **Sheet paper** and download **Plan-profile sheet** (SVG, print to PDF at
  100 %). Exports section: **Plan sheet** (true-scale civil plan with title block; fill the title
  block in the Building tab › Project), **DXF (civil)**.
- **LandXML**: CgPoints, the TIN surface, alignments (lines, curves, clothoids, profile) and the
  storm network. Import it into Civil 3D (Insert › LandXML), 12d (File › Import › LandXML) or
  Trimble Business Center.
- **Verify the pipe slope convention**: llull writes the LandXML pipe `slope` as a ratio
  (0.01 = 1 %). Some software reads it as a percentage. Open one pipe in your software and compare
  its slope with llull's schedule before you trust any imported network.

## What to verify against your current tool

| Item               | How                                                                             | Pass if                                                                    |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Survey import      | point count and three spot points (number, E, N, Z, code)                       | identical                                                                  |
| Surface            | min / max elevation, plan area, a spot level at three locations                 | ≤ 1 cm on levels, ≤ 0.5 % on area                                          |
| Pad volumes        | same outline, level and batters: cut, fill; then the balanced level             | volumes within 2 %, level within 5 cm                                      |
| Road volumes       | same alignment, profile and template: cumulative cut / fill at the end station  | within 5 % (section method differences)                                    |
| Road geometry      | TS / SC / CS / ST stations, radius, spiral length, K values                     | ≤ 1 cm on stations                                                         |
| Pipe sizes         | same network, catchments, IDF, entry times                                      | identical diameters                                                        |
| HGL                | same tailwater and loss coefficient: HGL at each manhole                        | within 5 cm                                                                |
| LandXML round trip | import llull's LandXML into your software, then re-export and import into llull | opens; surface, alignment, pipes intact; slopes correct (convention above) |

## Success criteria

| Criterion                                                                           | Target                                               | Measured | Met? |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------- | -------- | ---- |
| Time to first deliverable (from your own survey to a plan-profile sheet or LandXML) | ≤ 45 min for a first-time user                       |          |      |
| Earthwork volume difference vs your tool (pad cut and fill)                         | ≤ 2 %                                                |          |      |
| Pipe sizes vs your tool                                                             | identical                                            |          |      |
| LandXML opens in your software                                                      | surface, alignment and network import without errors |          |      |
| LandXML pipe slopes                                                                 | read correctly after checking the convention         |          |      |
| Blocking defects found                                                              | 0                                                    |          |      |

## Feedback form

Use the **Feedback** button (Civil / Site panel header): it opens an e-mail with the app version
and anonymous counts (entities, point groups, surfaces, platforms, alignments, manholes, pipes) —
never your coordinates, names or survey data. Paste this template into it:

```text
Office / country:
Your current tool(s) and version:
Job used for the comparison (type, size):

Time to first deliverable (min):
Pad volumes: llull cut / fill vs your tool cut / fill (m³):
Road volumes: llull vs your tool (m³):
Pipe sizes identical? (if not: which pipes, llull vs yours):
HGL difference at the worst manhole (m):
LandXML opened in (software / version)? Surface / alignment / pipes OK? Slope convention OK?

What blocked you:
What was missing for your national standard (design speed tables, IDF curves, pipe catalogue):
What your current tool does better:
What llull does better:
Would you use it on a live job? (yes / with changes / no) — why:
```

## The same job, automated

The production gate's `civil-site-development` scenario runs this workflow on the sample survey
through MCP and through the browser, and grades it with the office's acceptance criteria (balance
residual < 1 %, no design-check failure at the design speed, no surcharged or flooding pipe, a
well-formed LandXML with Surface / Alignment / PipeNetwork). See
[`PRODUCTION_GATE.md`](PRODUCTION_GATE.md).

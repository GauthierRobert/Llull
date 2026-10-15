# Gap FTR — Sheet-metal and machined manufacturing features — Functional specification

Gap id: **FTR** · Folder: `docs/aerospace/07-sheet-metal-machined-features/` · Status: draft spec (2026-10-15) ·
Related gaps: **08 (fastener catalogue)**, drawings / hole tables, STEP exchange, parametric history.

---

## 1. Summary

llull can model solids with extrude, revolve, sweep, loft, booleans, fillet, chamfer, shell and patterns. Under OCC these
results are exact B-reps. It has **no manufacturing features**. Nothing models sheet metal: no flange, bend, joggle,
relief, flanged lightening hole, bead or flat pattern. No hole command knows a counterbore, a countersink, a drill point
or a thread. Pockets with tool-driven corner radii are missing too, and nothing recognises such features on an imported
STEP part.

An airframe is mostly two families of parts:

- formed sheet: skins, stringers, clips, angles, ribs and frames in 2xxx/7xxx aluminium;
- machined monolithic parts: frames, spars, ribs and fittings pocketed from plate or forgings, drilled for fasteners.

Both families are defined by these features. The flat pattern drives blank cutting. The hole definition, meaning diameter,
countersink angle and depth, and the fastener, drives drilling, inspection and the fastener list. A user cannot produce a
flat-pattern DXF from llull, check a bend radius against the alloy's minimum, or call out a 100° countersink for a flush
fastener. llull therefore cannot author or check airframe detail parts, and that blocks every aerospace use beyond concept
volumes.

## 2. Aerospace context & value

### 2.1 Where these features are used

| Workflow | What the engineer does today | Feature needed in llull | Evidence |
| -------- | ---------------------------- | ----------------------- | -------- |
| **Field / MRO structural repair** of nonpressurized areas of civil aircraft | Lays out repair angles and doublers by hand. Picks a bend radius from the alloy/temper/thickness table, finds the setback from the K-chart and computes the bend allowance. | `sheet_metal_calc` (setback, BA, BD), min-bend-radius check, flat pattern | AC 43.13-1B par. 4-56, Tables 4-6/4-7 [R1][R2]. Its scope is repairs "only when there are no manufacturer repair or maintenance instructions" [R1]. |
| **Homebuilt / light aircraft** fittings | Computes BA with the FAA empirical formula BA = (0.01743R + 0.0078T)·N | same | EAA builder article [R3] |
| **OEM / Tier-1 sheet-metal detail design** (clips, angles, stringers, ribs) | Uses dedicated sheet-metal modules in CATIA, NX or SOLIDWORKS, or FreeCAD SheetMetal (OSS), and sends DXF flat patterns to laser/router/CAM | Base flange, edge flange, relief, joggle, lightening holes, bead, flat-pattern DXF (lines/arcs only) | FreeCAD SheetMetal: unfold, DXF/SVG export, per-material K-factor tables, "engineering mode" with mandatory K [R7]. It writes lines and arcs because suppliers and CAM "don't have good support for geometric primitives other than lines and arcs" [R7]. Commercial ASL docs: NOT VERIFIED (sources.md). |
| **Machined part design** (fittings, frames, monolithic ribs) | Hole wizard (drilled, counterbore, countersink), threads (cosmetic), pockets with corner radius ≥ tool radius, ribs | `add_hole`, `add_pocket`, `add_rib`, thread attribute, DFM checks | FreeCAD PartDesign Hole has cut types None/Counterbore/Countersink/Counterdrill, 118° drill point, cosmetic vs modelled thread, but no UNJ/MJ [R8]. OCC has native `BRepFeat_MakeCylindricalHole`, `BRepFeat_MakePrism`, `BRepFeat_MakeLinearForm` [R10]. |
| **Model-based definition (MBD) / STEP intake** of supplier parts | Imports STEP AP242 and re-identifies holes, pockets and bends to plan machining, drilling or inspection | `recognize_features` on imported B-rep | NIST MBE PMI CTC/FTC test parts in STEP AP242/AP203 [R5][R6]. |

### 2.2 Value

- **Flat pattern from the model, not from a chart.** AC 43.13-1B ties setback to a K-chart, K = tan(θ/2), and to bend
  radius plus thickness [R2]. llull computes the same quantities exactly. VC-FTR-02 reproduces the AC values 0.130 in and
  0.758 in. The tool then emits the blank as a DXF made of lines and arcs. This removes the manual layout step and its
  arithmetic errors.
- **Design-rule safety.** A bend below the alloy's minimum radius cracks, and a countersink deeper than the sheet leaves a
  knife edge. llull flags both from data tables at design time, not at the shop.
- **One hole definition from part to fastener.** A hole that references a fastener entry from gap 08 takes its diameter,
  countersink and thread from the catalogue. It stays consistent when the fastener changes.
- **Agent-drivable manufacturing.** Every feature is a registry command, so an MCP/CLI agent can lay out a bracket, check
  it, unfold it and export it in one `build_project` plan. That follows the llull prime directive.
- **Programme case studies:** quantitative benefits from named programmes, such as part-count reduction from monolithic
  machining or hydroforming cost, are **not yet sourced** (sources.md "NOT VERIFIED"). No figure is claimed here.

### 2.3 Tools in use today (comparison baseline)

| Capability | FreeCAD SheetMetal + PartDesign (OSS) [R7][R8] | Commercial (CATIA ASL, NX, SOLIDWORKS) | llull today | llull target (this gap) |
| ---------- | ------------------------------------------- | -------------------------------------- | ----------- | ----------------------- |
| Base / edge flange, bend | yes | yes (not verified here) | — | MVP |
| Relief, corner relief | yes | yes | — | V1 |
| Hem | yes | yes | — | V2 |
| Joggle | — (no dedicated tool found in the tool list) | CATIA ASL: listed as joggle feature (not verified) | — | V1 |
| Flanged lightening hole, bead | forming (stamp) tool | yes | — | V1 |
| K-factor tables (r/T), ANSI/DIN | yes (MDS) | yes | — | MVP |
| Unfold → DXF | yes (lines/arcs cleanup) | yes | — | MVP |
| Unfold an imported solid | yes ("Solid to Sheet Metal", unfolder) | yes | — | V1 |
| Hole: counterbore / countersink / counterdrill | yes, 90° default countersink | yes | manual cylinder + cone + 2 booleans | MVP |
| Threads | ISO, UNC/UNF/UNEF, cosmetic or modelled | yes | — | MVP (cosmetic UNJ/MJ/UN/M) |
| Pocket with corner radius, floor fillet | pocket + fillet | yes | extrude + boolean + fillet | MVP |
| Feature recognition on STEP | limited | yes (FeatureWorks, etc., not verified) | — | V1 |

## 3. Personas & user stories

| Persona | Story |
| ------- | ----- |
| **P1 Sheet-metal detail designer** (OEM/Tier-1) | As P1, I create an angle or clip from a sketch, add flanges, reliefs and a joggle, then get the flat pattern with bend lines and notes as DXF, so that the shop can cut the blank. |
| **P2 MRO repair engineer / A&P mechanic** | As P2, I enter alloy, temper, thickness and bend angle and get the minimum radius, setback, bend allowance and developed length, matching AC 43.13-1B, in inches. |
| **P3 Machined-part designer** | As P3, I place counterbored and 100° countersunk holes on a fitting from a fastener part number, pocket the web with a corner radius my cutter can reach, and see a DFM report. |
| **P4 Manufacturing / NC engineer** | As P4, I import a supplier STEP and get a list of holes (type, diameter, depth, countersink), pockets and bends, so I can plan operations and check drill sizes. |
| **P5 Stress / weight engineer** | As P5, I resize a pocket floor or flange via a parameter and get mass at once; lightening holes update the mass. |
| **P6 AI agent (MCP/CLI)** | As P6, I build, check, unfold and export a part from one `build_project` plan, and read a structured feature table (`data`) back. |
| **P7 Quality / inspection** | As P7, I get a hole table (position, diameter, countersink diameter and angle) and a bend table for the drawing. |

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| ----- | ------- |
| **MVP** | Sheet-metal rule (material, T, R, K or r/T table, ANSI/DIN); base flange; edge flange on straight edges; flat pattern (analytic, native parts); bend table; flat DXF; `sheet_metal_calc` query (AC 43.13-1B parity); minimum-bend-radius check from a data table. Hole feature with simple, counterbore, countersink and counterdrill types; blind (flat or drill point), through-all and up-to-face extents; several positions per command. Cosmetic thread attribute. Pocket (closed profile, depth, corner radius, floor fillet). Countersink knife-edge and pocket-corner DFM checks. |
| **V1** | Bend relief and corner relief; joggle; flanged lightening hole; bead/stiffener; sheet-metal hole-to-bend distance checks. `recognize_features` on imported STEP for holes, countersinks, counterbores, drill points, pockets, fillets and chamfers, with split-face merging. Convert an imported solid to sheet metal and unfold it. Fastener-catalogue link (gap 08). Rib feature. Hole and bend tables on drawing sheets. |
| **V2** | Hem; contour/curved flanges on developable surfaces; convert recognised features to parametric features; modelled (helical) threads for visualisation and export; pocket patterns such as isogrid for monolithic webs; a stretch-/hydro-formed blank estimate for doubly-curved parts (area-based, flagged approximate). |

### 4.2 Out of scope

- Forming simulation (springback, thinning, FLD), and hydroforming or stretch-forming process design. llull only marks
  doubly-curved formed parts as non-developable and gives an area-based blank estimate (V2).
- CAM toolpaths and NC output for machining. The DFM checks stop at feature geometry versus a declared tool.
- Certification content: llull does not replace AC 43.13-1B, an SRM or OEM process specifications. Tables are user data
  seeded from cited sources.
- Distributing standard documents. AS8879, ISO 5855 and NAS/NASM content stays with the licensed catalogue (gap 08). llull
  stores designations and user-entered or catalogue-provided numbers only.

### 4.3 Conventions & terminology (binding for all FTR commands)

| Term | Definition used by llull | Source |
| ---- | ------------------------ | ------ |
| Bend angle θ | The angle the flange is bent **through**: 0° = flat, 90° = right angle. A closed 45° angle is a 135° bend. | AC 43.13-1B K-chart example [R2] |
| Inside radius R | Radius of the bend's inner surface | [R2] |
| Thickness T (MT) | Nominal sheet thickness | [R2] |
| Mold line / mold point | Extension of the flat outer (or inner) surfaces; their intersection is the mold point | [R2] |
| Setback SB (OSSB) | Distance from the mold point to the bend tangent line on the outside: SB = K'(R + T), K' = tan(θ/2) (K-chart) | [R2] |
| K-factor (ANSI) | Neutral-axis position / T, 0 < K ≤ 0.5. **Distinct from the AC K-chart value K'** | [R7][R14] |
| K-factor (DIN) | 2 × ANSI K (FreeCAD convention); converted on input | [R7] |
| Bend allowance BA | Neutral-surface arc length: θ·(R + K·T) | [R7] |
| Bend deduction BD | 2·OSSB − BA; flat = sum of OML legs − BD | geometry |
| Joggle | Two opposite bends offsetting a flat by h so it nests over another part | geometry (§5.4 TECH) |
| Countersink angle α | Included cone angle (82°, 90°, 100°…); countersink depth c = (D − d)/(2·tan(α/2)) | geometry |
| Drill point angle β | Included angle of the drill tip (118° default in FreeCAD) | [R8] |
| Cosmetic thread | Thread specified as an attribute (designation, class, depth) without helical geometry | [R8] |

The K-factor and the K-chart value share a letter in the sources. llull names them `kFactor` and `kChart`
in every schema and output, so the two are never confused.

## 5. Functional requirements

Priority: MUST / SHOULD / COULD. Source = where the requirement or its numbers come from (R-ids in §11).

### 5.1 Sheet metal

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FTR-01 | MUST | A **sheet-metal rule** holds material/temper label, thickness T, default inside radius R, K-factor (single value or r/T → K table with linear interpolation) and the K standard (ANSI, or DIN where K_DIN = 2·K_ANSI). Default relief settings are COULD. One part uses one rule; flanges may override R. | Every flat-pattern number depends on T, R and K. FreeCAD uses the same model. | [R7] |
| FR-FTR-02 | MUST | **Base flange** from a closed planar profile, with thickness on a chosen side. | Start of every sheet part. | [R7] |
| FR-FTR-03 | MUST | **Edge flange** on a straight edge of a flat face: angle (0 < θ ≤ 180°), length referenced to the outside mold line, inside mold line or bend tangent, and position (material inside, material outside, bend outside), with an optional radius override. | AC/industry lengths are given to mold lines. Setback converts them. | [R2] |
| FR-FTR-04 | MUST | **Flat pattern**: develop the part with BA = θ·(R + K·T) per bend. Report the developed outline, overall extents, and a bend table per bend: angle, R, direction up/down, BA, BD, OSSB, K used. | Blank cutting. Inspection of formed lengths. | [R7][R2] |
| FR-FTR-05 | MUST | Unfold/fold **round trip**: refolding the flat pattern reproduces the folded geometry. At K = 0.5 the volume is conserved exactly. Unfold never modifies the folded part; it is derived. | Correctness guard. | analytic |
| FR-FTR-06 | MUST | **Flat-pattern DXF**: outline and cut-outs as lines and arcs only (splines approximated within tolerance), bend lines on separate layers for up and down, optional bend notes (angle, R, direction), mm or in. | Laser/CAM compatibility. | [R7] |
| FR-FTR-07 | MUST | **Minimum bend radius check** against a data table keyed by material/temper/thickness. It warns when R < R_min, and rejects R = 0 when the rule forbids sharp bends. Table values are user-editable data. Seed values come from AC 43.13-1B Table 4-6 only after verified transcription; until then the table ships empty with its schema. | Cracking prevention. | [R2] (table structure only) |
| FR-FTR-08 | SHOULD | **Bend relief** (rectangular, obround) and **corner relief** where flanges meet, sized from T and the rule's ratios. | Avoids tearing at bend ends. | [R7] |
| FR-FTR-09 | SHOULD | **Joggle**: offset h, joggle angle φ or run length, inside radius, on a flat region across a full width. The joggle allowance appears in the flat pattern. | Nesting over a skin, stringer or doubler step. | analytic (§5.4 TECH) |
| FR-FTR-10 | SHOULD | **Lightening hole with flanged lip**: hole diameter, flange height and angle, lip radius. The flat cut-out diameter is computed and flagged approximate (stretch flange). | Weight reduction with stiffness. Typical of ribs. | NOT VERIFIED practice (sources.md) |
| FR-FTR-11 | SHOULD | **Bead / stiffener**: formed bead along a path (cross-section radius, depth, end shape) on a flat face. Excluded from the flat pattern as a forming note. | Panel stiffening. | [R7] (forming tool) |
| FR-FTR-12 | COULD | **Hem** (closed, open, teardrop). | Edge safety and stiffness. | [R7] |
| FR-FTR-13 | COULD | **Contour flange / formed parts on curved surfaces**: develop when the surface is developable. Otherwise mark non-developable and give an area-based blank estimate. | Stretch/hydroformed skins and frames. | — |
| FR-FTR-14 | MUST | **`sheet_metal_calc` query** (no part needed). Inputs T, R, θ, K (or the FAA empirical mode). Outputs BA, OSSB, ISSB, BD, K-chart value tan(θ/2), R/T, and the minimum radius from the table, in mm or inch. It must reproduce the AC 43.13-1B K-chart examples and the EAA BA example. | P2 workflow parity. | [R2][R3] |
| FR-FTR-15 | SHOULD | **Convert solid to sheet metal**: detect constant thickness and bends (concentric cylinder pairs R / R+T) on an imported or native solid, then unfold it. Report a non-sheet geometry reason when it fails. | Supplier STEP intake. | [R7] |
| FR-FTR-16 | SHOULD | **Sheet DFM checks**: hole-to-bend distance, hole-to-edge distance, minimum flange length, relief present. Thresholds are rule data, not hard-coded. | Producibility. | — |

### 5.2 Machined features

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FTR-17 | MUST | **Hole feature** on a planar face. Types: simple, counterbore, countersink, counterdrill. Extents: blind (flat bottom or drill point angle, default 118°), through-all, up-to-next, up-to-face. One or more positions per command, a direction normal to the face (default) or given. | Core of machined-part design. | [R8][R10] |
| FR-FTR-18 | MUST | **Countersink** defined by (diameter at surface, included angle) or (depth, angle). The angle is free; presets: 82° (ASME screw convention [R9]), 90° (ISO 10642 [R8]), and 100° (aerospace flush-fastener convention, **to be confirmed from gap 08 / NASM**). The result reports the countersink depth c = (D − d)/(2·tan(α/2)). | Flush fasteners on aero surfaces. | [R8][R9]; 100° NOT VERIFIED |
| FR-FTR-19 | MUST | **Thread attribute (cosmetic)** on a hole or cylindrical boss: designation string (UNJ per AS8879, MJ per ISO 5855, UN, M), class/tolerance, depth, handedness. No B-rep change. Persisted, shown in drawings as a thread callout, listed by queries, and carried into code export as a comment or metadata. | Threads are specified, not modelled, in production CAD. | [R8] (cosmetic vs modelled) |
| FR-FTR-20 | COULD | **Modelled thread** (helical sweep), for visualisation and export only. | Rarely needed; costly. | [R8] |
| FR-FTR-21 | MUST | **Pocket**: closed planar profile on a face, depth, up-to-face or through. Vertical corner radius at least the declared tool radius, optional floor fillet with rf ≤ rc, islands SHOULD. | Monolithic part webs. | analytic (expected_pocket.json) |
| FR-FTR-22 | SHOULD | **Rib**: a rib or web from an open profile with thickness, height up to a face (OCC `BRepFeat_MakeLinearForm` semantics; built by recipe lowering, since that class is absent from opencascade.js 1.1.1). COULD: pocket patterns such as isogrid. | Machined stiffeners. | [R10] |
| FR-FTR-23 | MUST (V1) | **Fastener link**: a hole may reference a fastener catalogue entry (gap 08). Clearance diameter or fit class, countersink diameter and angle, and thread designation derive from it. Changing the entry re-evaluates the holes. | Single source for hole definitions. | gap 08 |
| FR-FTR-24 | MUST (V1) | **Feature recognition** (`recognize_features`, read-only) on any exact solid, imported STEP included. It returns holes (type, axis, diameters, depth, countersink angle and diameter, drill point, through or blind), pockets (floor, depth, corner and floor radii), fillets, chamfers, and sheet-metal bends and thickness. It merges faces split by the exporter on one analytic surface. | P4 workflow; STEP intake. | [R5][R6]; measured split faces |
| FR-FTR-25 | COULD | **Convert recognised features** into parametric `add_hole` / `add_pocket` steps on a defeatured base (volume preserved). | Editability of imported parts. | — |
| FR-FTR-26 | MUST | **Machining DFM checks**: countersink knife edge (c ≥ T at the hole), cylindrical land below a threshold, pocket corner radius < tool radius, depth/diameter ratio above a threshold, floor fillet > corner radius. Thresholds are data. | Producibility. | analytic |

### 5.3 Cross-cutting

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FTR-27 | MUST | Every feature is **parametric**: dimensions accept parameter expressions, features live in the feature history, and regeneration re-resolves faces and edges by stored reference points (face `near`), like `fillet_edge` `edgesNear`. | llull L8; KI5 topological naming. | llull |
| FR-FTR-28 | MUST | Every capability is a pure registry command (snake_case), reachable from UI, `llull` CLI and MCP. Kernel work goes through `ctx.kernel` (`requiresKernel`) only. Queries return `data`. | llull L1/L5/L9. | llull |
| FR-FTR-29 | SHOULD | **Hole table and bend table** as structured `data`, and as drawing-sheet tables (with the drawings work). | Inspection (P7). | — |
| FR-FTR-30 | MUST | **Units**: mm and inch documents; inch inputs reproduce the AC 43.13-1B examples to 0.0005 in. | US repair data is in inches. | [R2] |

## 6. Workflows

### 6.1 UI (desktop, offline)

1. **Sheet part.** Choose *Sheet Metal ▸ Rule…* and pick a material row; T, R and K are prefilled from the rule library.
   Draw a rectangle and run *Base Flange*. Select an edge and run *Flange* (angle, length, reference, position). A live
   flat length shows in the panel. Add *Relief* and *Joggle* (V1). Choose *Flat Pattern* to toggle the folded and flat
   views: the same document, a derived display. *Check* lists warnings, for example "R 1.0 < R_min 2.4 for 2024-T3 1.6"
   when such a row exists. *Export ▸ Flat DXF*.
2. **Machined part.** Select a face and run *Hole…* (type, size or fastener, extent, positions picked on the face with
   snapping). Run *Pocket…* (sketch on the face, depth, corner radius = tool radius, floor fillet). *Thread* is a checkbox
   in the Hole panel. Run *Check ▸ Machining*.
3. **Imported part.** Run *File ▸ Import STEP*, then *Analyse ▸ Recognise features*. The table panel can be sorted by
   type and diameter, and it highlights faces. For sheet geometry, run *Convert to sheet metal* (V1) and then *Flat
   Pattern*.

### 6.1b Detailed UI journey — MRO angle repair (UC-1)

1. *Sheet Metal ▸ Calculator*, units in. Enter T = 0.064, R = 0.25, θ = 135°, K-factor 0.4475 (or *FAA empirical*).
   The panel shows K-chart 2.4142, SB 0.758, BA, BD and R/T. When a radius-table row exists for the chosen alloy/temper
   at 0.064 in, it also shows R_min with its source line.
2. *Create rule from calculator*. The rule stores material, T, R and K.
3. Draw the repair angle web outline (2D) and run *Base Flange*. Select the long edge and run *Flange 135°*, length to
   the OML.
4. *Check*: green, or a list of violations. Each violation links to the rule and the table row.
5. *Flat Pattern*: the developed outline appears in an ortho view with bend lines and the note
   "UP 135° R0.25".
6. *Export ▸ Flat DXF (in)* produces the file for the shop. *Export ▸ Drawing* (drawings gap) adds a bend table.

### 6.1c Detailed UI journey — machined fitting (UC-5)

1. Import or model the block. *Hole…*: pick the top face, choose *Countersink*, preset 100° (tooltip: "aerospace flush
   convention — confirm with fastener catalogue"), d 4.8, D 9.0, *Through all*. Click 4 positions with snapping to grid
   or construction points, or paste coordinates.
2. *Hole…*: Counterbore 5.5 / 10.0 × 5.5, two positions.
3. *Pocket…*: sketch a rectangle on the top face. Corner radius 3 is suggested from the tool diameter 6 entered in the
   panel. Depth 4, floor fillet 0.
4. *Hole…*: Simple 6.0, blind 6, drill point 118°. Thread checkbox → designation field (free text, family picker).
5. *Check ▸ Machining*: countersink land OK (8.24 mm), pocket corner OK.
6. *Analyse ▸ Hole table* gives the table panel and the drawing table.

### 6.2 CLI (`llull`, local agent / CI)

```bash
llull sheet_metal_calc thickness=0.064 insideRadius=0.25 angle=135 kFactor=0.4475 units=in --json   # SB 0.758 in (AC 43.13-1B)
llull run validation/plans/draft_sheet_metal_bracket.json --doc bracket.llull.json --json          # build + check + unfold
llull export_flat_pattern_dxf id=<sm> --doc bracket.llull.json --save bracket_flat.dxf
llull import_step file=supplier.stp --doc part.llull.json && llull recognize_features id=<id> --doc part.llull.json --json   # recognition needs gap 01 import_step_brep (TECHNICAL_SPEC M0)
```

### 6.3 MCP agent (cloud)

1. `describe` the toolset `manufacturing` (names in TECHNICAL_SPEC §7).
2. Run `build_project` with the plan: create rule, then base flange, flanges, joggle, `check_sheet_metal`, `flat_pattern`.
3. Read the `data` of `flat_pattern` (bend table, extents) and of `check_sheet_metal` (violations). Adjust parameters
   with `set_parameter` and re-run the checks.
4. `export_flat_pattern_dxf`, which returns the file content in the result.

## 7. Acceptance criteria (Given / When / Then)

| AC | Given | When | Then | VC |
| -- | ----- | ---- | ---- | -- |
| AC-01 | T = 0.064 in, R = 0.25 in | `sheet_metal_calc` for θ = 45° and θ = 135° | OSSB = 0.130 in and 0.758 in (±0.0005 in), K-chart values 0.41421 and 2.4142 | VC-FTR-02 |
| AC-02 | T = 0.040 in, R = 0.250 in, θ = 60°, FAA empirical mode | `sheet_metal_calc` | BA = 0.2802 in (exact arithmetic; the EAA text rounds intermediates to 0.2796) within 0.0007 in of the EAA value | VC-FTR-03 |
| AC-03 | Rule T = 1.6, R = 4.8, K = 0.44; base 33.6 × 50 + 90° flange to 30 OML | `flat_pattern` | developed length 65.845663 mm ±0.01 mm, width 50, one bend (BA 8.645663) | VC-FTR-07 |
| AC-04 | Same part with K = 0.5 | volume of folded vs flat × T | equal within 1e-6 relative (5279.716754 mm³) | VC-FTR-06, VC-FTR-08 |
| AC-05 | Flat pattern of AC-03 | `export_flat_pattern_dxf` | DXF contains only LINE/ARC/CIRCLE (and TEXT when notes are on), one bend line on layer BEND_UP, extents 65.8457 × 50 | VC-FTR-09 |
| AC-06 | Rule with R = 0 and a table row for the material | `check_sheet_metal` | one violation `min_bend_radius`, with the table row cited | VC-FTR-10 |
| AC-07 | Joggle φ = 20°, R = 1.6, T = 1.6, h = 1.6, K = 0.44 | `flat_pattern` | joggle allowance 0.197880 mm ±0.001; JG-04 rejected with reason | VC-FTR-11 |
| AC-08 | 100 × 60 × 10 plate | one `add_hole` countersink call with four positions (d 4.8, D 9.0, 100°) + 2 counterbores + pocket + blind 118° | volume 55978.529153 mm³ (rel 1e-6); each countersink depth 1.762109 mm | VC-FTR-22, VC-FTR-25 |
| AC-09 | Countersink d 4.8 / D 9.0 / 100° in 1.6 mm sheet | `check_machining` | knife-edge violation (land −0.162 mm); in 3.0 mm sheet with D 12/d 6.4 no violation | VC-FTR-23 |
| AC-10 | `ftr_machined_plate.step` imported | `recognize_features` | 7 holes (4 csk 100°, 2 cbore, 1 blind 118°) + 1 pocket rc 3, positions ±1e-4 mm, no false positives | VC-FTR-17 |
| AC-11 | NIST CTC-01 imported | `recognize_features` | exactly 2 blind holes ∅20 with 118° point, each built from 2 half-cone faces | VC-FTR-20 |
| AC-12 | Hole with thread `MJ6x1-4H5H` (example designation string) | save, reload, `mass_properties` | designation persisted; volume equals the unthreaded hole | VC-FTR-28 |
| AC-13 | Plate thickness bound to parameter `t` | `set_parameter t=12` | holes stay through, countersinks keep D and angle; volume matches the analytic value at t = 12 | VC-FTR-30 |
| AC-14 | Any new command | registry snapshot / CLI `describe` | present with zod-derived schema; happy and failure unit tests | VC-FTR-31 |

## 8. Standards & regulatory alignment

| Standard / document | Relation | What llull uses | Verified |
| ------------------- | -------- | --------------- | -------- |
| FAA AC 43.13-1B ch. 4 (metal repair) | Reference workflow for repair layout | Setback = K(BR + MT), K-chart = tan(θ/2), Table 4-6 structure (alloy × temper × thickness → radius) | V-search [R2]; Table 4-6 values pending |
| FAA-H-8083-31B (AMT Airframe) | Training reference for bend allowance | none yet | title only [R4] |
| ISO 10303-242 (STEP AP242) | Import of MBD parts for recognition | geometry only (PMI out of scope here) | via NIST [R5] |
| SAE AS8879 (UNJ) / MIL-S-8879 | Thread designation in cosmetic attribute | designation string only | NOT VERIFIED |
| ISO 5855 (MJ) | same | designation string only | NOT VERIFIED |
| NAS / NASM flush fasteners (100° countersink) | Countersink preset; gap 08 catalogue supplies data | angle preset flagged "to confirm" | NOT VERIFIED |
| ISO 10642 / ASME B18.6.3 | Non-aero countersink presets 90° / 82° | presets | via FreeCAD data [R8][R9] |
| MMPDS (successor of MIL-HDBK-5) | Material allowables; not a bend-radius source | none | NOT VERIFIED |

Regulatory note: llull outputs are design data. Airworthiness approval of a repair or design stays with the approved
data holder. Every table row carries its source and edition, so the user can show traceability.

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Analytic flat-pattern references (FP-01…12, JG-01…04) reproduced | 100 % within 1e-6 mm (calc) / 0.01 mm (kernel unfold) |
| AC 43.13-1B and EAA worked examples reproduced | 3/3 within 0.0005 in (setback) / 0.0007 in (BA, EAA rounding) |
| Recognition on authored test parts | 100 % recall, 0 false positives |
| Recognition on NIST CTC-01…05 | 100 % of drill-point and countersink seeds classified; no crash; < 5 s per part (desktop OCC) |
| Flat DXF accepted by LibreCAD/ezdxf audit | 0 errors |
| Time to build + unfold + export the bracket plan via CLI | < 3 s warm (desktop) |
| Commands with happy + failure tests and coverage gate | 100 % / 90-85-90-90 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Primary FAA/NIST pages could not be fetched while writing this spec; some numbers are V-search | A wrong reference value could pass into a test | `validation/README.md` §6 lists the re-checks; V-search values are tagged, and a CI gate is frozen only after re-check |
| Table 4-6 radii unverified | Wrong minimum radius advice | Ship an empty table with schema and source fields; users import company or AC values |
| opencascade.js@1.1.1 lacks usable bindings for part of `BRepFeat_*` (review probe: `MakeCylindricalHole` not constructible, `MakeLinearForm` absent; `MakePrism`/`MakeRevol` construct — TECHNICAL_SPEC §1) | Native holes and ribs unavailable in the in-process kernel | Build holes and pockets as recipe sub-trees of existing primitives and booleans (works today, see baseline plan). `BRepFeat` is an optimisation; desktop OCC via CadQuery/OCP has it |
| Topological naming after upstream edits | Holes land on the wrong face | Face `near` points re-resolved on replay (KI5 pattern), plus a test that a hole stays on its face after a resize (VC-FTR-30) |
| K-factor is process-dependent | Flat length error | K is always explicit or from a user table. The "engineering mode" idea from FreeCAD [R7] makes K mandatory |
| Feature recognition ambiguity (chamfer vs countersink, fillet vs partial hole) | Wrong classification | Adjacency rules plus angular-span tests. Report confidence and ambiguous items instead of guessing |
| Fastener data licence (NAS/NASM/AS) | Cannot ship tables | Gap 08 supplies catalogues; this gap stores references only |

## 11. References

- [R1] AC 43.13-1B document page — FAA — https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.information/documentid/99861 (accessed 2026-10, V-search)
- [R2] AC 43.13-1B with Change 1, Chapter 4 Section 4 — FAA — https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_43.13-1B_w-chg1.pdf (accessed 2026-10, V-search; mirror https://raanz.org.nz/techproject/FAA%20AC43.13%20b/Chapter%2004.pdf)
- [R3] Making Fittings — Part 2 — EAA — https://www.eaa.org/eaa/aircraft-building/builderresources/while-youre-building/building-articles/basic-construction/making-fittings-part-2 (accessed 2026-10, V-search)
- [R4] Aviation Handbooks & Manuals (FAA-H-8083-31B) — FAA — https://www.faa.gov/regulations_policies/handbooks_manuals/aviation (accessed 2026-10, V-search)
- [R5] Download Free CAD Models, STEP Files, and Test Results — NIST — https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0 (accessed 2026-10, V-search)
- [R6] usnistgov/CAD-PMI-Testing — NIST / GitHub — https://github.com/usnistgov/CAD-PMI-Testing (accessed 2026-10, fetched)
- [R7] FreeCAD SheetMetal workbench @8177569 — shaise / GitHub — https://github.com/shaise/FreeCAD_SheetMetal (accessed 2026-10, fetched)
- [R8] FreeCAD PartDesign Hole (FeatureHole.cpp, Resources/Hole) @4a1904f — FreeCAD / GitHub — https://github.com/FreeCAD/FreeCAD (accessed 2026-10, fetched)
- [R9] FreeCAD Fasteners workbench @fddd07a — shaise / GitHub — https://github.com/shaise/FreeCAD_FastenersWB (accessed 2026-10, fetched)
- [R10] OCCT TKFeat / TKOffset headers @3d097a0 — Open Cascade SAS / GitHub — https://github.com/Open-Cascade-SAS/OCCT (accessed 2026-10, fetched)
- [R11] NIST CTC AP242 mirror @12fa031 — pzfreo/dw-examples / GitHub — https://github.com/pzfreo/dw-examples (accessed 2026-10, fetched)
- [R12] cadquery-ocp 8.0.1.1.0 — PyPI — https://pypi.org/project/cadquery-ocp/ (accessed 2026-10, installed)
- [R14] Analyzing the k-factor in sheet metal bending — The Fabricator — https://www.thefabricator.com/thefabricator/article/bending/analyzing-the-k-factor-in-sheet-metal-bending (accessed 2026-10, V-search; definition only)

Full verification log: `validation/sources.md`.

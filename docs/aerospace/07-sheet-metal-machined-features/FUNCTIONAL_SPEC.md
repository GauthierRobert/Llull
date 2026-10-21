# Gap FTR — Sheet-metal and machined manufacturing features — Functional specification

Gap id: **FTR** · Folder: `docs/aerospace/07-sheet-metal-machined-features/` · Status: draft spec (2026-10-15) ·
Related gaps: **08 (fastener catalogue)**, drawings / hole tables, STEP exchange, parametric history. Operator model:
[`AGENT_FIRST.md`](../AGENT_FIRST.md) (AI agent via the `llull` CLI; owner not assumed to be an engineer).

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

Roles follow [`AGENT_FIRST.md`](../AGENT_FIRST.md) §1. The operator is an AI agent driving the `llull` CLI. The owner is
the person who asks for the part and is **not assumed to be an engineer**. A qualified reviewer appears only where a
result feeds an aircraft repair, a part release or a safety decision.

| Role | Who (examples) | What they need from this gap |
| ---- | -------------- | ---------------------------- |
| **O1 Operator: CLI agent** (primary) | Claude Code or a similar agent with a shell, `--doc` headless or `--app` on the desktop window | Commands it can find (`llull search sheet metal`, `llull describe add_flange`), units stated in every schema, one plan per job, `--validate`, read-only checks with stable codes, numeric results in `data`, files written with `--save` |
| **O2 Operator: MCP agent** | Cloud agent on `/mcp`, toolset `manufacturing` | The same commands and the same `data` shapes |
| **W1 Owner** | Small repair-station manager, homebuilder, start-up founder, buyer who needs a bracket or a fitting | A plain-language answer: what was made, what passed, what needs a qualified person; the DXF / STEP files |
| **R1 Qualified reviewer** (only for certification / release / safety) | Engineer or certificated person with the authority the applicable rules require for the repair or part (the AC itself says it applies only when no manufacturer data exist [R1]) | A review surface showing the computed numbers, their provenance, every check finding and every `unverified` input; the only role that can approve a waiver or release |

| # | Story |
| - | ----- |
| US-1 (O1) | As the operator, asked "make the repair angle from 0.064 in 2024-T3, 135° bend", I find `sheet_metal_calc` with `llull search bend allowance`, call it with explicit `units=in`, and read setback, bend allowance and bend deduction from `data` with their formulas and inputs, without reading a K-chart. |
| US-2 (O1) | As the operator, I write the bracket as one plan file, run `llull run plan.json --validate`, then run it, then `check_sheet_metal` and `flat_pattern`, look at `render_view view=top --save flat.png`, and export the blank with `export_flat_pattern_dxf --save blank.dxf`. |
| US-3 (O1) | As the operator, I do not know the minimum bend radius of 2024-T3 or the safe distance from a hole to a bend. The check commands apply the rule tables for me and return codes (`FTR_BEND_RADIUS_BELOW_MIN`, `FTR_HOLE_TO_BEND_TOO_CLOSE`) with a remediation I can act on. |
| US-4 (O1) | As the operator, I place countersunk and counterbored holes and a pocket on a fitting with `add_hole` / `add_pocket`, then `check_machining` tells me about knife edges and cutter-radius problems with codes and values in mm. |
| US-5 (O1) | As the operator, I import a supplier STEP and get a feature list (holes, countersinks, pockets, bends) as `data` with face indices, so I can answer the owner's "what holes are in this part?" and build a hole table. |
| US-6 (O1) | As the operator, I change one parameter (`set_parameter t=12`) and re-run the checks and `mass_properties`; nothing else in the plan changes. |
| US-7 (W1) | As the owner, I get one paragraph: "built the angle; flat blank 65.846 mm × 50 mm; all checks pass; the radius table row it used is unverified; computed by llull, not approved — a qualified person must review it before it is used on an aircraft". |
| US-8 (R1) | As the qualified reviewer, I open the part in the desktop app, see every number with its formula and source, every `unverified` flag and every finding, and I alone can record the approval that waives a finding or releases the part (gap 09). |

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| ----- | ------- |
| **MVP** | Sheet-metal rule (material, T, R, K or r/T table, ANSI/DIN); base flange; edge flange on straight edges; flat pattern (analytic, native parts); bend table; flat DXF; `sheet_metal_calc` query (AC 43.13-1B parity); minimum-bend-radius check from a data table. Hole feature with simple, counterbore, countersink and counterdrill types; blind (flat or drill point), through-all and up-to-face extents; several positions per command. Cosmetic thread attribute. Pocket (closed profile, depth, corner radius, floor fillet). Countersink knife-edge and pocket-corner DFM checks. Agent-first requirements FR-FTR-31…41 (codes, units, named defaults, `unverified`, `reviewRequired`, waiver gate, provenance). |
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

### 5.4 Agent-first requirements ([`AGENT_FIRST.md`](../AGENT_FIRST.md))

No requirement in §5.1–5.3 exists only in the UI: every one is a registry command with `data`. The UI panels of
TECHNICAL_SPEC §7.3 are review surfaces (SHOULD), built on the same commands.

| Id | Pri | Requirement | AF | Source |
| -- | --- | ----------- | -- | ------ |
| FR-FTR-31 | MUST | **Units in every schema.** Every length param is in the document's length unit and its description says so; every angle param is in degrees and says so. `sheet_metal_calc` (no document needed) takes a **required** `units: 'mm' \| 'in'`; nothing is inferred from context the agent cannot see. Every result echoes `lengthUnit` and `angleUnit`. | AF-04, AF-02 | llull |
| FR-FTR-32 | MUST | **Documented `data` shapes.** Every query (`sheet_metal_calc`, `flat_pattern`, `recognize_features`, `hole_table`, `check_*`) returns the shape of TECHNICAL_SPEC §4.3, with units, in a deterministic order, bounded in size (outline vertices paged or narrowed by part id). Files (DXF) only via `--save`. | AF-10, AF-12, AF-13 | llull |
| FR-FTR-33 | MUST | **Stable error codes.** Every refusal and every check finding has a stable `FTR_*` code, the offending ids or plan paths, and a one-line remediation (TECHNICAL_SPEC §7.2). | AF-11 | llull |
| FR-FTR-34 | MUST | **Rules enforced by the checks, not by the operator.** `check_sheet_metal` and `check_machining` are read-only and return `pass` / `warn` / `fail` findings. They apply automatically every rule for which the document holds data: minimum bend radius and sharp bends (FR-FTR-07), hole-to-bend and hole-to-edge distance, minimum flange length, relief presence (FR-FTR-16), countersink knife edge and cylindrical land, pocket corner radius versus tool radius, depth/diameter ratio, floor fillet versus corner radius (FR-FTR-26). A rule whose threshold has no value is reported as `FTR_RULE_THRESHOLD_MISSING` (warn), never skipped silently. An agent ends every FTR job with the relevant check. | AF-20, AF-30 | llull |
| FR-FTR-35 | MUST | **No silent safety-relevant defaults.** K-factor, inside radius, minimum radius and DFM thresholds are given explicitly or come from a sourced row that the result names as `{ value, source, defaulted }`. A missing K-factor is a refusal (`FTR_K_FACTOR_MISSING`), not a default. Geometric conveniences (drill point 118° [R8]) are allowed but named with `defaulted: true` and their source. | AF-31 | llull |
| FR-FTR-36 | MUST | **`unverified` propagation.** Radius-table rows, K tables and presets carry `verification: 'verified' \| 'unverified'` and a source. A result computed from any unverified row or preset (for example a K table copied from a secondary source, the 100° countersink preset until gap 08 confirms it, a radius row without dual-review transcription) carries `unverified: true` and the list of unverified inputs; every check reports `FTR_UNVERIFIED_DATA` (warn) that no param can hide. | AF-32 | llull |
| FR-FTR-37 | MUST | **`reviewRequired`.** `sheet_metal_calc`, `flat_pattern`, `check_sheet_metal`, `check_machining`, `recognize_features` and `export_flat_pattern_dxf` results carry `reviewRequired: true` with a reason, and the summary says in plain words "computed by llull, not approved — a qualified person must review it before it is used for an aircraft part or repair". The flat DXF carries the same note on layer `NOTES`. | AF-33, AF-36 | §8 regulatory note |
| FR-FTR-38 | MUST | **Human gate on waivers.** A `fail` finding can only be waived by a waiver that references a human approval record of gap 09 (`record_approval`, `humanSignatureRequired`). The check commands ignore any other waiver and report `FTR_WAIVER_NOT_APPROVED`; the finding stays `fail`. The agent can prepare the waiver request; it cannot complete it. | AF-34 | gap 09 |
| FR-FTR-39 | MUST | **Provenance.** Every computed engineering value in `data` comes with `provenance`: method or formula id, the inputs with units, and the source ids (rule, table row, preset, reference). | AF-35 | llull |
| FR-FTR-40 | SHOULD | **Numeric equivalents of visual reviews, and a picture.** Flat-pattern view → `flat_pattern` outline, bend lines and extents; feature-table highlighting → face indices in `recognize_features`; DFM colouring → check findings. With `flat_pattern materialize=true`, `render_view view=top --save flat.png` shows the blank to a multimodal agent. | AF-21, AF-22 | llull |
| FR-FTR-41 | MUST | **One plan, validated; guide; dry run.** Every FTR job (bracket, joggle, machined plate, recognition) fits one `build_project` plan, checked with `llull run plan.json --validate` before kernel work (errors name the step path and param). `llull guide` gains an FTR section: bend angle = angle bent through, lengths to mold lines, K-factor always explicit, the minimal bracket plan. Every mutating FTR command works with `--dry-run`. | AF-03, AF-05, AF-42 | llull |
| FR-FTR-42 | SHOULD | **Long runs.** Recognition and imports of large parts honour `--progress` and `--timeout`; face graphs are cached by `recipeKey`, so a re-run is cheap. Everything runs offline on the desktop (pure TS + bundled OCC / CPython). | AF-40, AF-41 | llull |

## 6. Workflows

### 6.1 CLI (`llull`) — the primary workflow

Shown with `--doc` (headless). Use `--app` instead to act on the open desktop window, so the owner can watch. Commands
marked *(proposed)* are this gap's; the rest exist today. Exit code 0 = ok, 1 = a step or check refused, 2 = usage.

**Job A — MRO repair angle (UC-1), inch document.**

```bash
llull search bend allowance                                   # -> sheet_metal_calc (proposed)
llull describe sheet_metal_calc                               # units, modes, refusals
llull sheet_metal_calc units=in thickness=0.064 insideRadius=0.25 angle=135 kFactor=0.4475 --json
#   data.ossb 0.758063 (AC 43.13-1B: 0.758), data.kChart 2.414214, data.provenance, data.reviewRequired true
llull run plans/draft_sheet_metal_bracket.json --validate --doc angle.llull.json   # names step path + param on error
llull run plans/draft_sheet_metal_bracket.json --doc angle.llull.json --kernel occt --json
llull check_sheet_metal id=<part> --doc angle.llull.json --json                     # pass/warn/fail + FTR_* codes
llull flat_pattern id=<part> materialize=true --doc angle.llull.json --json         # extents, bends[], provenance
llull render_view view=top --save flat.png --doc angle.llull.json                   # look at the blank
llull export_flat_pattern_dxf id=<part> units=in --save blank.dxf --doc angle.llull.json
```

The agent reports to the owner in the order of AF-36: what was built, what passed, what needs a human (every
`unverified` input and the `reviewRequired` reason).

**Job B — machined fitting (UC-5), mm document.**

```bash
llull run plans/draft_machined_plate.json --validate --doc plate.llull.json
llull run plans/draft_machined_plate.json --doc plate.llull.json --kernel occt --json
llull check_machining id=<part> --doc plate.llull.json --kernel occt --json        # FTR_CSK_KNIFE_EDGE, FTR_POCKET_CORNER_BELOW_TOOL_RADIUS …
llull mass_properties entityId=<part> --doc plate.llull.json --kernel occt --json  # data.volume 55978.529153, volumeUnit mm³
llull hole_table id=<part> --doc plate.llull.json --json
llull render_view view=iso --save plate.png --doc plate.llull.json
llull export_step_ap242 --save plate.step --doc plate.llull.json --kernel occt
```

**Job C — supplier STEP intake (UC-4).** Needs gap 01 `import_step_exact` (TECHNICAL_SPEC M0).

```bash
llull import_step_exact file=supplier.stp --doc part.llull.json --kernel occt --progress --timeout 120
llull find_entities kind=mesh --doc part.llull.json --json
llull recognize_features id=<id> --doc part.llull.json --kernel occt --json        # holes[], pockets[], bends[], counts
llull convert_to_sheet_metal id=<id> stationaryFace='{"near":[0,0,0]}' --doc part.llull.json --json   # V1, sheet parts only
```

**Parametric change (US-6).** `llull set_parameter name=t expression=12 --doc plate.llull.json`, then re-run the check
and `mass_properties`.

### 6.2 MCP agent (cloud)

1. Enable toolset `manufacturing`; `describe` the commands (names in TECHNICAL_SPEC §7.1).
2. Call `build_project` with the same plan JSON as the CLI (`validate: true` first).
3. Call `check_sheet_metal` / `check_machining`, then `flat_pattern` or `recognize_features`; read `data`.
4. Call `export_flat_pattern_dxf`, which returns the file content in the result.

### 6.3 Desktop UI — review and approval surface

The UI does not add capability. It shows what the operator built, for the owner watching `--app` and for the qualified
reviewer:

- folded / flat toggle of the derived flat pattern (same data as `flat_pattern`);
- a findings panel listing `check_*` findings with codes, values, limits and sources, `unverified` inputs highlighted;
- a feature table (`recognize_features`, `hole_table`) that highlights face indices;
- the provenance of each number (formula, inputs, source row);
- the reviewer's approval action for a waiver or release, which is a gap 09 human gate (FR-FTR-38).

Parameter-gathering panels (Hole, Pocket, Sheet-metal) are SHOULD and only call the same commands.

## 7. Acceptance criteria (CLI + JSON assertions)

Each criterion is one or more CLI calls with `--json` and assertions on the result, compared with
`validation/expected_results.json` (key = VC id; value, tolerance, unit). Paths are into the `--json` object.

| AC | Given | When (CLI) | Then (JSON) | VC |
| -- | ----- | ---------- | ----------- | -- |
| AC-01 | T 0.064 in, R 0.25 in | `llull sheet_metal_calc units=in thickness=0.064 insideRadius=0.25 angle=45 kFactor=0.4475 --json`, same with `angle=135` | `data.ossb` = 0.130 / 0.758 in ±0.0005; `data.kChart` = 0.41421 / 2.4142; `data.lengthUnit` = "in" | VC-FTR-02 |
| AC-02 | T 0.040 in, R 0.250 in, 60° | `… mode=faa_empirical units=in thickness=0.04 insideRadius=0.25 angle=60 --json` | `data.ba` = 0.28017 ±1e-7 (EAA text 0.2796, within 0.0007) | VC-FTR-03 |
| AC-03 | Bracket plan (T 1.6, R 4.8, K 0.44, base 33.6 × 50, 90° flange 30 to OML) | `llull run plans/draft_sheet_metal_bracket.json --doc b.llull.json --json` then `llull flat_pattern id=<part> --json` | `data.extents[0]` = 65.845663 ±0.01 mm, `data.extents[1]` = 50, `data.bends.length` = 1, `data.bends[0].ba` = 8.645663 | VC-FTR-07 |
| AC-04 | Same part, K 0.5 | `flat_pattern` + `mass_properties` | `data.area` × 1.6 = `data.volume` = 5279.716754 mm³ (rel 1e-6) | VC-FTR-06, 08 |
| AC-05 | Flat pattern of AC-03 | `llull export_flat_pattern_dxf id=<part> --save b.dxf --json` | `saved` lists `b.dxf`; parsed DXF has only LINE/ARC/CIRCLE/TEXT, 1 entity on `BEND_UP`, extents 65.8457 × 50, `$INSUNITS` 4, NOTES text contains "not approved" | VC-FTR-09, 41 |
| AC-06 | Rule R = 0, `allowSharpBends` false, synthetic row | `llull check_sheet_metal id=<part> --json` | `data.status` = "fail" (check queries exit 0; refusals exit 1), one finding `code` = "FTR_SHARP_BEND_FORBIDDEN"; with R 1.0 vs row 2.0: `FTR_BEND_RADIUS_BELOW_MIN`, `limit` 2.0, `source` = row source | VC-FTR-10, 37 |
| AC-07 | Joggle φ 20°, R 1.6, T 1.6, h 1.6, K 0.44 | `flat_pattern` on the joggle part; `add_joggle` with JG-04 values | `data.joggles[0].allowance` = 0.197880 ±0.001; JG-04: exit 1, `code` = "FTR_JOGGLE_OFFSET_TOO_SMALL" | VC-FTR-11, 11b |
| AC-08 | 100 × 60 × 10 plate | `llull run plans/draft_machined_plate.json --doc p.llull.json --kernel occt` then `llull mass_properties entityId=<part> --kernel occt --json` | `data.volume` = 55978.529153 (rel 1e-6), `data.volumeUnit` = "mm³"; `hole_table` rows' `cskDepth` = 1.762109 | VC-FTR-22, 25 |
| AC-09 | Countersink d 4.8 / D 9.0 / 100° in 1.6 mm sheet | `llull check_machining id=<part> --json` | finding `FTR_CSK_KNIFE_EDGE`, `value` −0.162 mm (land); for D 12 / d 6.4 in 3.0 mm: no such finding | VC-FTR-23 |
| AC-10 | `ftr_machined_plate.step` imported with `import_step_exact` | `llull recognize_features id=<id> --kernel occt --json` | `data.counts` = {holes 7, countersink 4, counterbore 2, blind 1, pockets 1}; positions ±1e-4 mm; `data.unclassified` = [] | VC-FTR-17 |
| AC-11 | NIST CTC-01 imported | `recognize_features --json` | 2 holes with `drillPointAngleDeg` 118, `diameter` 20, each with 2 cone face indices | VC-FTR-20 |
| AC-12 | Hole with thread `MJ6x1-4H5H` | `set_thread`, save, reload, `mass_properties --json` | designation persisted; `data.volume` equal to the unthreaded hole | VC-FTR-28 |
| AC-13 | Plate thickness = parameter `t` | `llull set_parameter name=t expression=12`, then `mass_properties --json` | holes still through; volume = analytic value at t = 12 | VC-FTR-30 |
| AC-14 | Any new command | `llull describe <command>`; `llull search sheet metal` | listed; every numeric param description states its unit; toolset `manufacturing` | VC-FTR-31, 44 |
| AC-15 | Deliberately wrong inputs (PK-03 rf > rc, missing K, table row without source) | `add_pocket …`, `sheet_metal_calc units=mm thickness=1.6 insideRadius=4.8 angle=90`, `import_bend_radius_table …` | exit 1; `code` = `FTR_POCKET_FILLET_GT_CORNER` / `FTR_K_FACTOR_MISSING` / `FTR_TABLE_ROW_NO_SOURCE`; `remediation` non-empty; offending path given | VC-FTR-37, 39 |
| AC-16 | Radius row marked `unverified` | `sheet_metal_calc … material=TEST-ALLOY temper=T0 --json`; `check_sheet_metal --json` | `data.unverified` = true, `data.unverifiedInputs` names the row; check has warn `FTR_UNVERIFIED_DATA` | VC-FTR-40 |
| AC-17 | Any FTR query result | `flat_pattern --json` | `data.reviewRequired` = true, `data.reviewReason` non-empty; `summary` contains "not approved" | VC-FTR-41 |
| AC-18 | A `fail` finding and a waiver with no human approval | `check_sheet_metal id=<part> waivers='[…]' --json` | finding still `fail`; extra finding `FTR_WAIVER_NOT_APPROVED` | VC-FTR-42 |
| AC-19 | `sheet_metal_calc` of AC-01 | `--json` | `data.provenance.formulas.ossb` = "tan(theta/2)*(R+T)", `data.provenance.inputs.thickness` = {value 0.064, unit "in"}, `data.provenance.sources` contains "R2" | VC-FTR-43 |

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
| Agent driver completes UC-1 and UC-5 from plan files with `--json` and exit codes only (no UI), stopping only at the human gate | 2/2 scenarios |
| Refusals and check findings with a stable `FTR_*` code and a remediation | 100 % (VC-FTR-37) |
| Results built from an `unverified` row that fail to show the flag | 0 (VC-FTR-40) |

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
| The operator (agent) and the owner are not engineers | A part that violates a bend-radius, edge-distance, knife-edge or cutter rule is built and shipped | Rules live as sourced data and are applied by `check_sheet_metal` / `check_machining` with codes (FR-FTR-34); missing thresholds are reported, never skipped; `reviewRequired` and the waiver human gate keep approval with a qualified person (FR-FTR-37/38) |
| Rule tables ship empty or unverified (Table 4-6 not yet transcribed) | Checks have nothing to enforce | `FTR_BEND_RADIUS_NO_TABLE_ROW` / `FTR_RULE_THRESHOLD_MISSING` warnings and `FTR_UNVERIFIED_DATA` make the gap visible in every result |

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

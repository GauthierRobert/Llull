# Process plant design — gap analysis and specifications

Status: specifications and validation packs written 2026-10-18. Built since: 02 RTE V2 auto-router with its minimal M0/M1
slice (plugin `piping`, `doc.plant.piping`, native `llull-compute route`; 02 TECHNICAL_SPEC §13, 2026-10-19). D1 fixed (a6499537), D2 decided by the owner 2026-10-23; D3, D4, D6 and 03 Q1–Q3 / Q7 decided 2026-10-23 (owner delegated: "better for the app even if it takes more time"). The rest is not built.
Target: the level of detail of AutoCAD Plant 3D / Autodesk Plant Design Suite, AVEVA E3D, Hexagon Smart 3D and
CADMATIC: a complete process unit with vessels, columns, exchangers and pumps carrying nozzles; spec-driven piping
with flanges, gaskets, bolts, valves and insulation; steel with platforms, caged ladders and handrails; pipe racks;
P&IDs; isometrics; pipe stress; plant data and handover; and a colour-coded, plant-scale 3D review.

Authoring rules: [`TEMPLATE.md`](TEMPLATE.md) (same layout as [`../aerospace/TEMPLATE.md`](../aerospace/TEMPLATE.md)).
Operator model: [`../aerospace/AGENT_FIRST.md`](../aerospace/AGENT_FIRST.md) — an AI agent drives the `llull` CLI; a
qualified reviewer (piping / pressure-equipment / structural engineer) signs anything that touches safety.

## Where llull stands today

llull already does the **industrial building** side well ([`../INDUSTRIAL.md`](../INDUSTRIAL.md)): steel members,
grid framing, bracing, portal halls with full EN 1993 design, foundations, crane runways, pipe-rack moment frames,
pipe supports with span checks, cable trays, clash detection, `pipe_hydraulics`, schedules, takeoffs, IFC4/DXF/STEP.

Plant objects are thin:

| Object | Today | Plant 3D level |
| ------ | ----- | -------------- |
| Pipe | `add_pipe_run`: a 3D polyline with service, line number, DN (OD from a 19-row table), spheres at bends | spec-driven components: pipe by schedule, elbows / tees / reducers / olets, flange + gasket + bolt sets, valves with operators, insulation, cut lengths, ports and connectivity |
| Equipment | `add_equipment`: box or cylinder footprint, height, typed weight, clearance | parametric vessels / columns / exchangers / tanks / pumps with heads, skirts, saddles, nozzles as connection ports, volumes, weights, code thickness checks |
| Access | `add_stair` (building), slabs used as gratings | platforms (incl. circular around vessels), gratings with span tables, ladders + cages, handrails + toe plates, steel stairs, access rule checks |
| Schematics | 2D drafting only | P&IDs with smart symbols, tags, connectivity, DEXPI exchange, P&ID ↔ 3D check |
| Deliverables | plan / elevation / part sheets, NC1 for steel | isometrics, PCF, spools, weld maps, cut lists, BOM per iso, line / valve / nozzle / instrument lists, IFC 4.3 piping |
| Analysis | hydraulics, support spans | ASME B31.3 flexibility and stress, SIFs, nozzle loads |
| Review | one viewport, per-browser bookmarks, flat `render_view` | 10⁵–10⁶ components (instancing, LOD, culling), service colour codes, viewpoints, section boxes, issues (BCF) |
| Brownfield | none | E57 / LAS point clouds, pipe extraction, deviation, clash with as-built |

## Gaps

| # | Gap | Id | Functional | Technical | Validation | VCs | Plans |
| - | --- | -- | ---------- | --------- | ---------- | --- | ----- |
| 01 | Piping specs and component catalogue (ASME B36.10M/19M, B16.9, B16.5 + P-T ratings, B16.20, B16.10, EN 1092-1), branch tables | PSC | [spec](01-piping-specs-catalog/FUNCTIONAL_SPEC.md) | [spec](01-piping-specs-catalog/TECHNICAL_SPEC.md) | [pack](01-piping-specs-catalog/validation/README.md) | 19 | 5 |
| 02 | Spec-driven 3D routing: ports, auto fittings and flange sets, cut-back, slope, insulation, connectivity, `check_piping` | RTE | [spec](02-spec-driven-routing/FUNCTIONAL_SPEC.md) | [spec](02-spec-driven-routing/TECHNICAL_SPEC.md) | [pack](02-spec-driven-routing/validation/README.md) | 25 | 9 |
| 03 | Parametric equipment with nozzles: vessels / columns (ASME VIII UG-27/32/99), TEMA exchangers, API 650 tanks, pumps | EQP | [spec](03-parametric-equipment/FUNCTIONAL_SPEC.md) | [spec](03-parametric-equipment/TECHNICAL_SPEC.md) | [pack](03-parametric-equipment/validation/README.md) | 25 | 4 |
| 04 | P&ID schematics: ISO 10628-2 / ISA 5.1, tags, smart connectivity, DEXPI 1.3 / 2.0, P&ID ↔ 3D check | PID | [spec](04-pid-schematics/FUNCTIONAL_SPEC.md) | [spec](04-pid-schematics/TECHNICAL_SPEC.md) | [pack](04-pid-schematics/validation/README.md) | 20 | 5 |
| 05 | Isometrics and fabrication: PCF read / write, iso sheets, spools, welds, cut lists, BOM, GA annotation | ISO | [spec](05-isometrics-fabrication/FUNCTIONAL_SPEC.md) | [spec](05-isometrics-fabrication/TECHNICAL_SPEC.md) | [pack](05-isometrics-fabrication/validation/README.md) | 23 | 8 |
| 06 | Plant structures and access: platforms, gratings, ladders + cages, handrails, steel stairs (ISO 14122, OSHA 1910), pipe-rack generator, fireproofing | STA | [spec](06-plant-structures-access/FUNCTIONAL_SPEC.md) | [spec](06-plant-structures-access/TECHNICAL_SPEC.md) | [pack](06-plant-structures-access/validation/README.md) | 14 | 7 |
| 07 | Pipe stress and flexibility: 3D pipe-beam solver, ASME B31.3 (sustained / expansion / occasional), SIFs, nozzle loads, CAESAR II hand-off | PST | [spec](07-pipe-stress-flexibility/FUNCTIONAL_SPEC.md) | [spec](07-pipe-stress-flexibility/TECHNICAL_SPEC.md) | [pack](07-pipe-stress-flexibility/validation/README.md) | 19 | 5 |
| 08 | Plant data, reports and interop: classes, tag registry, hierarchy, lists, MTO, XLSX round trip, IFC 4.3 ADD2 piping with ports, IDS, CFIHOS | DAT | [spec](08-plant-data-reports-interop/FUNCTIONAL_SPEC.md) | [spec](08-plant-data-reports-interop/TECHNICAL_SPEC.md) | [pack](08-plant-data-reports-interop/validation/README.md) | 19 | 5 |
| 09 | Plant-scale visualization and review: instancing / LOD / BVH culling, service colour schemes (ASME A13.1, ISO 14726), viewpoints, section boxes, BCF issues, review render | VIS | [spec](09-plant-visualization-review/FUNCTIONAL_SPEC.md) | [spec](09-plant-visualization-review/TECHNICAL_SPEC.md) | [pack](09-plant-visualization-review/validation/README.md) | 23 | 6 |
| 10 | Point clouds and brownfield: E57 / LAS / LAZ, registration (targets, ICP), cylinder / pipe / steel extraction, deviation, as-built clash | SCN | [spec](10-pointcloud-brownfield/FUNCTIONAL_SPEC.md) | [spec](10-pointcloud-brownfield/TECHNICAL_SPEC.md) | [pack](10-pointcloud-brownfield/validation/README.md) | 30 | 5 |

Total: **217 validation cases, 59 scenario plans**. Each pack's `validation/sources.md` grades every source
(A = primary source read, reference code run or two independent sources agree; B = one extract; C = unconfirmed); only
grade A values and cited closed forms gate.

## Native compute (RS1, 2026-10-18)

The owner-approved programme [RS1](../decisions/RS1-native-compute.md) moves three plant workloads to the Rust
`solver/` workspace (binary `llull-compute`). Each TECHNICAL_SPEC has a "Stack amendment (RS1)" section and one
"native vs reference" VC. The other plant packs stay TypeScript (RS1 §4).

| Pack | Step | Native part | Stays as it is |
| ---- | ---- | ----------- | -------------- |
| 02 RTE | RS-7 (Rust CPU) | V2 auto-router search: `llull-compute route` (`llull-route`), checked and committed by `auto_route_pipe` | `route_pipe`, derivation, checks, takeoff; TS A* as reference (VC-RTE-25) |
| 09 VIS | RS-5 (GPU), RS-6 | optional GPU raster `llull-compute raster` (non-hash); `llull-bvh` for 10⁶-instance queries and the clash broad phase | TS raster = the `svgSha256` reference; `instanceBvh.ts`; three.js viewport (VC-VIS-60) |
| 10 SCN | RS-3 (Rust CPU), RS-4 (GPU) | E57 / LAS / LAZ import, octree, kd-tree, normals, RANSAC, ICP, COPC export, deviation and clash: `llull-compute cloud` (`llull-cloud`) | three.js `Points` viewport; recorded numbers from the Rust-CPU path (VC-SCN-60) |

## Validation data collected

Downloaded and kept (licence allows redistribution; sha256 in each `sources.md`):

| Pack | Files | Licence |
| ---- | ----- | ------- |
| 01 | dodo (FreeCAD piping) DIN PN16 flange, STD reducer and elbow CSVs (elbow kept as a negative example) | LGPL-3.0 |
| 04 | 11 DEXPI 1.3 training test-case P&IDs (C01 to P04), DEXPI 2.0 reference P&ID + XML schema | CC BY 4.0 |
| 06 | IFC 4.3 railing / stair / stair-flight / slab / plate / member enumerations | buildingSMART (copy with attribution) |
| 08 | buildingSMART IFC4X3_ADD2 Infra-Plumbing and Building-Hvac samples; reference IFC 4.3 files generated and validated with IfcOpenShell 0.9 (0 errors), an IDS file, XLSX round-trip files | CC BY 4.0 / this repo |
| 09 | BCF 3.0 `visinfo.xsd`, `markup.xsd`, documentation and example viewpoint; Khronos SimpleInstancing glTF | CC BY-ND 4.0 (verbatim) / CC0 |
| 10 | 10 E57 files (libE57Format test data, pye57 tests), 10 LAS / LAZ files (laspy 2.7.0) | CC0 / libE57 test-data licence / MIT / BSD-2 |

Read as data and transcribed only (tables with source id per row): `fluids` 1.3.1 (382 ASME B36.10M/B36.19M pipe
rows, Jones head volumes, vessel tests — MIT), `ht` 1.2.0 (TEMA, tube tables, insulation heat loss — MIT), `formulab`
(24 B16.5 flange rows — MIT), PSI pipe-stress tests (GPL-3.0, benchmarks reproduced to 4 digits by the pack's own
solver), IfcOpenShell / Bonsai stair and railing code (GPL / LGPL), pyDEXPI tests (AGPL-3.0), `three` r186 /
`three-mesh-bvh` / drei sources (MIT).

Pack-written references (exact arithmetic, scripts included): a DN100 sample PCF with parser / writer (05), synthetic
noisy cylinders, elbows and steel with a seeded generator (10), a synthetic pipe rack of N(n) = 227n + 8⌊n/4⌋
components (09), `derive_expected.py` scripts in 03, 06, 09.

Not reachable from the authoring sandbox (proxy 403 / DNS): Autodesk, AVEVA, Hexagon, CADMATIC docs; ASME, API, ISO,
ISA, TEMA, OSHA / eCFR, buildingSMART standards sites; NRC NUREG/CR-1677; vendor catalogues. Their facts come from
search extracts and are graded B or C unless two extracts agree.

## Dependencies and recommended order

```
01 PSC (catalogue + specs) ──> 02 RTE (routing) ──┬─> 05 ISO (isometrics, PCF, spools)
03 EQP (equipment + nozzles = ports) ─────────────┤─> 07 PST (stress; needs 01 walls, 03 nozzles)
                                                  ├─> 08 DAT (tags, lists, IFC 4.3 ports)
                                                  └─> 04 PID ↔ 3D check (P&ID authoring itself is independent)
06 STA (structures, access) — independent; uses existing steel; 03 for circular platforms
09 VIS (scale + review) — independent; colour by service gets richer after 02 / 08
10 SCN (point clouds) — independent; extraction writes 02 / existing pipes and steel
```

1. **01 PSC + 03 EQP** — the data and objects everything else consumes. 01 also fixes a live bug (below).
2. **02 RTE** — the core of "Plant 3D level": real fittings, flanges, valves, ports and connectivity.
3. **06 STA + 09 VIS** (parallel, independent) — what makes the model *look* like the reference images: platforms,
   caged ladders, handrails, service colours, plant-scale performance.
4. **05 ISO + 08 DAT** — deliverables: isometrics, lists, IFC 4.3 handover.
5. **04 PID** — schematics and the P&ID ↔ 3D consistency check.
6. **07 PST, 10 SCN** — engineering depth and brownfield.

Each `TECHNICAL_SPEC.md` § 10 gives milestones and effort (MVP estimates: PSC ~16 d, RTE ~21 d, EQP ~31 d,
PID ~40 d, ISO ~30 d, STA ~12 wk, DAT ~6.5 wk, SCN ~16 wk total; PST and VIS in their specs).

## Cross-gap findings and decisions for the owner

| # | Finding / decision | Packs | Recommendation |
| - | ------------------ | ----- | -------------- |
| D1 | **Live bug**: `packages/domain-aec/src/industrial/piping/pipeSizes.ts` mixes EN 10220 ODs with ASME walls; ASME NPS 2½ (OD 73.0) and NPS 5 (OD 141.3) miss every row by > 1.5 mm and fall back to a 2.5 / 3.53 mm wall instead of 5.16 / 6.55 mm, feeding hydraulics, riser support loads and steel line loads. | 01 | **Fixed** (a6499537): ASME B36.10M ODs of NPS 2½ and NPS 5 matched beside EN 10220. |
| D2 | **One plant home.** Packs propose `piping`, `plant-equipment`, `pid`, `piping-fabrication`, `plantStructures`, `plantData`, `scan` plugins and slices `doc.plant`, `doc.pid`, `doc.fabrication`, `doc.scan`. | all | One folder `packages/domain-aec/src/plant/<area>/`, one plugin per area, one additive core slice `doc.plant` with sub-records; settle before the first milestone. **Decided by the owner 2026-10-23** as recommended (first applied by 02 RTE: `doc.plant.piping`, plugin `piping`; 02 TECHNICAL_SPEC §13.4). The slice type lives in the plugin (`plant/types.ts`, `DocumentExtensions`), not in core; each area adds one optional sub-record. |
| D3 | **Nozzle / port convention.** 03 places nozzles by elevation + orientation angle (`V-101:N1`); 02 also needs explicit `{ position, direction }` ports for pumps and plain blocks. | 02, 03 | **Decided 2026-10-23** (owner delegated): both forms, one `ConnectionPort` type. `add_nozzle` takes an angle location or a free `{ position, direction }` location (pumps, `add_equipment` blocks); port id `<tag>:<mark>`; 02 `PortRef.kind: 'nozzle'`. Angles: `angleConvention` `north_cw` (default, vessel orientation drawings) or `east_ccw`, named in every result (03 Q2). |
| D4 | **Bundling transcribed tables** (ASME / EN dimensions from MIT / LGPL open data) as llull's default catalogue. | 01, 02, 03 | **Decided 2026-10-23** (owner delegated): ship. The default catalogues hold the grade-A and grade-B rows (numbers from MIT / LGPL packages and public tables; facts only, no file of an unlicensed source is redistributed), each value with its source id; grade < A is `unverified` and always reported. New licence flag `open-data` in `LICENCE_FLAGS` (replaces the provisional `company-proprietary`). D9 standards stay import-only; licensed imports stay private (`licensed-no-redistribution`). Same rule for 03 tables. |
| D5 | **Plan data binding** `$fromStep` in `build_project` (use one step's `data` in a later step). | 10 (also useful to 07, 08) | Small core addition to the project command; specify once in AGENT_FIRST AF-14. |
| D6 | **Equipment model**: keep equipment on building levels, or a separate plant hierarchy (site / area / unit). | 03, 08 | **Decided 2026-10-23** (owner delegated): one equipment model. `EquipmentElement` stays in the building model (its level = support datum and load path) and gains `plant?: PlantEquipmentData` (type in `plant/equipment/`), so clash, floor and steel loads, schedules, IFC, plans and openings keep reading one record. The site > plant > area > unit hierarchy and tags are 08 DAT's overlay (`assign_plant_object`), not a second geometry owner. A separate `doc.plant.equipment` was rejected: it doubles 13 consumer modules into two equipment kinds. |
| D7 | **IFC port connections**: IfcOpenShell writes 2 `IfcRelConnectsPorts` per connection, the IFC concept text 1 (SOURCE → SINK). | 08 | Follow the spec text; accept both on import. |
| D8 | **Engineering defaults**: B31.3 edition required or defaulted, friction μ = 0.3, B31J SIF tables import-only, UG-27 corroded radius. | 03, 07 | Make edition and allowable stress required inputs; keep μ as a named default flagged in results. |
| D9 | **Standards with no free numeric source** (B16.11, MSS SP-97 olets, EN 10253, B16.47, B31.3 allowables, B31J, ISO 14122 hoop spacing, API 2218, CAESAR II neutral file layout): import-only or TBD. | 01, 06, 07 | Licensed import path with `unverified` propagation; never defaulted. |
| D10 | **OSHA 1910.28 fixed-ladder 2036 retrofit date** is under a proposed repeal (April 2026); final status unknown. | 06 | Rule flagged; re-check before STA M1. |
| D11 | **Native compute (RS1, decided 2026-10-18).** Heavy work reaches `llull-compute` only through host transports or injected ports; native code never writes the document. Hashes stay on the reference path: 09 `svgSha256` on the TS raster, 10 TR-SCN-08 on the Rust-CPU path (identical on every OS and in its WASM build). Settles 10 Q2 (COPC writing) and Q4 (no libE57Format addon). | 02, 09, 10 | Adopted; see the table above. 02 / 09 / 10 milestones depend on RS-0 (`solver/` workspace) for their native parts. |

# 03 PRF — Large-model performance and robustness for daily use — Functional specification

Status: specification only (2026-10-28, origin/main f1351cff). Nothing in this pack is built. Gap id `PRF`. Track:
[`../README.md`](../README.md); templates [`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md),
[`../../plant/TEMPLATE.md`](../../plant/TEMPLATE.md). Technical view: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Readiness level: **PRL 2 (trustworthy)**.

Scope boundary. Assembly-scale *modelling* (instance patterns, kernel booleans of many tools, `check_assembly` at 10,000
parts, `capture_viewport`) is specified in [`../../design/08-assembly-scale/`](../../design/08-assembly-scale/) (ASC) and is
not repeated here. This pack covers what makes a large model **open, display, respond, save and import** on an ordinary
engineering PC: the document format, geometry storage, tessellation budget, renderer scaling, progress and cancel, memory,
and a performance gate that stops regressions.

## 1. Summary

llull is fast on the models its own gates build (tens to hundreds of entities) and slow or fragile on the models a
professional opens every day. The evidence is in the repository:

| # | Symptom | Evidence | Root cause (code survey, TECHNICAL_SPEC §1) |
| - | ------- | -------- | ------------------------------------------- |
| 1 | A 125k-triangle STEP part takes 12–21 s to open; its document is 44 MB (≈ 350 B/triangle) | [`../../QUALITY_GATES.md`](../../QUALITY_GATES.md) proposed gate 2 | meshes are stored as JSON number text, as a triangle soup, **twice**: once in the entity, once in the `import_mesh` step params (derivation: 168 + 188 = 356 B/triangle, §1.2 of the technical spec) |
| 2 | STEP files above ~0.8 M triangles cannot be imported | QUALITY_GATES defect 2 (`kuka-kr600` 860k, `rc-buggy-suspension` 1.2 M triangles) | the Python bridge answers in one JSON document capped at 128 MB |
| 3 | A fine tessellation kills the import process; a 9 cm stepper becomes a 114 MB document (79k triangles per M2.5 thread) | QUALITY_GATES defect 13 | fixed absolute 0.05 mm chord, no triangle budget, no graceful refusal |
| 4 | Opening a document, undo and redo resend the whole document to the window | `server/src/liveRoutes.ts` (`snapshot` on connect / undo / redo) | live sync is command-log based, but snapshots are full JSON documents |
| 5 | Renderer: one draw call per mesh part; instancing only for identical boxes, cylinders and spheres; no LOD for imported meshes; shadows reduced by entity count only | `src/ui/viewport/3d/grouping.ts`, `useRenderQuality.ts` | no batching of unique parts, no geometry-hash instancing, no screen-space LOD |
| 6 | Large mesh results depend on a per-machine cache: a document moved to another PC loses full resolution (`MESH_ASSET_MISSING`) | 07 MSH as-built §13.5 (asset store `~/.llull/cache/mesh`) | the asset store is not part of the document file |
| 7 | No measured budget exists for open time, frame time, pick latency, memory or save time, and nothing stops a regression | QUALITY_GATES "proposed next gates" 2 and 3 not built | no perf corpus, runner or baseline |

A professional judges a CAD tool on exactly these points; the incumbents ship dedicated large-model modes for them (§2).
Until they are closed, a mechanical, plant or civil engineer cannot trust llull with a real project file.

## 2. Context and value

**How incumbents handle large models.**

- **Partial loading.** SOLIDWORKS Lightweight components keep "only a subset of their model data" in memory and load the
  rest when needed; Large Assembly Mode switches a set of performance settings automatically above a user-set component
  count [S5]. Large Design Review opens an assembly for review (measure, rotate) without loading features or mates [S6].
  Inventor Express mode "loads only component cached graphics" for "significantly faster (3-5x) file open times", opening
  Express automatically when the unique-file count exceeds a user-set threshold [S3].
- **Guaranteed interactivity.** Navisworks Guarantee Frame Rate drops items it has no time to draw during navigation,
  ranked by size and distance, and draws them when navigation stops [S9]. AutoCAD adaptive degradation turns off display
  effects when the frame rate falls below a minimum [S11].
- **Compact files.** Navisworks NWD "compress the CAD data by up to 80 %" [S10]. llull's own glTF export reached
  15.9–17.5 B/triangle after indexing and instance reuse ([`../../decisions/LIM1-scale.md`](../../decisions/LIM1-scale.md)).
- **Hardware the incumbents assume.** Inventor recommends at least 24 GB RAM for a large assembly of more than 1,000 unique
  parts, 64 GB at about 7,000 unique parts, a graphics card with at least 4 GB of video RAM, and an SSD [S4]. SOLIDWORKS
  resellers quote 16 GB minimum / 32 GB recommended [S7]; one workstation vendor targets "> 30 fps" and calls a large
  assembly "over 10 million triangles" [S8].

**Responsiveness thresholds that apply to any interactive tool.** Respond to input within 100 ms; 60 frames per second
(≈ 16.7 ms) feels smooth; beyond 1 s users lose focus; beyond 10 s they are likely to abandon the task [S1][S2]. Operations
over 10 s need a percent-done indicator [S2].

**Why llull must close the gap.** The product directive is local-first, native code preferred ([`../../../CLAUDE.md`](../../../CLAUDE.md)).
A local app has no server farm to hide behind: the user's PC is the whole budget, so storage, tessellation and rendering must
scale on it. Packs 04 DSF (trust) and 03 PRF (speed) together form readiness level PRL 2.

## 3. Personas and user stories

Operator: a **professional engineer at the desktop app** (track rule, [`../README.md`](../README.md)). Agent-first rules
still hold: every action is a registered command, every refusal has a stable code and a CLI path
([`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md)).

| Persona | Daily model (spec budget, §5 tiers; owner question Q1) | Stories |
| ------- | ------------------------------------------------------ | ------- |
| `mechanical` | machine or product assembly, 500–2,500 parts, purchased STEP parts with threads and fillets | US-1 "I open my 2,000-part machine and can orbit and pick before every part is at full resolution." US-2 "Importing a vendor STEP never crashes the app; if a part is too fine I am told which one and what was done." |
| `plant` | pipe rack + equipment + structure, thousands of parts, vendor equipment as STEP | US-3 "Undo on a big plant model is instant; it does not reload the whole model." |
| `steel` | hall or platform, hundreds to thousands of members + connections | US-4 "Moving one member repaints in a blink however big the model is." |
| `civil` | site plan: tens of thousands of 2D entities, terrain surface of 10⁵–10⁶ triangles | US-5 "Panning a 100,000-entity site plan is smooth." |
| all | — | US-6 "Save and autosave never freeze the window." US-7 "I can e-mail one file and my colleague sees the same full-resolution model." US-8 "A long import or open shows progress and I can cancel it without losing my document." |
| agent (CLI) | same models through `llull --app` or a file | US-9 "Each command result carries its timings; refusals have codes I can branch on." |
| maintainer | — | US-10 "A change that makes any budget 20 % worse on the reference machine fails the gate." |

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | M0 perf corpus + runner + baselines (measure before fixing) · M1 meshes stored once, by reference, in a binary single-file container · M2 tessellation budget with relative deflection and graceful refusal; native binary STEP mesh import · M3 progress + cancel for open / import / save / export |
| **V1** | M4 renderer scaling (batching, geometry-hash instancing, screen-space LOD, motion degradation, BVH picking on batches) · M5 lazy / progressive open, binary asset transport to the renderer, O(change) live sync and undo · M6 memory budgets and refusals, large-model mode |
| **V2** | M7 occlusion culling, 2D batching of every kind, leak gate, T3 (10,000 parts) budgets gating on a workstation profile |
| Out of scope | instance patterns, kernel boolean speed, `check_assembly` scale, viewport capture (08 ASC); undo history semantics and crash recovery (04 DSF); installer and GPU driver detection (05 INS); the Electron harness itself (06 E2E) |

## 5. Functional requirements

Model-size tiers (spec budgets; machine profile `office-min` unless stated; derivations in TECHNICAL_SPEC §8):

| Tier | Parts (3D bodies) | Triangles displayed (full res) | 2D entities | Used by |
| ---- | ----------------- | ------------------------------ | ----------- | ------- |
| T1 typical | ≤ 500 | ≤ 1 M | ≤ 20,000 | every persona, every day |
| T2 large | ≤ 2,500 | ≤ 5 M | ≤ 100,000 | mechanical machine, plant area, steel hall, civil site |
| T3 very large | ≤ 10,000 | ≤ 20 M | ≤ 250,000 | reported on `ref-win11`; gates when a workstation profile exists (V2) |

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-PRF-01 | MUST | llull publishes the supported model-size tiers (above) per persona, and the perf corpus holds at least one model per tier and persona | a professional must know before buying whether his models fit | [S4][S8]; 08 ASC |
| FR-PRF-02 | MUST | Opening a document shows a first navigable frame (coarse geometry allowed, all parts present) before full resolution is loaded: T1 ≤ 2 s, T2 ≤ 5 s; full resolution T1 ≤ 5 s, T2 ≤ 10 s | RAIL load 5 s / repeat load 2 s; Nielsen 10 s | [S1][S2][S3] |
| FR-PRF-03 | MUST | Orbit / pan / zoom frame time p95: T1 ≤ 16.7 ms, T2 ≤ 33.3 ms, on `office-min` | 60 fps smooth; > 30 fps for large assemblies | [S1][S8] |
| FR-PRF-04 | MUST | Picking (hover pre-highlight and click select) from pointer event to highlighted frame p95 ≤ 100 ms at every tier; input handling ≤ 50 ms | RAIL response | [S1][S2] |
| FR-PRF-05 | MUST | A local edit (move, set colour, set parameter that touches one part) is repainted within 100 ms p95 at T1 and T2: command cost grows with the change, not with the document | RAIL response; today undo resends the document | [S1]; code survey |
| FR-PRF-06 | MUST | Explicit save: T1 ≤ 1 s, T2 ≤ 5 s. Autosave and save never block the window for more than 50 ms in one task | Nielsen 1 s; RAIL idle 50 ms | [S1][S2] |
| FR-PRF-07 | MUST | Memory: at T2 the renderer's V8 heap stays ≤ 2 GB and all llull processes together ≤ 8 GB on `office-min`; a command that would exceed the budget is refused before it allocates (`PRF_MEMORY_BUDGET`), never an out-of-memory crash | Electron heap is capped at 4 GB (memory cage); office-min has 16 GB | [S24][S7] |
| FR-PRF-08 | MUST | A mesh is stored once, in binary, and the document stores ≤ 32 bytes per displayed triangle (full resolution + display LODs, before general-purpose compression) | 350 B/triangle today; LIM1 GLB 15.9–17.5 B/triangle | QUALITY_GATES; LIM1; derived §8 |
| FR-PRF-09 | MUST | A saved document is self-contained: one file carries every full-resolution mesh and B-rep it references; opening it on another PC never yields `MESH_ASSET_MISSING` | 07 MSH assets live in a per-machine cache | 07 MSH §13.5 |
| FR-PRF-10 | MUST | Tessellation has a budget: deflection is relative to body size by default, the triangle count is estimated before meshing, a body over budget is coarsened (warning `PRF_TESSELLATION_COARSENED`) or refused (`PRF_TESSELLATION_BUDGET`, naming the body and the cure); no process is ever killed by a fine tessellation | defect 13 (bridge killed, 79k triangles per thread) | QUALITY_GATES; [S21] |
| FR-PRF-11 | MUST | STEP mesh import handles every file of the corpus up to T2 (`rc-buggy-suspension` 1.2 M triangles, `fc-raspberry-pi-4b` 52 MB) within its budget, with progress | defect 2 (128 MB JSON cap) | QUALITY_GATES |
| FR-PRF-12 | MUST | Any operation that can last over 1 s reports progress (CLI `--progress`, UI indicator); any operation that can last over 10 s shows percent done and can be cancelled; a cancelled command leaves the document unchanged (`PRF_CANCELLED`) | Nielsen progress guidance | [S2]; L3 purity |
| FR-PRF-13 | MUST | Display simplification (LOD, culling, motion degradation) never changes a measurement, check or export: commands read full resolution; the UI shows when the display is simplified | trust; 07 MSH invariant "LOD is for display only" | [S9][S11]; 07 MSH |
| FR-PRF-14 | SHOULD | Live sync, undo and redo send O(change) data: no full-document snapshot on undo / redo; large parameters (meshes, files) travel as content keys | US-3 | code survey |
| FR-PRF-15 | MUST | A perf gate runs the corpus on a named machine profile and fails when any budgeted metric is more than 20 % worse than the stored baseline of that profile, or over its absolute budget | QUALITY_GATES proposed gate 2; readiness_gate.json `regression` | QUALITY_GATES |
| FR-PRF-16 | MUST | Timings are observable offline: every command result can carry `timings` (CLI `--timings`), and `llull perf report` prints the last run per metric | agent-first AF-11; maintainers | AGENT_FIRST |
| FR-PRF-17 | SHOULD | A 100,000-entity 2D drawing pans and zooms within the T2 frame budget, with every 2D kind batched | civil persona | [S1] |
| FR-PRF-18 | SHOULD | Large-model mode: above a threshold (default: T1 limits) display defaults switch automatically (no soft shadows, aggressive LOD, motion degradation), visibly, and the user can override | SOLIDWORKS LAM, Inventor Express thresholds | [S3][S5] |
| FR-PRF-19 | MUST | Every hard limit (triangles per import, bodies, document bytes, string length, memory) is a named refusal with the limit and the cure, raised before the resource is exhausted | today: text messages, a killed bridge, V8 `Invalid string length` beyond 2²⁹−24 characters | [S25]; code survey |
| FR-PRF-20 | SHOULD | Open, close all, re-open five times: GPU geometry count and heap return to the first-open level ± 5 % | QUALITY_GATES proposed gate 3 | QUALITY_GATES |

## 6. Workflows

**CLI first.**

```text
llull open big.llull --app --progress --timings      # progress events; data.timings {firstFrameMs, fullResMs}
llull import_step path=vendor.step --app --progress   # PRF_TESSELLATION_COARSENED warnings name the bodies
llull import_step path=fine.step tessellation='{"relative":0.002,"maxTrianglesPerBody":200000}'
llull cancel <commandId> --app                        # PRF_CANCELLED, document unchanged
llull perf run --tier T2 --profile office-min         # perf runner (TECHNICAL_SPEC §9)
llull perf report                                     # last results, baseline, verdict per metric
```

**UI.** Opening: the model appears coarse at once, a status-bar indicator shows "Loading full detail 63 %" with Cancel;
the "Simplified display" badge stays while any LOD is active. Import dialog: tessellation quality (Coarse / Normal / Fine,
mapped to relative deflection), estimated triangles before import. Large-model mode badge with an override.

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| the perf corpus | `llull perf corpus verify` | every tier × persona cell has a model; every file matches its sha256 | VC-PRF-01 |
| T1 / T2 documents on `office-min` | open in the desktop app | first frame ≤ 2 / 5 s, full res ≤ 5 / 10 s, progress shown, cancel works | VC-PRF-02, 03, 04, 05, 24 |
| T1 / T2 documents | scripted orbit of 10 s | frame time p95 ≤ 16.7 / 33.3 ms; ≤ 200 draw calls at T2 | VC-PRF-06, 07, 08 |
| a T2 document | 200 scripted picks | p95 ≤ 100 ms | VC-PRF-09 |
| a T2 document | `move` one part; undo; redo | each repaint ≤ 100 ms p95; no snapshot event sent | VC-PRF-10, 27 |
| a T2 document | save; autosave during orbit | save ≤ 5 s; no main-thread task > 50 ms | VC-PRF-11, 12, 13 |
| T2 open | read heap / RSS | ≤ 2 GB / ≤ 8 GB | VC-PRF-14, 15 |
| an import that needs more memory than the budget | import | `PRF_MEMORY_BUDGET` before allocation, app alive | VC-PRF-16 |
| `part-11752` imported and saved | measure the file | ≤ 32 B/triangle; mesh stored once | VC-PRF-17, 18 |
| a saved document copied to a clean cache | open | identical full-res volume, no `MESH_ASSET_MISSING` | VC-PRF-19 |
| `syn-huge-sphere`, `fc-nema17-connector` | import | no crash; coarsened or refused with codes; volume error within the gate tolerance | VC-PRF-20, 21, 22 |
| `kuka-kr600`, `rc-buggy-suspension`, `fc-raspberry-pi-4b` | import | imports with progress within budget | VC-PRF-23 |
| LOD active | `measure_bounding_box`, `mass_properties`, `export_stl` | identical to full-res values | VC-PRF-25, 26 |
| a commit that slows open by 25 % | perf gate | red, `PRF_BASELINE_REGRESSION` on that metric | VC-PRF-28 |
| any CLI command | `--timings` | `data.timings` present | VC-PRF-29 |
| 100,000-entity 2D plan | pan / zoom | p95 ≤ 33.3 ms | VC-PRF-30 |
| a T2 document | open | large-model mode on, badge visible, override works | VC-PRF-31 |
| oversize inputs (string, bodies, triangles) | import / save | named refusal, no crash | VC-PRF-32 |
| open/close ×5 | read `renderer.info.memory` + heap | back to baseline ± 5 % | VC-PRF-33 |

## 8. Standards and practice alignment

- Responsiveness: RAIL [S1], Nielsen limits [S2]. These are human-factors thresholds, not standards; budgets derived from
  them are spec budgets (grade `target`).
- Geometry containers: glTF 2.0 binary buffers [S19], `EXT_meshopt_compression` [S17], `KHR_draco_mesh_compression` [S18]
  (export side; already in 08 ASC for instancing). Zstandard RFC 8878 for lossless blob compression [S20].
- OCCT meshing: absolute or relative linear deflection plus angular deflection, parallel edge discretization [S21][S22].

## 9. KPIs

| KPI | Today | Target |
| --- | ----- | ------ |
| Document bytes per triangle (imported STEP) | ≈ 350 (44 MB for 125k) | ≤ 32 |
| `part-11752` STEP open (import) | 12–21 s | ≤ 5 s (T1 open budget) |
| Largest STEP that imports | < 0.8 M triangles (JSON cap) | every T2 corpus file (≥ 1.2 M triangles) |
| Process crashes on fine tessellation | 1 known (`syn-huge-sphere`) | 0 |
| Undo on a T2 model | full-document snapshot | O(change) event |
| Budgeted perf metrics under a regression gate | 0 | all of §8 TECHNICAL_SPEC |

## 10. Risks and assumptions

- Measuring frame time and picks needs the Electron harness of pack 06 E2E; until it exists, the CLI timings and a
  renderer instrumentation hook are the only drivers (TECHNICAL_SPEC §9).
- Budgets on `office-min` need a physical or rented reference machine of that profile; the owner workstation (`ref-win11`)
  is far above it (RTX 4080 Laptop, 31 GB). Until one exists, `office-min` cases stay `skipped` and block PRL 2 (gate rule
  `skippedMustBlocks`).
- The container format changes the file on disk. Owner rule "no backward compatibility" (2026-10-22) would drop reading
  v3 `.llull.json`; users' existing files make that a decision (Q3).
- Relative deflection makes small features of large bodies coarser; the tolerance must keep QUALITY_GATES volume (1.5 %)
  and bounding-box checks green (VC-PRF-21 guards this).
- Electron's 4 GB heap cap [S24] is fixed for practical purposes; geometry must live in typed arrays and, at T3, outside the
  renderer heap (GPU buffers, worker-owned buffers).

## 11. References

Grades and extracts: [`validation/sources.md`](validation/sources.md).

- [S1] RAIL performance model — web.dev (Google) — https://web.dev/articles/rail (accessed 2026-10)
- [S2] Response Times: The 3 Important Limits — Nielsen Norman Group — https://www.nngroup.com/articles/response-times-3-important-limits/ (accessed 2026-10)
- [S3] About Express Mode — Autodesk Inventor 2025 Help — https://help.autodesk.com/cloudhelp/2025/ENU/Inventor-Help/files/GUID-34C9AE4C-EDA7-4E46-AD51-3383A67FF1B9.htm (accessed 2026-10)
- [S4] System Hardware and Large Assemblies — Autodesk Inventor 2022 Help — https://help.autodesk.com/cloudhelp/2022/ENU/Inventor-Help/files/GUID-D6B5DFF4-7888-4A66-BCA4-380050EF8366.htm (accessed 2026-10)
- [S5] Large Assembly Mode — SOLIDWORKS Help — https://help.solidworks.com/2017/English/SolidWorks/sldworks/r_Large_Assembly_Mode_SWassy.htm (accessed 2026-10)
- [S6] Large Design Review — SOLIDWORKS Help / GoEngineer — https://help.solidworks.com/2017/English/SolidWorks/sldworks/HIDD_DIALOG_LDR_WARNING.htm ; https://www.goengineer.com/blog/open-large-assemblies-in-solidworks (accessed 2026-10)
- [S7] SOLIDWORKS 2025 hardware recommendations — Javelin / Solid Solutions — https://www.javelin-tech.com/blog/2024/09/solidworks-2025-hardware-recommendations/ ; https://www.solidsolutions.co.uk/the-best-hardware-for-solidworks-in-2025/ (accessed 2026-10)
- [S8] Hardware recommendations for SOLIDWORKS — Puget Systems — https://www.pugetsystems.com/solutions/cad-workstations/solidworks/hardware-recommendations/ (accessed 2026-10)
- [S9] Display page / Performance tab (Guarantee Frame Rate, culling) — Autodesk Navisworks Help — https://help.autodesk.com/cloudhelp/2024/ENU/Navisworks/files/GUID-B470F105-8626-44FF-B531-8864FBD79CDA.htm (accessed 2026-10)
- [S10] Native File Formats (NWD) — Autodesk Navisworks 2020 Help — https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-C6936A0B-1597-4880-83F9-7041894A4204.htm (accessed 2026-10)
- [S11] -GRAPHICSCONFIG (adaptive degradation) — AutoCAD Help — https://help.autodesk.com/cloudhelp/2019/ENU/AutoCAD-Core/files/GUID-0A5B89D1-0A3F-4895-8392-4FAF876D5048.htm (accessed 2026-10)
- [S12] Large assembly performance — Onshape blog — https://www.onshape.com/en/blog/large-assembly-performance-cloud-native-cad-pdm (accessed 2026-10)
- [S13] BatchedMesh.js source — three.js — https://github.com/mrdoob/three.js/blob/dev/src/objects/BatchedMesh.js (accessed 2026-10)
- [S14] InstancedMesh; BatchedMesh docs — three.js — https://threejs.org/docs/pages/InstancedMesh.html ; https://threejs.org/docs/pages/BatchedMesh.html (accessed 2026-10)
- [S15] three-mesh-bvh README — G. Johnson — https://github.com/gkjohnson/three-mesh-bvh (accessed 2026-10)
- [S16] meshoptimizer README — A. Kapoulkine — https://github.com/zeux/meshoptimizer (accessed 2026-10)
- [S17] EXT_meshopt_compression — Khronos glTF — https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md (accessed 2026-10)
- [S18] KHR_draco_mesh_compression — Khronos glTF — https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md (accessed 2026-10)
- [S19] glTF 2.0 specification — Khronos — https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html (accessed 2026-10)
- [S20] RFC 8878 Zstandard Compression — IETF — https://www.rfc-editor.org/rfc/rfc8878 (accessed 2026-10)
- [S21] Mesh user guide (BRepMesh) — Open CASCADE 7.9 — https://occt3d.com/dev/doc/overview/html/occt_user_guides__mesh.html (accessed 2026-10)
- [S22] BRepMesh_IncrementalMesh reference — Open CASCADE — https://dev.opencascade.org/doc/refman/html/class_b_rep_mesh___incremental_mesh.html (accessed 2026-10)
- [S23] Supported command line switches (`--js-flags`) — Electron — https://www.electronjs.org/docs/latest/api/command-line-switches (accessed 2026-10)
- [S24] Electron and the V8 Memory Cage — Electron blog — https://www.electronjs.org/blog/v8-memory-cage (accessed 2026-10)
- [S25] v8-primitive.h (`String::kMaxLength`) — V8 via nodesource docs; MDN String length — https://v8docs.nodesource.com/node-24.1/d3/db9/v8-primitive_8h_source.html ; https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/length (accessed 2026-10)
- [S26] WebGL2RenderingContext.beginQuery (occlusion queries) — MDN — https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/beginQuery (accessed 2026-10)
- [S27] MBE PMI validation — download free CAD models — NIST — https://www.nist.gov/el/systems-integration-division-73400/mbe-pmi-validation-and-conformance-testing/download-free-cad (accessed 2026-10)
- [S28] ABC: A Big CAD Model Dataset for Geometric Deep Learning — Koch et al., CVPR 2019 — https://openaccess.thecvf.com/content_CVPR_2019/html/Koch_ABC_A_Big_CAD_Model_Dataset_for_Geometric_Deep_Learning_CVPR_2019_paper.html (accessed 2026-10)

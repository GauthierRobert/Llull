# llull build board — single source of truth for "continue working"

This file is **state**. The `continue-working` skill reads it, reconciles it against the
actual repo, launches parallel agents for the next eligible tasks, and writes it back.
The user only ever has to say **"continue working"**. Humans may edit this file directly.

## Status tokens (line-start, machine-parsed)
- `[TODO]` not started · `[WIP]` an agent is on it now · `[REVIEW]` code done, awaiting `cad-reviewer` + `npm run check`
- `[DONE]` merged & green · `[BLOCKED]` needs a decision/dependency (see note) · `[REMOVED]` deliverable deleted by a later decision (see note)

## Conventions
- **Deps** reference other task IDs. A task is *eligible* only when every dep is `[DONE]`.
- **Lanes** own disjoint file sets (below) so parallel agents don't collide. One task per
  lane runs at a time. Default parallelism = **4 lanes** (+ Lane 5 review runs after each).
- The only shared file is `packages/core/src/commands/registry.ts` — **Lane 1 owns it**; no other
  lane edits it. Domain commands register through plugins (`src/app/plugins.ts`), not registry.ts.

## How parallel agents coordinate (they don't talk — they don't need to)
Agents are isolated; coordination is structural, run by the orchestrator:
1. Only the orchestrator writes this board; a task is flipped to `[WIP]` **before** its agent
   launches → the board is the live "who's on what" ledger. Agents never edit it.
2. Disjoint lane file-ownership means two agents **cannot** write the same file.
3. A `[WIP]` lane is busy → never re-assigned while in flight.
4. Cross-lane needs wait on `[DONE]` deps and read the result from **committed files** — the
   repo is the only channel between lanes.
5. `[REVIEW]` (cad-reviewer + `npm run check`, + merge if worktrees) is the backstop.

## Lane → agent → file ownership
| Lane | Agent | Owns (write scope) |
| ---- | ----- | ------------------ |
| 1 Core | `command-author` | `packages/core/src/**` (incl. `commands/registry.ts`, `model/types.ts`), `packages/domain-aec/src/**` |
| 2 3D+Shell | `viewport-engineer` | `src/ui/viewport/3d/**`, `src/ui/components/**`, `src/ui/panels/**`, `src/ui/store/**` |
| 3 2D | `viewport-engineer` | `src/ui/viewport/2d/**`, snapping/tracking helpers |
| 4 MCP | `mcp-engineer` | `packages/mcp/src/**`, `server/**`, kernels `packages/kernel-*/src/**` |
| 5 Review | `test-verifier` + `cad-reviewer` | `tests/**`; reviews every diff (not a blocking lane) |

---

## NOW (auto-updated by the skill; older entries: `git log -p .claude/work/BOARD.md`)
- **DRAWINGS + SHELL PASS DONE:** 2026-10-15 (branch `ccr-5785a5dd-qrof5b`) — NF3: `doc.drawings` sheets (ISO paper, title block, first/third angle) with live projection/section/detail views derived at export; 9 commands incl. read-only `export_sheet_svg`; load validation (ids `[A-Za-z0-9._-]`, SVG ids escaped after a cad-reviewer XSS finding), step counter scans sheet ids. VNF3: Drawing sheets tab + paper-space viewer (replaces the 3D/2D viewport while open). E3: locked layers enforced in UI picking/edits, Undo/Redo always in dock, extrude palette prefill fix, lens after 2D→3D, STL export. e2e `coreFlows` + `sheets` green. Follow-ups: dedupe AEC `shared/sheetFrame`+`drawingSvg` onto core `drawings/` painter; lock policy is UI-only (core edit commands ignore locks — decide for MCP/CLI); viewer doesn't surface `data.warnings` yet; sheet-placed dimensions beyond overall extents (EN5).
- **PRODUCTION-READINESS PASS DONE:** 2026-10-13 (branch `ccr-a6090b39-a9ccjg`) — 4-lane review (server/MCP security, UI, core fuzz, build/deploy/desktop) + cad-reviewer rounds. Server: security headers + CSP, `LLULL_TRUST_PROXY`, CSRF refusal on token-less reads, MCP eviction only on initialize, bounded Python queue / shared DWG limiter, per-client `/live` cap, children killed on shutdown, `/health` before Host allowlist, `opencascade.js` a server dep. Web: no lost offline work (local-copy offer, cleared once the outbox syncs), failed autosave surfaced, kernel status, resettable viewport boundary, SW wasm/HTML caching fixes. Core: untrusted documents fully validated on load (per-kind, history, collections, step counter) with a golden save/reload round trip so writers and loader never drift. Deploy: image `LLULL_PYTHON=off`, leaner context, CI builds web/server/image + Playwright e2e job; Electron permission policy + fuses; core/AEC chunks (main 1.48 MB -> 327 kB). Verified: check green (5483 tests), coverage gate, server suite, all 28 e2e, built app under the CSP with both kernels. Follow-up: base images digest-pinned + Dependabot, LibreDWG GNU-signature check, single-use `/live` tickets (no tokens in URLs; `?access_token=` deprecated), async audit reads + autosave writes; image built and run (health, CSP, auth, add_box, STL, STEP via OCC). Then: `LIBREDWG_SHA256` pinned (0.14 tarball verified against maintainer key 38A4…A7A2), `LIBREDWG_URL` mirror arg; CI `image` job builds the full image with LibreDWG and smoke-tests it; slow fixed-base design test given an explicit 120 s timeout (28 s under coverage, was flaking at 30 s). Decided: audit append stays synchronous (@invariant in server/src/audit.ts: audited before acknowledged, ~30 µs).
- **MODERNIZATION PASS DONE:** 2026-10-12 (branch `ccr-caf8ee33-mu01za`) — toolchain: ESLint 10 flat `eslint.config.js`, TypeScript 6 (tests type-check via `tests/tsconfig.json`), Vite 8 (Rolldown `codeSplitting`), Vitest 5, Express 5, React 19 + r3f 9 + drei 10, three r186, Node >= 22.12, Prettier pinned exactly; `npm run deadcode` (knip) joins `check` + CI. Code: one `<domain>/{catalog,plugin}.ts` per AEC domain; typed `mapSegment`/`map3`/`vec3At` instead of double casts; one box/wedge face source (fixes `render_view` inward winding: lit back faces, dark tops); units consolidated in `@core/model/units`; exhaustive kind switches; `@lib/*` alias lint-enforced. Verified: check green (5639 tests), coverage gate, server/desktop suites, all Playwright e2e. Deliberately not done: `TOOLSETS` stays an `@mcp` view (test-guarded); exchange-result regex unshaping in `server/src/exchangeResult.ts`; `fileSlug` vs `safeFileName` (different filenames). TypeScript 7 waits on typescript-eslint support (<6.1).
- **QUALITY LOOPS DONE:** 2026-10-08 — 5 parallel worktree loops (Q-CORE 45, Q-AEC 42, Q-3D 40, Q-2D 43, Q-MCP 40 iterations; 10-min cron) merged on `feat/quality-loops`, then cleanups A/B/C (cross-lane dedup: FOV const, text bounds, escapeXml, NumberField, duplicate_entities UI, stepEditGuard removed from UI) and 4 cad-reviewer fix rounds (D/E/F + outbox poisoning B1 `8fc3080`) -> merged to `main`. Verified: typecheck + lint clean; 290 files / 4758 tests; coverage 97.59/92.66/98.27/97.59; server tests green except 2 known env failures (python, symlink). NOT run (env): `npm run quality` / `test:e2e` / `production` — Python+CadQuery missing and Playwright chromium_headless_shell-1194 not installed (stale install lock). Open user decisions: 2D rotation semantics (a821d75), locked-layer behaviour, document-storage redesign (defer), AutoCAD mouse mapping.

## Open tasks (DONE/REMOVED pruned 2026-10-13; full history in git)

## Lane 2 — 3D viewport + UI shell (`viewport-engineer`)
- `[DONE]` **E3** Layers panel (visibility/lock) + undo/redo buttons + shortcuts. _deps: W0-2_

## Lane 5 — Tests & review (`test-verifier`, `cad-reviewer`) — continuous, non-blocking
- `[TODO]` **I1** Hold the `core/commands/**` 90/85/90/90 gate; happy + failure test per new command. _runs with every Lane-1 task_
- `[TODO]` **I4** `cad-reviewer` pass on every `[REVIEW]` diff before flipping to `[DONE]`.

## S — 2D sketch tools (Lane 1 cmd + Lane 3 render/interaction)
- `[TODO]` **S3** `hatch_region` (fill a closed loop with a pattern) + `region` entity. _Lane 1+3. deps: B1._

## X — Export / Import (Lane 1 serialization + optional Lane 4 endpoints)
- `[TODO]` **X3** 2D export DXF + SVG from 2D entities. _Lane 1/3. deps: B1._
- `[TODO]` **X4** Import: SVG path → 2D profile, STL → `mesh` entity. _Lane 1. deps: X1/X3._

## P — Performance (Lane 2/3, `viewport-engineer`)
- `[TODO]` **P5** (Stretch) WebGPU renderer opt-in behind a flag with WebGL fallback; verify drei helpers (Grid/Gizmo) degrade gracefully. _Lane 2. deps: P1. Re-evaluate only if P1–P4 leave a measured GPU bottleneck._

## Group 1 — KEY IMPROVEMENTS (foundation & robustness; front-load)
- `[TODO]` **KI7** Typed command/tool client bindings (DX): generate typed params/return bindings from the registry so callers (UI param forms, the example agent, tests) get compile-time safety instead of `unknown`. _Lane 1/4. deps: —. Acceptance: a generated typed surface used by ≥1 caller; no `any`; gate held. (Lower priority.)_

## Group 2 — NEW WANTED FEATURES (net-new product capability)
- `[DONE]` **NF3** Drawings & sheets (2D documentation from 3D): `create_drawing_view` (orthographic projection of a solid onto a sheet), `add_section_view`, `add_detail_view`; a `sheet`/paper-space concept with title block. _Lane 1 cmd + Lane 3 render. deps: M1; hidden-line ideally KI4 (mesh silhouette acceptable v1). PAIR(NF3↔VNF3). Acceptance: a box yields front/top/right views on a sheet; views update when the model changes._
- `[DONE]` **VNF3** Sheet/paper-space mode: render projected views + title block + sheet-placed dimensions. _Lane 3. deps: NF3._
- `[TODO]` **NF7** Direct face editing / push-pull: select a planar face → push/pull to add/remove material. _Lane 1 cmd + Lane 2 interaction. deps: KI4 (face topology). **STRETCH** — needs B-rep faces; defer if OCC deferred._

## Group 3 — ENRICHMENT OF EXISTING FEATURES (deepen Wave 1/2 surfaces)
- `[TODO]` **EN5** Associative dimensions + dimension styles: T2 dimensions reference live geometry so they update on edit; a dimension style (arrows, text height, precision from U1). _Lane 1 cmd + Lane 3 render. deps: T2. Acceptance: moving a referenced endpoint updates the dimension value._
- `[TODO]` **EN6** 2D polyline/spline editing & richer modify: add/remove/move vertex, convert line↔arc segment, join/close, multi-pick `offset`/`trim`/`extend` (extends S2). _Lane 1 cmd + Lane 3. deps: B1, S2. Acceptance: vertex edits dispatch through commands; gate held._
- `[TODO]` **EN7** Continuous measure mode + measurement report: snap-aware chained measuring with running totals; export a structured measurement report in `data`. _Lane 1 cmd + Lane 2/3 HUD. deps: M1, M2. Acceptance: chained picks accumulate distance; report returns structured `data`._
- `[TODO]` **EN11** Layer enrichment: layer color/linetype/lineweight, layer filters/groups, per-drawing-view layer overrides (ties to NF3). _Lane 1 cmd + Lane 2 panel. deps: L1, L2. Acceptance: entity inherits layer color unless overridden; gate held._
- `[TODO]` **EN12** Export fidelity & scope: export-selection-only, batch export, glTF/OBJ with materials (NF4), DXF layer mapping. _Lane 1/2. deps: X1–X3, NF4. Acceptance: exporting a selection with materials produces a valid file carrying material/layer data._

## Pillar 2 — Camera control (Lane 1 command + Lane 2 viewport, PAIR)
- `[TODO]` **W5B** Camera-control command(s): `set_camera` / `look_at` / `fit_view(direction, padding)` writing `document.camera`, and make the viewport **react to `document.camera` changes** (today `ViewPresetsInner` reads `cam` only at initial mount, so an MCP camera change is ignored live). _Lane 1 cmd + Lane 2 viewport (PAIR). deps: —. Acceptance: an MCP agent frames the model deterministically (front/iso/top + fit-all with padding) with no UI click or wheel hack; camera changes broadcast over SSE move the live camera; flagged `readOnly`/meta as appropriate so it doesn't pollute feature history._

## AERO — Aerospace story, five steps (`docs/aerospace/README.md` § Aerospace story)
- `[DONE]` **AERO-1** One mass and density truth: 08 M1 `resolveDensity` (TR-MAT-10) read by `mass_properties` and dynamics; unit-correct mass (`massG/Kg/Lb`, `massUnit`), density `{ value, unit }`, `create_material.densityUnit`; named sources + `unverified` (AF-31/32). VC-MAT-01, 03, 04 a–c/e, 22 (legacy row). Done 2026-10-17 (08 TECHNICAL_SPEC §13). _Lane 1. deps: PHY-01 (done)._
- `[DONE]` **AERO-2** Exact kernel on the bundled OCCT 7.4 binding: 01 M1 (`kernel_info`, `set_modeling_tolerance`, OCC desktop default, provenance), M3 (exact part-frame mass properties, `resolveMassProperties`, principal axes, dynamics on it), M10 (`FaceQueryPort` + `inspect_faces`), M4 MVP (v3 envelope + blobs, `brep` leaf, `import_step_exact` with healing). Done 2026-10-17 (01 TECHNICAL_SPEC §13.A–C), cad-reviewer fixes applied. Open: STEP text in step params (blobId follow-up), `heal_shape` / `validate_shape` (M5), XDE names/colours, UI kernel badge, CLI `--kernel occt` default. _deps: AERO-1 (done)._
- `[BLOCKED]` **AERO-2-M2** Custom OCCT 7.9.x WASM build with exceptions (01 TR-KRN-02). _deps: decision 2 (owner approval: stack change, Emscripten toolchain, 4–6 eng-weeks)._
- `[TODO]` **AERO-3** Real parts, real materials: 07 FTR, 08 M2–M5 (records on PHY-01 models), PROP-08, MATL-M4b, `check_materials`. _deps: AERO-2; decision 1 (package layout)._
- `[TODO]` **AERO-4** Supply-chain ready: 03 GDT, 04 XCH (AP242), 09 PLM (`HumanSignaturePort` impl → `dispose_*`, VNV-M3). _deps: AERO-3._
- `[TODO]` **AERO-5** Engineering depth: 05 FEA-REST, 02 SRF, 06 CMP. _deps: AERO-2 (AERO-3 for materials)._

## PHY-00 — Physics V&V harness (`docs/physics/00-vv-harness/`)
- `[DONE]` **VNV-M1** `lib/convergence.ts` (observed order, Richardson, GCI, classification, required / representative spacing), `lib/quantity.ts` (unit grammar), `check_convergence` + `compare_to_expected` (core `commands/vnv/`, toolset `analysis`), expected-results schema + 05 adapter. Done 2026-10-16 (branch `ccr-a7b1e46b-1dp1n9`); deviations in TECHNICAL_SPEC §13.
- `[DONE]` **VNV-M2** `llull run_benchmarks` (server/src/cli/benchmarks.ts) + `npm run quality:physics` (unit-test measurements via `LLULL_PHYSICS_MEASUREMENTS`). Gate green: 26 VC-VNV + 81 VC-PROP pass.
- `[BLOCKED]` **VNV-M3** `run_convergence_study`, `record/delete_convergence_study`, `check_verification`, `accept_verification_exception`. _deps: 05 FEA analysis slice + artifact store (aerospace pack, not built), 09 PLM signing port._
- `[TODO]` **VNV-M4** (V1) time-step / order refinement, least-squares order (VC-VNV-22), production scenario, UI panel. _deps: VNV-M3, PHY-03/09._

## PHY-01 — Property models (`docs/physics/01-property-models/`)
- `[DONE]` **PROP-M1…M5** types + catalogue, forms / range guard / consumer API (`model/propertyModelEval.ts`), `define/remove_property_model`, `evaluate_property`, `sample_property` (integral, solver table), `fit_property_model` (QR), `check_property_models`; toolset `materials`. Done 2026-10-16; models hang off `Material` until 08 MAT exists (TECHNICAL_SPEC §13).
- `[BLOCKED]` **PROP-M6** seed NIST library. _deps: access to trc.nist.gov (OQ-PROP-03); 08 MAT library files._
- `[BLOCKED]` **PROP-08** move models onto the 08 `MaterialRecord`, TR-PROP-07 adapter, private libraries (VC-PROP-22). _deps: 08 MAT._

## 05 FEA — minimal slice (`docs/aerospace/05-fea-cae-handoff/`)
- `[DONE]` **FEA-MIN** core analysis types + ports, `packages/domain-cae` plugin, set-up commands, INP writer, FRD/DAT readers, record commands (artifact-validated), `fea_report`, `check_analysis`, server `fea_mesh` (Gmsh) / `fea_solve` (ccx) / `fea_export`, artifact store. Done 2026-10-16 (TECHNICAL_SPEC §13).
- `[TODO]` **FEA-REST** modal, buckling, shells, margins, BDF/OP2, face map (needs 01 face query), UI panels.

## PHY-02 — Constitutive models + material-point driver (`docs/physics/02-constitutive-models/`)
- `[DONE]` **MATL-M1…M6** `MaterialModel` union + durability variants + law catalogue (`model/materialModel*.ts`, `model/materialLaws/**`), `add/remove_material_model`, `define_constitutive_set`, `check_material_models` (toolset `materials`), `fit_material_model` (linear), `material_point_response` (J2 / Chaboche / RO / hyperelastic / Prony / creep), `export_material_cards` (CalculiX; Nastran MAT1+MATS1) in core `commands/materiallab/` (toolset `material-lab`). Done 2026-10-16 (branch `ccr-5fde98b7-32ge5q`): 107/107 VC-MATL pass; deviations in TECHNICAL_SPEC §13.
- `[BLOCKED]` **MATL-M4b** 05 deck-writer `MaterialCardWriter` hook, `FeaConstitutiveView`, ccx / pyNastran read tests. _deps: 05 FEA, server Python test infra._
- `[TODO]` **MATL-M7** (V2) LM fits, compressible hyperelastic driver, Hill-48, MFront (licence review OQ-MATL-05).

## PHY-03 — Thermal analysis (`docs/physics/03-thermal-analysis/`)
- `[DONE]` **THM-A** `thermal_analytic_check`, thermal units, `compute_view_factors` (V1-a + V1-b obstruction, explicit polygons) in core `commands/thermal/` (toolset `analysis`). Done 2026-10-16: VC-THM-01, 02, 06–13, 60 pass; deviations in TECHNICAL_SPEC §13.
- `[DONE]` **THM-M0…M3, M4 decks** on the minimal 05 slice (`packages/domain-cae`, Proposal B, `docs/physics/FE_PIPELINE_DESIGN.md`): set-up commands, decks, summary + heat balance, `thermal_report`, `check_thermal`, `check_temperature_limits`, `dispose_thermal_limit` (refused until 09 PLM). Done 2026-10-16: VC-THM-01, 03, 04, 05, 14, 50, 61–63 through real Gmsh + ccx.
- `[DONE]` **THM-V1** contact conductance deck (VC-THM-11 FE), orthotropic k, steady h(T) film, VC-THM-30 measured (ccx F12 0.199834 vs 0.199825). Open: ε(T) (needs PHY-15), render_view temperature, `llull guide` section.

## PHY-04 — Thermo-mechanical & fits (`docs/physics/04-thermo-mechanical/`)
- `[DONE]` **TMC-M1** `fit_at_temperature` (+ Lamé), `thermal_stress_check`, CTE conversions in core `commands/thermomech/` (toolset `analysis`). Done 2026-10-16: VC-TMC-01, 03–09, 62 pass. VC-TMC-09.b/c generator aligned with §5.3 (owner-approved).
- `[DONE]` **TMC-M2…M3** `thermo_static`, `set_reference_temperature`, `set_temperature_field`, decks, `check_thermo_mechanical`, `thermal_distortion_report`, `dispose_fit_result` (refused until 09 PLM), staleness chain, `lib/expression` move. Done 2026-10-16: VC-TMC-01, 02 (LE11), 05, 08, 50, 60, 61, 63 through real Gmsh + ccx.
- `[DONE]` **TMC-M4a** `compute_margins` (05 §5.8) + VC-TMC-50 in full, `fea_import_field`, steady coupled procedure (`coupled_temperature_displacement`), mesh mapping (`mapping: interpolate`). Done 2026-10-17 (PHY-04 TECHNICAL_SPEC §14).
- `[TODO]` **TMC-M4b** transient coupled step, orthotropic CTE, fit stack-ups, bimetal FE.

## PHY-21 — Functional digital prototype (`docs/physics/21-functional-prototype/`)
- `[DONE]` **FPR-A** Buildability gate (FUNCTIONAL_SPEC §5.1, TECHNICAL_SPEC M1 + joint realisation): kernel `analyze`/`distance` (both kernels) + face axes, `meshBvh`, `check_assembly` (validity, pairs, connectivity, ray thickness, process table, joint realisation), `doc.prototype` intents/grounding, `allow_interference` / `remove_interference_intent` / `set_part_grounded`; VC-FPR-01…09. _Lane 1+4. Done 2026-10-16 (merged 930fca4c): adds status `info`, codes `FPR_NO_PARTS`, `FPR_STALE_REFERENCE`, `FPR_JOINT_REALISED`, `FPR_WALL_MEASURED`; joint realisation OCC + dynamics revolute joints only; inputsHash = FNV-64 of canonical JSON (no sha256 in core)._
- `[DONE]` **FPR-B** Physically connected mechanism (FUNCTIONAL_SPEC §5.2, TECHNICAL_SPEC M2 + M3): closed loops + `spherical`, MJCF `connect`, solver settings, reactions + residual, mobility in `inspect_dynamics`, `FPR_LOOP_OPEN`; `add_cylinder_pressure` (table, Wiebe, single-zone), engine report, `engine_quick_check`; VC-FPR-10…17, 20, 21. Brake calibration (`calibrate_brake`) waits on FPR-E losses. _Done 2026-10-16 (merged 430ae1e1, review fixes afd185a3): energy closure from the simulated side; `data.engineReport`; `anchorOnChild`; firingOffsetDeg 0|360; codes FPR_SPHERICAL_TREE / FPR_JOINT_DANGLING / FPR_PRESSURE_MODEL_INVALID. Open: auto timestep vs light parts at low rpm (loop tier fails, owner to decide)._
- `[TODO]` **FPR-C** `check_motion_clearance`. _deps: FPR-A, FPR-B._
- `[TODO]` **FPR-E** Realism (M3b): accuracy envelope, sourced materials, losses, brake calibration, gear efficiency, propeller table, references. _deps: FPR-B._
- `[TODO]` **FPR-D** Review tab wiring + `check_prototype` + dispositions (no sign-off in the MVP, §11 Q5). _deps: FPR-A…E, FPR-UI2._
- `[DONE]` **FPR-UI1** `SeriesChart` (generalises `SpeedChart`), `TimelineDock` (cursor, time/crank axis in `dynamicsPlaybackStore`), Okabe-Ito tokens. _Lane 2, `src/ui` only. deps: —._
- `[DONE]` **FPR-UI2** Review tab on fixtures: `ReviewPanel`, `ReadinessChecklist`, `FindingsList`, `ExplainDrawer` against the §3.4 envelope; "fail (accepted)", no sign-off bar. _Lane 2, `src/ui` only. deps: FPR-UI1 Done 2026-10-16: tab hidden until `check_prototype` is registered; disposition controls disabled until `set_review_disposition` exists; re-runs the check after each disposition (cheaper join needs `doc.prototype`)._
- `[TODO]` **FPR-MJ** MuJoCo 3.14.0 → 3.16.0 (§11 Q7), re-run VC-FPR-10…17. _deps: FPR-B._

## Pillar A — Procedural / computed geometry (Lane 1 cmd + Lane 2 render) — HIGHEST LEVERAGE
- `[DONE]` **VPG2/VPG3** Render branches / draw affordances for involute + chain-path entities. _Lane 2/3. deps: PG2 (involute renders today as a `polyline` — VPG2 = tangent/normal overlay polish) / PG3._ _VPG2 done 2026-10-16: involutes detected by `inv-` id prefix (no marker in core); follow-up: an explicit involute marker in `draw_involute`. VPG3 (chain path) still open._

## Done / removed task ids
W0-1 · W0-2 · A1 · A2 · A3 · A6 · A4-core · A4-ui · R1 · A5 · B1 · B2 · B3 · H1 · H2 · C1 · C2 · C3 · E1 · E2 · D1 · D2 · D3 · F1 · F2 · F3 · G1 · G2 · G3 · I2 · I3 · W1 · N0 · N1 · VN1 · N2 · VN2 · K1 · K2 · K3 · U1 · U2 · U3 · U4 · S1 · VS1 · S2 · VS2 · S4 · T1 · VT1 · T2 · VT2-nits · VT2 · M1 · M2 · L1 · L2 · Q1 · Q2 · Q4 · Q3 · VQ · X1 · X2 · JX · P1 · P2 · P3 · P4 · V1 · V2 · V3 · V4 · J1 · J2 · J3 · AI1 · AI2 · AI3 · AI4 · AI5 · AI6 · KI1-followup · KI1 · KI2 · KI3 · KI4 · KI5 · KI6 · NF1 · VNF1 · NF2 · NF4 · VNF4 · NF5 · NF6 · VNF6 · EN1 · EN2 · EN3 · EN4 · EN8 · EN9 · EN10 · W4A · W4B · W4C · W4D · W4E · W4H · W4F · W4G · W5A · W5B-cmd · W5B-viewport + VN2 · W5C+W5G · W5G-coast · W5D · W5E · W5F · W5H · PG1 · PG2 · PG3 · VPG1 · KN1 · KN2 · MG0.1 · MG0.2 · MG0.3 · MG0.4 · MG1.1 · MG1.2 · MG1.3 · MG1.4 · MG1.5 · MG2.1 · MG2.2 · MG2.3 · MG2.4 · MG3.1 · MG3.2 · MG3.3 · MG4.1 · MG4.2 · MG4.3 · MG4.4 · MG4.5 · MG5.1 · MG5.2 · MG5.3 · MG5.4 · MG6.1 · MG6.2 · MG6.3 · MG6.4 · MG6.5

## Decision log (resolve `[BLOCKED]` items here)
- **RESOLVED 2026-10-02 (user approved all recommendations) — D1 schema library (MG2):** zod v4 (built-in `toJSONSchema`, already a transitive dep via `@modelcontextprotocol/sdk`) vs TypeBox. Recommendation zod. New dependency ⇒ needs explicit user approval (CLAUDE.md STACK).
- **RESOLVED 2026-10-02 (user approved all recommendations) — D2 npm workspaces monorepo (MG6.1):** recommendation yes.
- **RESOLVED 2026-10-02 (user approved all recommendations) — D3 OCC WASM on the server (MG1.4):** ~63 MB, slow cold start; needed for kernel parity between UI and MCP. Recommendation yes, behind `LLULL_KERNEL`.
- **RESOLVED 2026-10-02 (user approved all recommendations) — D4 document format v1 → v2/v3 with auto-migration on load, no v1 writer (MG3.2, MG4.2):** recommendation yes.
- **RESOLVED 2026-10-02 (user approved all recommendations) — D5 feature freeze on new domain commands during MG1–MG4:** recommendation yes.
- **A4 boolean CSG library:** RESOLVED 2026-05-25 → **manifold-3d (Manifold)**. Robust watertight mesh booleans (WASM). Behind a `GeometryKernel` interface (L9) so OpenCascade.js can replace it later for exact B-rep/STEP. Mesh-based results stored as a new `mesh` solid kind.
- **In-app AI bridge:** REMOVED 2026-05-25 (user decision: "only MCP will be used"). Deleted `src/core/ai/**`, the Express `/api/ai` proxy + `anthropicClient.ts`, the chat panel (`ChatPanel`/`useAiChat`/`chat.css`), and the `@anthropic-ai/sdk` dependency. AI control is now delivered solely through the MCP host (`/mcp`). Architecture rules updated: L1 is now "two callers" (UI + MCP). Tasks F1/F2/F3 → `[REMOVED]`.
- **OPEN — kernel capability for K1/K2/K3 (fillet/chamfer/shell):** Manifold (current kernel) does mesh booleans well but has **no robust edge fillet/chamfer or shell**. These need either (a) an OpenCascade.js B-rep kernel swapped in behind the existing `GeometryKernel` interface (L9) — large WASM, slow init, but the "real CAD" path that also unlocks STEP export, or (b) mesh-approximation fillets (lower quality). Decide before scheduling K1/K2. Sweep/loft (K3) are achievable mesh-side. **Default recommendation: defer K1/K2 until an OCC kernel is justified; build N0–N3, sweep/loft, and the rest of Wave 2 first.**
- **OPEN — WebGPU (P5):** stay on WebGL until P1–P4 leave a *measured* GPU bottleneck; the renderer is an isolated `ui/` swap (two `<Canvas>` call sites), so deferring costs nothing.
- **OPEN — OCC kernel adoption (Wave 3 KI4, supersedes the K1/K2/K3 caveat):** the Wave 3 `KI4` spike decides adopt-vs-defer for OpenCascade.js behind the `GeometryKernel` interface (L9). Adopting unlocks fillet/chamfer/shell (K1/K2), STEP/IGES (NF5), and face topology for push-pull (NF7); cost is large WASM + slow init. Decide from the spike before scheduling NF5/NF7/K1/K2.
- **INFO — Wave 3 scope boundary:** real-time collaboration, simulation/CAE, and CAM/fabrication remain "Later" (see `docs/ROADMAP.md`) and are intentionally **out of Wave 3** to keep the wave shippable. Revisit after assemblies + drawings land.

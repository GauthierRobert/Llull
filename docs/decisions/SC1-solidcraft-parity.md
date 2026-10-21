# SC1 — Parity with SolidCraft on the CAD core

Status: proposed 2026-10-19 (owner asked: "create a plan so we are at the same level, and take all the good ideas").
Reference: [tangency-labs/solidcraft](https://github.com/tangency-labs/solidcraft) (Rust, egui + wgpu, MIT/Apache-2.0), read at
`main` on 2026-10-19. Related: LC1 (local only), RS1 (native compute, native OCCT `llull-kernel`), KI7 (native kernel default).

Ideas only: no SolidCraft code, data or test files are copied. Its reference cases are re-described as llull plans, with
expected values recomputed from formulas or FreeCAD.

## Where we stand

llull covers much more ground (AEC, CAE/FEA, aero, dynamics, code exchange, a STEP quality corpus, drawings, `.lld`).
SolidCraft goes deeper on the **mechanical part-modelling core**, and above all on **proving that core is right**:

| Area                     | SolidCraft                                                                                                                                                                    | llull today                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Face/edge references     | Named from the kernel's own history (`history.rs`, `lineage.rs`); a lost reference gives a warning, never a silent re-attach                                                  | Recorded pick points, matched to the nearest edge (`brep/edgeSelection.ts`): geometric guessing                                    |
| Sketch solver            | Constructive placement (Owen 1991, Fudos–Hoffmann 1997), then Levenberg–Marquardt; DOF from the Jacobian rank; over-constraint refused; ~14 constraint and 11 dimension kinds | Fixed-step gradient descent, 6 kinds (`parametric/constraintSolver.ts`); no DOF, no over-constraint detection                      |
| Correctness proof        | 83 reference parts (62 analytic, 21 FreeCAD) checked on volume, area, centre of mass, bbox, faces, surface distance; STEP round-trip of each                                  | Golden snapshots (detect change, not error); `quality:drawings` (mass on 21 parts); STEP import corpus                             |
| Regression net           | Action matrix: every action on every face/edge/vertex/body of real designs, baseline ratchet, nightly shards, determinism run                                                 | `fuzzCommands.test.ts`: garbage params only                                                                                        |
| Kernel robustness        | Seeded random designs, solidity + volume-direction checks per step, boolean identities, `fuzz-one --minimise`                                                                 | None                                                                                                                               |
| Test strength            | Mutation testing judged by kernel-independent suites only (ready for a kernel swap)                                                                                           | None (and we are swapping kernels: Manifold/WASM → native OCCT)                                                                    |
| Never lose work          | Atomic save + `<file>.bak`, kill-mid-save test, autosave + recovery prompt, old-format corpus, local crash reports with reproducer                                            | Atomic save + autosave (`server/src/writeFileAtomic.ts`, `autosave.ts`); no `.bak` policy, no old-file corpus, no crash reproducer |
| Agent guidance for users | `skills/solidcraft-{modeling,editing,checking,mechanisms}` shipped for users' own agents                                                                                      | `llull-cli` / `design-model` live in `.claude/` for repo developers only                                                           |
| Feature listing          | `docs/features.md` generated from the registry                                                                                                                                | Hand-written docs                                                                                                                  |

Not taken (against LC1 or not better than ours): web/WASM build, MCP server, browser command API, WASM component plugins
(`CadPlugin` already covers it), egui front end.

## Plan

Each task is one PR (or a few), with its tests, `npm run check` green. Ids are on `.claude/work/BOARD.md`. A task that touches
an area llull may already partly cover starts by checking what is there and noting the gap in its PR.

### Phase A — Prove what we have (first: it catches regressions from the native kernel switch)

- **SC-Q1 Reference parts.** `tests/oracle/<nn-name>/{plan.json, expected.json}`: a `build_project` plan plus expected body count,
  volume, area (rel. 1e-3), centre of mass and bbox (1e-3 of size), face count where fixed. Sources: `analytic` (formulas in
  `tools/oracle-analytic/`, Python) or `freecad <version>` (`tools/freecad-oracle/`, FreeCAD's Python API run as an external
  program; never a dependency). Each part also exported with `export_step_ap242` and re-imported, and compared again. Target: 40
  cases first (prisms, cylinders, cones, spheres, tori, Pappus revolves, constant and variable fillets, shells, holes, sheet-metal
  bends), then 80+. `npm run oracle` writes `docs/ORACLE.md` (case table + pass count); CI runs it on the native kernel.
- **SC-Q2 Action matrix.** For each design of a corpus (oracle parts + golden plans + `quality/drawings`), try every applicable
  command (fillet/chamfer each edge, shell/draft/hole on each face, booleans per body pair, patterns, mirror, move) with the
  params the UI sends. `tests/action_matrix/baseline.json` is a ratchet: passed before, fails now ⇒ test fails;
  `--bless` rewrites it. PRs run a stable 1-in-N sample; full matrix nightly in shards with a cost file; a determinism job runs
  a sample twice.
- **SC-Q3 Robustness fuzz.** `llull fuzz --from --count --jobs --out --report` and `llull fuzz-one <seed> --minimise`. Seeded
  generator on a 2.5 mm grid (box / extruded profile / revolve, then up to 8 joins, cuts, fillets, chamfers, shells, holes,
  patterns), checking after each step: success, every body a closed oriented solid with positive finite volume, cut never adds and
  join never removes volume. Plus boolean identities on random primitives: V(A∪B)+V(A∩B)=V(A)+V(B), V(A−B)=V(A)−V(A∩B) within
  0.2 %. Failing seeds become golden plans.
- **SC-Q4 Mutation testing.** Stryker over `packages/core/src/commands/{brep,solids,parametric,history}`, judged only by the
  oracle suite + golden corpus + the fuzz sample (not unit tests that touch kernel internals). Report surviving mutants in
  `docs/MUTATION.md`; nightly, not a PR gate.
- **SC-Q5 Generated feature list.** `npm run features` writes `docs/FEATURES.md` from `listCommands()` grouped by toolset;
  `npm run check` fails when it is stale.

### Phase B — Core modelling correctness

- **SC-N1 Persistent naming from kernel history.** Native kernel reports, per operation, each result face's origins (generated /
  modified / deleted, from OCCT `BRepTools_History` / `BRepAlgoAPI_*::Generated|Modified`) and each edge's origin edge or the
  faces whose meeting made it. A pure core module composes the history into stable names (`<step>:<role>:<source>` e.g. sketch
  curve side, cap, revolve section, blend, shell inner wall, pattern copy). Fillet/chamfer/shell/hole/sketch-on-face store
  names; points stay as a fallback for kernels without history (Manifold), flagged unverified. Port change: `GeometryKernel`
  gains an optional `history` on results (L9 stays: still a recipe in, handle out).
- **SC-N2 Lost-reference reporting and repair.** When a name resolves to 0 or >1 entities after an upstream edit, the step keeps
  its last result, reports `REF_LOST` / `REF_SPLIT` in `summary` and `check_model`, and an `edit_step_params` path to re-pick.
- **SC-S1 Sketch solver rewrite (TS, pure, in core).** Constructive pass (fixed points, loci intersections, rigid clusters) on
  the branch the sketch already has, then Levenberg–Marquardt on the rest; DOF = unknowns − rank(J); over-constraining
  `add_constraint` refused with the conflicting set; `solve_constraints` returns `data.dof` and per-entity fully-constrained
  flags (UI draws them black). Edits that would flip a sketch are refused. Stays in TS: it runs inside pure commands, sketch
  sizes are small; revisit Rust (`llull-compute`) only on a measured bottleneck (C7).
- **SC-S2 Constraint and dimension breadth.** Add: horizontal, vertical, equal, concentric, collinear, midpoint, symmetric, fix,
  point-on-curve, curvature (G2); dimensions radius, diameter, aligned, horizontal, vertical, point-to-line, arc sweep, arc
  length, slot length — all parameter-driven (`=expr`).
- **SC-S3 Sketch planes and linked geometry.** Sketch on offset planes and on planar faces (attached by SC-N1 name), project /
  intersect edges into a sketch as linked geometry with a lost-link warning and "break link".

### Phase C — Feature depth (check existing coverage first; each item is happy + failure + oracle case)

- **SC-F1** Draft (neutral plane, pull direction), split body / split face by plane or face, replace face, push-pull (= BOARD
  NF7, now on SC-N1 names).
- **SC-F2** Holes placed on sketch points; modelled ISO threads M3–M20 (beyond cosmetic `set_thread`); coil.
- **SC-F3** Thin extrude (open/closed profiles, centre/inside/outside), per-edge and variable-radius fillets, chord-length fillets.
- **SC-F4** Joint coverage check vs SolidCraft (rigid, revolute, slider, cylindrical, pin-slot, planar, ball, cam), closed-loop
  driving, contact sets stopping motion, exploded views.

### Phase D — Files and never lose work

- **SC-D1** Save keeps the replaced file as `<file>.bak`; a test kills the backend mid-save (25 runs on a 0.5 MB doc) and the
  file is always the old or the new one.
- **SC-D2** Old-document corpus `tests/corpus/documents/` (v1, v2, v3 files saved by earlier builds) that must load and evaluate
  as saved; damaged variants (truncation, bit flips, hostile values, deep nesting) never throw past `load_document`.
- **SC-D3** Local crash reports: on an uncaught error the backend/desktop writes `<data dir>/llull/crashes/<ts>/` with the
  document, the command log that reproduces it and the error; `llull crashes list|show|dir`; Help → Crash Reports opens a
  reviewed GitHub issue draft (nothing sent automatically, AF-41 offline unaffected).
- **SC-D4** Exchange gaps: STEP AP242 export with body names, colours and assembly structure; 3MF export; URDF export of joints;
  IGES import/export check; mesh → solid reconstruction for constant-section parts.

### Phase E — Agents and UX

- **SC-A1** User-facing agent skills: `skills/llull-{modeling,editing,checking,mechanisms}/SKILL.md` for users' own agents
  (plan as numbers, build in few `build_project` calls, verify each stage with `measure_*` against self-computed values, known
  traps), installed by `llull skills install` and shipped with the desktop app.
- **SC-A2** Live previews for feature dialogs and drag manipulators (extrude distance, fillet radius, shell thickness) with
  automatic join/cut; on-canvas value boxes.
- **SC-A3** 3D mouse (3Dconnexion HID / spacenavd) in the desktop app: pan, zoom, orbit, per-axis invert and speed.
- **SC-A4** Feature errors offer a reviewed issue draft (with SC-D3's reproducer).

## Order and size

A (Q1 → Q3 → Q2 → Q5 → Q4) runs first and in parallel with RS-1 follow-ups; it protects the kernel switch. B needs the native
kernel default (LC1 step 1) for N1; S1/S2 do not and can start now. C and D after their B prerequisites; E any time.

| Task                  | Lane                                                | Deps              |
| --------------------- | --------------------------------------------------- | ----------------- |
| SC-Q1, SC-Q3, SC-Q5   | 1 (core/tests) + 4 (CLI for `llull fuzz`, `oracle`) | —                 |
| SC-Q2                 | 5 + 4                                               | SC-Q1             |
| SC-Q4                 | 5                                                   | SC-Q1, SC-Q3      |
| SC-S1 → SC-S2 → SC-S3 | 1 + 3                                               | SC-S3 also SC-N1  |
| SC-N1 → SC-N2         | 1 (kernel + core)                                   | LC1 step 1        |
| SC-F1…F4              | 1 + 2                                               | SC-N1 (F1), SC-Q1 |
| SC-D1, SC-D2, SC-D3   | 4                                                   | —                 |
| SC-D4                 | 1 + 4                                               | —                 |
| SC-A1                 | docs + 4                                            | —                 |
| SC-A2, SC-A3, SC-A4   | 2                                                   | SC-D3 (A4)        |

Done when: the oracle suite has ≥ 80 cases all passing on the native kernel, the action matrix and fuzz run nightly with a
ratchet, fillets/sketches survive the upstream-edit cases SolidCraft documents (split, merge, mirror, shrink a face) by name, the
sketch solver reports DOF and refuses over-constraint, and a killed save never loses a file.

## As built (2026-10-20, branch `feat/sc-parity`)

| Task     | What exists                                                                                                                                                                                                                                                | Verified                                                                                            | Open                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-Q1    | `tests/oracle/` 115 analytic cases (generator `tools/oracle-analytic/`, Node; FreeCAD stub only), `npm run oracle` → `docs/ORACLE.md`                                                                                                                      | Manifold 98/98 pass, 0 known failures                                                               | 17 OCCT-only cases + STEP round trip need the native binary; FreeCAD-sourced cases                                                                                                       |
| SC-Q2    | `tests/action_matrix/` (165 designs, 4821 actions), baseline ratchet per kernel, PR sample, nightly shards + determinism                                                                                                                                   | Manifold column: 2793 ok, 0 error                                                                   | `occt` column empty until the binary runs `--native --bless`                                                                                                                             |
| SC-Q3    | `llull fuzz` / `fuzz-one --minimise` (`packages/protocol/src/fuzz`), 20-seed sample in `npm test`                                                                                                                                                          | 3000 seeds; 2 boolean bugs found and fixed (tangent / sliver results)                               | fillet / chamfer / shell steps need the native kernel                                                                                                                                    |
| SC-Q4    | Stryker (`npm run mutation`), judged by oracle + golden + fuzz + matrix; nightly workflow                                                                                                                                                                  | history 28.0 %, parametric 35.5 % (`docs/MUTATION.md`)                                              | brep / solids folders; new judges for the survivor clusters                                                                                                                              |
| SC-Q5    | `npm run features` → `docs/FEATURES.md`, staleness contract test                                                                                                                                                                                           | yes                                                                                                 | —                                                                                                                                                                                        |
| SC-S1/S2 | constructive + Levenberg–Marquardt solver, DOF, conflict / redundancy / flip refusal, 25 constraint and dimension kinds, per-cluster solve                                                                                                                 | unit + golden + precision + perf tests                                                              | rigid clusters in the constructive pass; G2 only arc–arc                                                                                                                                 |
| SC-S3    | `create_sketch_plane` (world / face + offset + spin), `place_on_sketch_plane`, `project_edges_to_sketch` (linked, by name), `break_sketch_link`; `extrude_profile plane`                                                                                   | fake-kernel + Manifold tests                                                                        | owner 2026-10-20 ("do the best", replay of older files may change): a drawn source now extrudes along its own work plane (inherits its rotation) unless rotation / axis / plane is given |
| SC-N1    | face names in the native kernel (`cpp/naming.*`: roles at creation, OCCT history through every op), edge names from adjacent faces; core resolves / records names (`CommandResult.recordExtras`) for fillet, chamfer, face ops, sketch planes, projections | fake-kernel tests (renumbering, plans); native `naming_tests` (11) green on Windows/MSVC 2026-10-20 | —                                                                                                                                                                                        |
| SC-N2    | REF_LOST / REF_SPLIT refusals with re-pick hint during regeneration; `check_model` reports steps that no longer apply and lost sketch links                                                                                                                | unit tests                                                                                          | a failed step leaves the model without it (no "keep last result")                                                                                                                        |
| SC-F1    | `draft_faces`, `push_pull_face`, `split_face`, `replace_face` (one `faceOp` node), `split_body` (booleans, any kernel)                                                                                                                                     | split_body on Manifold + oracle; native face-op suites + oracle cases green (2026-10-20)            | replace_face only onto parallel planes                                                                                                                                                   |
| SC-F2/F3 | holes on sketch points, ISO M3–M20 tapped / external threads, `add_coil`, thin extrude, per-edge / variable / chord fillets (native `radii` laws written)                                                                                                  | oracle + unit tests; native fillet-law suite + oracle 104 green (2026-10-20)                        | external thread is a faceted groove on OCCT too (oracle 106 known failure)                                                                                                               |
| SC-F4    | joint kinds rigid … cam, closed-loop solve, contact sets, exploded views                                                                                                                                                                                   | Freudenstein / slider-crank / cam analytic tests                                                    | cam knife-edge only; AABB contact                                                                                                                                                        |
| SC-D1–D3 | `.bak` on every save (atomic, Windows retries), 25-run kill test; v1–v3 corpus + 327 damaged variants; crash reports + `llull crashes` + Help → Crash Reports                                                                                              | yes                                                                                                 | power-loss (fsync) untested                                                                                                                                                              |
| SC-D4    | AP242 schema, `export_3mf`, `export_urdf`, `mesh_to_solid`, `export_iges` + `import_step_exact format iges`                                                                                                                                                | unit tests; native IGES round trip green (OCCT 7.9.2 rebuilt with TKDEIGES, 2026-10-20). Merge with feat/eng-depth (2026-10-21): one `export_iges` = the 04 XCH one (XDE writer, brep / faces modes, self-check, `data.iges`) plus `import_iges`; the SC-D4 `kernel.exportIges` port and its `exportIges` op were dropped; `import_step_exact format iges` kept (native `importShapes iges` = the XDE IGES reader) | —                                                                                                                                                                                        |
| SC-A1–A4 | user skills + `llull skills install`; live previews + drag manipulators; 3D mouse (WebHID); reviewed issue draft                                                                                                                                           | component tests, previews checked live                                                              | 3D mouse not tried on hardware                                                                                                                                                           |

Deviation from the plan: the native kernel names faces itself (C++ `Shape::names`, propagated with `BRepTools_History`) and reports
names in `topology`, instead of shipping raw history for core to compose; core owns resolution, recording and refusals.

# DEF — Validation pack

Proves a future implementation of [FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC.md](../TECHNICAL_SPEC.md).
"Validated" = every grade-A `VC-DEF-*` passes in an automated gate on the **native exact kernel** (OCCT 7.9.2 sidecar) and the
mesh-path cases also on Manifold and without a kernel, with every expected value taken from `expected_results.json`.

## 1. Contents

| File                                                                         | What                                                                                                                                                                                                                                          | How produced                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `deformLaws.mjs`                                                             | reference implementation of every law (twist, taper, bend, stretch, affine, Bernstein FFD, point push, flow on a cylinder, flow along an arc) + numerics (finite-difference Jacobian, Gauss–Legendre volume and area quadrature, seeded PRNG) | hand-written from TECHNICAL_SPEC §5            |
| `generate_analytic_refs.mjs`                                                 | closed forms for every case, each cross-checked numerically (`numericCheck` fields)                                                                                                                                                           | `node generate_analytic_refs.mjs`              |
| `generate_plans.mjs`                                                         | the `build_project` plans                                                                                                                                                                                                                     | `node generate_plans.mjs`                      |
| `generate_expected.mjs`                                                      | `expected_results.json` built from the data files (no hand-copied numbers)                                                                                                                                                                    | `node generate_expected.mjs`                   |
| `data/twist_cases.json`                                                      | box volumes / areas at 0, 90, 120, 180, 360°, cylinder identity, smooth-ramp area (numeric), region-end crease                                                                                                                                | generator                                      |
| `data/taper_cases.json`                                                      | linear / flat / smooth taper volumes, degenerate case, cylinder → cone frustum                                                                                                                                                                | generator                                      |
| `data/bend_cases.json`                                                       | bar volumes and fibre lengths (centred and offset neutral fibre), cylinder → torus (360°, 90°), fold limit, rigid continuation point                                                                                                          | generator                                      |
| `data/scale_stretch_cases.json`                                              | stretch in a region, volume-preserving stretch, sphere → prolate / oblate spheroid (areas), triaxial (volume), elliptic cylinder (perimeter by quadrature), mirror, singular factor                                                           | generator                                      |
| `data/ffd_cases.json`                                                        | identity and affine reproduction residuals, barrel volumes with exact Jacobian range and Bernstein bound, foldover lattice                                                                                                                    | generator                                      |
| `data/point_deform_cases.json`                                               | ΔV = d π r²/4, fold limit 25√5 r/96                                                                                                                                                                                                           | generator                                      |
| `data/flow_cases.json`                                                       | plate on a drum (outside / centred), overlap, flow along an arc = bend                                                                                                                                                                        | generator                                      |
| `data/point_vectors.json`                                                    | golden input → output points + det J for every law (TS ↔ C++ parity, TR-DEF-04)                                                                                                                                                               | generator                                      |
| `data/mesh_budget.json`                                                      | mesh-path edge-length bounds h = √(8 tol / M2)                                                                                                                                                                                                | generator                                      |
| `plans/baseline_twisted_bar_loft.json`, `plans/baseline_bent_bar_sweep.json` | **run on today's llull** (only existing commands)                                                                                                                                                                                             | `generate_plans.mjs`; measured 2026-10-22 (§4) |
| `plans/target_*.json`                                                        | the same intents and the analytic suite with the proposed commands                                                                                                                                                                            | `generate_plans.mjs`                           |
| `expected_results.json`                                                      | every VC: value, tolerance, unit, grade, source, `proves`, `cli`                                                                                                                                                                              | `generate_expected.mjs`                        |
| `sources.md`                                                                 | every external source, access method, what was taken, grade                                                                                                                                                                                   | —                                              |

Regenerate: `cd docs/design/01-body-deformation/validation && node generate_analytic_refs.mjs && node generate_plans.mjs && node generate_expected.mjs`
(Node ≥ 18, no npm dependencies; output is deterministic).

## 2. Real use cases

| #   | Use case                                                   | Benchmark                                                          | Why it matters                                                      | VCs               |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------- |
| UC1 | Twisted bars, blades, drill flutes, decorative balusters   | SOLIDWORKS Flex Twisting, Rhino Twist, Creo Twist [R1] [R14] [R10] | today only by lofting rotated sections (1.93 % area error measured) | 01–04, 20, 21, 37 |
| UC2 | Tapered handles, pins, nozzles, columns                    | Flex Tapering, Rhino Taper (Flat) [R1] [R16]                       | a cylinder must become an exact cone, not a faceted one             | 05, 06, 23        |
| UC3 | Bent brackets, rods, tubes, rings from straight stock      | Flex Bending, Rhino Bend, Creo Bend [R1] [R15] [R9]                | neutral-fibre length = cut length of the stock; Pappus volume       | 07–09, 24, 36     |
| UC4 | Eggs, ellipsoidal domes, mirrored handed parts             | Fusion / Onshape non-uniform scale [R11] [R13]                     | llull has no mirror that reflects geometry                          | 11, 12            |
| UC5 | Bottles, grips, organic bulges                             | Rhino CageEdit, Blender Lattice, FFD [R20] [R22] [R26]             | free-form shape from a few control points, parametric               | 13, 14            |
| UC6 | Embossed plates and ribs on drums, parts laid along a path | Rhino FlowAlongSrf / Flow, CATIA Wrap Surface [R18] [R17] [R5]     | the 2D-designed feature is reused on a curved part                  | 17, 18            |
| UC7 | Local bumps, dents, fit adjustments                        | SOLIDWORKS Deform Point, CATIA Bump [R2] [R6]                      | with a provable fold limit                                          | 15, 16            |

## 3. Validation cases

Every case runs as a CLI script (AF-23): `cli.run` in `expected_results.json` is the call sequence (`D = --doc t.llull.json --json`,
native kernel unless `--kernel manifold`), `cli.assert` the JSON path compared with the value and tolerance; exit codes checked,
no UI. Grade A = closed form or primary source; only grade A gates.

| VC        | Proves            | Setup                                                                     | Expected                                                                                                  | Tol                    | Source / derivation           | Gate                          |
| --------- | ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------- | ----------------------------- |
| VC-DEF-01 | FR-02, 07         | twist boxes 0..360°                                                       | V = a b L (10000; 5000)                                                                                   | 1e-6 rel               | det J = 1                     | unit + server                 |
| VC-DEF-02 | FR-02, 07         | box 10 × 10 × 100 at 90 / 120 / 360°                                      | total area 4204.10854 / 4207.29884 / 4264.85605                                                           | 1e-5 rel               | asinh closed form (TECH §5.2) | server (exact)                |
| VC-DEF-03 | FR-02, 07         | cylinder r 5 twisted 270° about its axis                                  | deviation 0                                                                                               | tolerance              | symmetry                      | server                        |
| VC-DEF-04 | FR-06, 21, 22     | 90° over a 50 region, linear vs smooth                                    | crease 0.1558065 rad / 0                                                                                  | 1e-6                   | atan(k b/2)                   | unit                          |
| VC-DEF-05 | FR-03             | taper S 0.5 / 2 / 0.5 flat / 0.5 smooth                                   | 5833.3333 / 23333.333 / 7500 / 5928.5714                                                                  | 1e-6 rel               | ∫ s²                          | unit + server                 |
| VC-DEF-06 | FR-03, 07         | cylinder r 5 h 40 → S 0.4                                                 | V 1633.62818, lateral 882.116478, cone                                                                    | 1e-5 rel               | frustum                       | server                        |
| VC-DEF-07 | FR-05, 21         | bars, R 50, 90 / 180°, centred / offset neutral fibre                     | V 7853.98163, 15707.9633, 7068.58347, 8639.37980; fibres 70.6858 / 86.3938                                | 1e-6 rel               | Pappus, det J = (R − y)/R     | unit + server                 |
| VC-DEF-08 | FR-05, 07         | cylinder r 5 bent 360° / 90° on R 50                                      | V 24674.0110 / 6168.50275, A 9869.60440 / 2467.40110                                                      | 1e-5 rel               | torus                         | server                        |
| VC-DEF-09 | FR-05, 09, 27     | R 4 < inner side 5                                                        | `DEF_BEND_RADIUS_TOO_SMALL`, min det −0.25                                                                | exact                  | y ≥ R                         | unit                          |
| VC-DEF-10 | FR-04             | stretch 1.5 in [20, 60]; preserveVolume 2                                 | V 12000, L 120; V 10000, L 200                                                                            | 1e-6 rel               | det J = f                     | unit + server                 |
| VC-DEF-11 | FR-01, 07         | sphere r 10 × [1,1,2] / [2,2,1] / [1,2,3]; cylinder r 5 × [2,1,1]         | V 8377.58041 / 16755.1608 / 25132.7412 / 3141.59265; A 2147.84353 / 3468.75308 / TBD / lateral 968.844822 | 1e-9 (V), 1e-6 (A) rel | spheroid closed forms         | server (exact affine)         |
| VC-DEF-12 | FR-01, 27         | factors [−1, 1, 1]; [1, 0, 1]                                             | V +6000, valid, mirrored; `DEF_SCALE_SINGULAR`                                                            | exact                  | \|det\| = 1                   | unit + server                 |
| VC-DEF-13 | FR-13, 21         | unit cube barrel m = 1.5 / 0.5 / 2                                        | V 1.3666667 / 0.7 / 1.8; det range [1, 1.5625] ⊂ bound [1, 1.8333]                                        | 1e-5 rel               | det J = g²                    | unit + server                 |
| VC-DEF-14 | FR-13             | identity lattice; affine lattice                                          | residual 0 / 0 (reference 7e-15 / 1.4e-14)                                                                | 1e-12 / 1e-9           | Bernstein linear precision    | unit                          |
| VC-DEF-15 | FR-16             | push 2 at r 10 on a face                                                  | ΔV 157.079633                                                                                             | 1e-3 rel               | d π r²/4                      | unit + server                 |
| VC-DEF-16 | FR-16, 09         | distance 5.88132 at r 10                                                  | `DEF_FOLDOVER`, limit 5.823094                                                                            | exact                  | 25√5 r/96                     | unit                          |
| VC-DEF-17 | FR-15             | plate 60 × 20 × 2 on drum r 30                                            | V 2480 (outside), 2400 (centred); width 200 `DEF_FLOW_OVERLAP`                                            | 1e-5 rel               | det J = (R + w)/R             | unit + server                 |
| VC-DEF-18 | FR-14             | flow onto an arc vs bend                                                  | difference 0                                                                                              | 1e-9                   | same map                      | unit                          |
| VC-DEF-19 | FR-08             | VC-01/05/07/08/10/11/13 on Manifold and without kernel                    | within 5e-3 rel, `method: mesh`; h ≤ 6.77 / 1.91 at tol 0.01                                              | see JSON               | refinement bound              | unit                          |
| VC-DEF-20 | FR-07, 10         | twisted box topology                                                      | 6 faces, 12 edges, 8 vertices, names kept                                                                 | exact                  | —                             | server                        |
| VC-DEF-21 | FR-10             | edit 90 → 120°                                                            | V 10000, area 4207.29884                                                                                  | 1e-5 rel               | closed form                   | golden                        |
| VC-DEF-22 | FR-34, 07         | exact result → STEP → import                                              | B-spline faces, ΔV 0                                                                                      | 1e-6 rel               | round trip                    | production gate               |
| VC-DEF-23 | FR-12             | preserveAnalytic on VC-06 / VC-03                                         | 1 cone face (half angle 4.28915°) / 1 cylinder                                                            | 1e-6                   | atan((r1 − r2)/h)             | server                        |
| VC-DEF-24 | FR-17             | nurbs_curve segment 78.5398 bent R 50 90°                                 | quarter circle, curvature 0.02                                                                            | tolerance              | neutral fibre                 | unit                          |
| VC-DEF-25 | FR-25, 10         | golden plans twice                                                        | identical documents                                                                                       | exact                  | W3                            | golden                        |
| VC-DEF-26 | FR-22, 29, 30, 31 | `check_deformation purpose=release` on a mesh result from an imported STL | named defaults, `unverified`, `reviewRequired`, warn codes                                                | exact                  | AF-31..33                     | unit + CLI                    |
| VC-DEF-27 | FR-27, 28, 09     | `plans/target_bad_plan_codes.json`                                        | 4 codes with paths + remediation                                                                          | exact                  | §7.1                          | unit + CLI                    |
| VC-DEF-28 | FR-26, 33         | `describe` audit + guide snapshot                                         | 0 unit-less numbers                                                                                       | exact                  | AF-04                         | contract                      |
| VC-DEF-29 | FR-32             | perf budgets                                                              | TECH §8                                                                                                   | TBD                    | —                             | perf (grade C until measured) |
| VC-DEF-30 | TR-04             | `data/point_vectors.json` in TS and C++                                   | ≤ 1e-9                                                                                                    | 1e-9                   | parity                        | unit + cargo                  |
| VC-DEF-31 | FR-11, 20         | `keepSource`, `ids` of two bodies                                         | 2 entities kept; 1 feature step                                                                           | exact                  | —                             | unit                          |
| VC-DEF-32 | FR-23             | `--dry-run`                                                               | file unchanged, Jacobian in data                                                                          | exact                  | AF-42                         | CLI                           |
| VC-DEF-33 | FR-18             | curve-to-curve                                                            | TBD (V2)                                                                                                  | —                      | —                             | —                             |
| VC-DEF-34 | FR-19             | morph planes z 0 / z 10 at t 0.3                                          | plane z = 3; incompatible refused                                                                         | 1e-12                  | linear poles                  | unit                          |
| VC-DEF-35 | FR-24             | overlays                                                                  | document unchanged                                                                                        | exact                  | L1 / L4                       | component                     |
| VC-DEF-36 | FR-09             | bend 400° of a bar                                                        | `DEF_SELF_INTERSECTION`                                                                                   | exact                  | overlap of z and z + 2πR      | unit + server                 |
| VC-DEF-37 | context           | baselines (today)                                                         | recorded (§4)                                                                                             | —                      | measured                      | record                        |

FR ↔ VC: FR-01 (11, 12) · FR-02 (01–03) · FR-03 (05, 06) · FR-04 (10) · FR-05 (07–09) · FR-06 (04) · FR-07 (01–03, 06, 08, 11, 20, 22) ·
FR-08 (19) · FR-09 (09, 16, 27, 36) · FR-10 (20, 21, 25) · FR-11 (31) · FR-12 (23) · FR-13 (13, 14) · FR-14 (18) · FR-15 (17) · FR-16
(15, 16) · FR-17 (24) · FR-18 (33) · FR-19 (34) · FR-20 (31) · FR-21 (04, 07, 13) · FR-22 (04, 26) · FR-23 (32) · FR-24 (35) · FR-25
(25) · FR-26 (28) · FR-27 (09, 12, 27) · FR-28 (27) · FR-29 (26) · FR-30 (26) · FR-31 (26) · FR-32 (29) · FR-33 (28) · FR-34 (22).
TR ↔ VC: TECHNICAL_SPEC §9.1; `expected_results.json` lists FR and TR ids per case in `proves` (every FR-DEF-01..34 and
TR-DEF-01..13 appears at least once, checked by a one-line script when the file is generated).

Commands named in the plans that **do not exist yet**: `twist_body`, `taper_body`, `bend_body`, `stretch_body`, `scale_nonuniform`,
`deform_lattice`, `deform_by_point`, `flow_on_surface`, `analyze_deformation`, `check_deformation` (also specified, not in a plan:
`flow_along_curve`, `deform_curve_to_curve`, `morph_bodies`). Existing commands used: `set_units`, `add_box`, `add_cylinder`,
`add_sphere`, `draw_arc`, `loft_sections`, `sweep_profile`, `mass_properties`, `measure_bounding_box`, `inspect_topology`.

## 4. Findings from the reference scripts and the baseline runs (already measured)

1. **Today's constructive work-around for a twist loses area, not volume.** `baseline_twisted_bar_loft.json` on the native kernel:
   volume 9995.931 (−0.041 %), area 4122.903 against 4204.109 (**−1.93 %**): the 24-point section resampling rounds the corners.
   A volume check would pass; an area (coating, machining stock) check fails — the closed-form area of VC-DEF-02 is the sharper test.
2. **The bent bar by sweep is measured on the display mesh**: 7803.611 vs 7853.982 (−0.64 %), `method: "mesh"`; the exact path of
   `bend_body` must be measured by the kernel's mass properties (VC-DEF-07).
3. **Every closed form agrees with an independent numeric evaluation of the map** (finite-difference Jacobian + Gauss quadrature):
   volumes to ≤ 4e-10 relative, twisted-box areas to ≤ 1.6e-9, FFD barrel to ≤ 5.4e-12, point push ΔV to 1.1e-7 (quadrature of a
   sphere-bounded integrand), plate wrap to 9e-11 — so the datasets are self-consistent.
4. **Sederberg–Parry's Bernstein bound is conservative but safe**: barrel m = 1.5 has det J ∈ [1, 1.5625] exactly; the bound gives
   [1, 1.8333]. A lattice pre-check on the bound alone would never miss a fold, but may need sampling to accept a valid lattice
   (TECHNICAL_SPEC §5.3).
5. **A linear falloff creates a measurable crease**: 0.1558 rad (8.9°) at the region start of a 90° twist over 50 mm on a 10 mm bar —
   far above the 0.01 rad G1 threshold used elsewhere in llull; hence the `smooth` default (D4).
6. **OCCT's `BRepBuilderAPI_GTransform` always runs `BRepBuilderAPI_NurbsConvert` first** (source read): even an exact affine map
   turns cylinders and spheres into B-splines; similarities must go through `gp_Trsf`, and `preserveAnalytic` is needed to get
   analytic faces back.

## 5. How a future implementation runs this pack

- `tests/unit/deform/laws.test.ts` reads `data/point_vectors.json` and every `data/*_cases.json`; `tests/unit/deform/*.test.ts` run the
  `target_*` plans with a stub exact kernel and Manifold.
- `server/tests/nativeKernelDeform.test.ts` runs the same plans on the sidecar and compares with `expected_results.json`.
- `solver/crates/llull-kernel-occt` cargo tests read `data/point_vectors.json` (path relative to the repo root) for C++ parity.
- `tests/golden/plans.ts` adds the `target_*` plans as golden plans (`deform_*`) once the commands exist; `baseline_*` plans can run now.
- The production-gate agent driver runs each case's `cli.run` and asserts `cli.assert` (AF-23).

## Baseline run (2026-10-22)

Re-run of both baselines on origin/main 2c7ecc93 (`llull run … --continue`, native kernel): `baseline_twisted_bar_loft` 4/4 ok,
`baseline_bent_bar_sweep` 4/4 ok — same results as §4.

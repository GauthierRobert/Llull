# MSH — Validation pack

Proves a future implementation of [FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC.md](../TECHNICAL_SPEC.md).
"Validated" = every gating `VC-MSH-*` below passes in an automated gate, on the TypeScript engine below its cap and on the
native engine, with every reference value produced by the Node scripts in this folder (no third-party data needed).

## 1. Contents

| File                                  | What                                                                                                                                                             | How produced                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `lib_mesh.mjs`                        | shared helpers: icosahedron / icosphere / torus / grid, area, volume, edge use, χ, 2D hull, PRNG                                                                 | hand-written                         |
| `generate_analytic_refs.mjs`          | closed forms and exact polyhedral values (icosphere convergence, hulls, Minkowski, offsets, cuts, booleans, sculpt volumes, remesh / Taubin constants, topology) | `node generate_analytic_refs.mjs`    |
| `generate_mesh_algorithms.mjs`        | reference runs: Laplacian vs Taubin, QEM on planes, min-area hole triangulation, defect mesh + truth, STL fixtures                                               | `node generate_mesh_algorithms.mjs`  |
| `generate_expected_results.mjs`       | `expected_results.json` (the VC index, values read from `data/`)                                                                                                 | `node generate_expected_results.mjs` |
| `make_plans.mjs`                      | `plans/*.json`                                                                                                                                                   | `node make_plans.mjs`                |
| `data/*.json`, `data/*.stl`           | datasets (see `sources.md` table "Reference scripts run"); `data/.gitattributes` keeps the STL bytes exact                                                       | scripts                              |
| `plans/baseline_mesh_today.json`      | **runs on today's llull** (import_mesh, mass_properties, split_body, export_3mf, export_stl, add_subdivision_solid, check_model)                                 | `make_plans.mjs`                     |
| `plans/target_*.json`                 | the same jobs with the proposed commands (each lists `unbuilt`)                                                                                                  | `make_plans.mjs`                     |
| `expected_results.json`, `sources.md` | VC index; every source with access method and grade                                                                                                              | —                                    |

Regenerate everything (deterministic, < 1 s):
`cd docs/design/07-mesh-modeling/validation && node generate_analytic_refs.mjs && node generate_mesh_algorithms.mjs && node generate_expected_results.mjs && node make_plans.mjs`.

## 2. Real use cases

| #   | Use case                                                                                           | Data                                                 | Benchmark (sourced)                                                                                                 | VCs                  |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------- |
| UC1 | **Scan / download → print**: repair, fill, smooth, decimate, hollow, flat base, wall check, 3MF    | synthetic defect mesh, STL fixtures, noisy icosphere | Fusion Repair / Reduce / Shell / Plane Cut [S2] [S3] [S5]; Meshmixer Make Solid [S17]; Magics Fix [S18]             | 03–10, 15–17, 28, 35 |
| UC2 | **Rounding / clearance / packaging** of any shape: Minkowski, offset, hull                         | cubes, icospheres, torus                             | Manifold hull / Minkowski / level set [S28]; Rhino OffsetMesh [S10]                                                 | 11–16                |
| UC3 | **Robust booleans on dirty meshes** with the B-rep kernel installed                                | two cubes                                            | Fusion Combine [S2]; Manifold guarantees [S28]                                                                      | 18                   |
| UC4 | **Organic sculpting** with replayable strokes                                                      | flat grid                                            | Blender brushes [S15]                                                                                               | 19–21                |
| UC5 | **Scan → exact CAD**: prismatic faces for mechanical parts, quad cage → B-spline for organic parts | plate with hole, icosphere                           | Fusion Convert Mesh [S1]; Rhino QuadRemesh + ToNURBS [S6] [S12]; Design X regions [S20]; Parasolid convergent [S21] | 22–24, 37            |
| UC6 | **Large scans** (10⁶ triangles) without a 100 MB document                                          | synthetic icosphere level 8                          | nTop threshold simplification [S22]                                                                                 | 29, 31               |

## 3. Validation cases

Values and tolerances: `expected_results.json` (authoritative); summary here. Every case is a CLI script (AF-23): `cli.run`
then `cli.assert` (`--doc t.llull.json --json`); exit codes checked; no UI.

| VC        | Proves        | Setup                                                         | Expected                                                                                                                  | Tol                  | Source                            | Gate                             |
| --------- | ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------- | -------------------------------- |
| VC-MSH-01 | FR-01, 03     | icospheres R 10 levels 0–6                                    | e.g. l2 A 1232.98485952, V 4047.04467998; l6 V 4188.22373818 (closed form 4188.79020479); volume-error ratio 3.12 → 3.999 | 1e-9 rel             | closed form + exact sums          | unit                             |
| VC-MSH-02 | FR-03         | icosphere l3, torus 32×16, upper half                         | χ 2 / 0, genus 0 / 1, 1 loop of 48 edges                                                                                  | exact                | χ = 2 − 2g                        | unit                             |
| VC-MSH-03 | FR-01, 29     | STL fixtures (ascii 22 211 B, binary 4 084 B, sha256 pinned)  | 80 triangles, 42 vertices, V 3658.71220851 / 3658.71216465 (float32)                                                      | 1e-9 / exact         | `stl_fixtures.json`               | unit                             |
| VC-MSH-04 | FR-03, 05, 06 | `defect_mesh.json`                                            | 2 dup, 3 flipped, 1 degenerate, 1 loop (3 edges), 2 shells → 320 faces, closed, V 4047.04467998                           | exact / 1e-9         | constructed truth                 | unit + plan                      |
| VC-MSH-05 | FR-06         | 10×10 grid minus 2×2 cells; sphere cap removed                | 6 triangles, area 100, 40 boundary edges; sphere: closed, faired V TBD                                                    | 1e-9 / TBD           | reference DP run                  | unit                             |
| VC-MSH-06 | FR-08         | 12×12 grids, flat and tilted, target 40                       | area 100 / 106.301458127, distance from plane 0, all costs 0                                                              | 1e-9 / 1e-12         | QEM property [S23], reference run | unit                             |
| VC-MSH-07 | FR-08, 25     | icosphere l5, maxDeviation 0.05                               | Hausdorff ≤ 0.05; counts TBD                                                                                              | bound                | stop rule (TECHNICAL §5.3)        | unit                             |
| VC-MSH-08 | FR-10         | clean icosphere l4                                            | Laplacian r̄ 9.822113859 (10 it), Taubin 10.01159566 (10 it), 10.05841439 (50 it)                                          | 1e-9 rel             | reference run; [S24]              | unit                             |
| VC-MSH-09 | FR-10         | noisy icosphere (±0.1 mm, seed 42)                            | rms 0.0580 → 0.0200 (Taubin), r̄ 10.0114; Laplacian r̄ 9.8220                                                               | 1e-9 rel             | reference run                     | unit                             |
| VC-MSH-10 | FR-09         | icosphere R 10 → L 1                                          | max edge ≤ 1.3333, chord deviation ≤ 0.0296736559                                                                         | bounds               | [S25] [S37]                       | unit                             |
| VC-MSH-11 | FR-12         | cube corners + 1000 interior points; icosahedron; torus 5 / 2 | V 1000; 17.453559925; ≤ 545.061675019 within 1.60 %                                                                       | 1e-9 rel / bound     | closed forms                      | unit                             |
| VC-MSH-12 | FR-13, 04     | cube 10 ⊕ icosphere r 2 (l1, l2, l3)                          | 2577.52326158 / 2601.81399162 / 2608.30028452 (continuous 2610.50144007)                                                  | 1e-9 rel             | §4.3 formula                      | unit (Manifold + TS convex path) |
| VC-MSH-13 | FR-13         | cube 10 ⊕ cube 3                                              | 2197                                                                                                                      | 1e-12 rel            | closed form                       | unit                             |
| VC-MSH-14 | FR-13         | cube 10 ⊖ cube 3; cube 10 ⊖ icosphere r 2                     | 343; 216                                                                                                                  | 1e-9 rel             | closed form                       | unit                             |
| VC-MSH-15 | FR-14         | sphere R 10 ± 1; cube 10 + 1 (round), − 1 (sharp)             | 5575.27976257, 3053.62805929, 1698.43656981, 512                                                                          | \|ΔV\| ≤ A·ε, ε 0.01 | parallel bodies                   | unit                             |
| VC-MSH-16 | FR-15         | sphere R 10 hollow 1                                          | 1135.1621455                                                                                                              | ≤ 22.745 abs         | closed form                       | unit                             |
| VC-MSH-17 | FR-16         | unit cube, planes x+y+z = 1.5 / 1, x = 0.25                   | 0.5 (cap 1.29903810568), 1/6 (cap 0.866025403784), 0.25 + 0.75 (cap 1)                                                    | 1e-12 rel            | closed form                       | unit                             |
| VC-MSH-18 | FR-17         | [0,2]³ and [1,3]³ with the native kernel installed            | ∪ 15 / A 42; − 7 / 24; ∩ 1 / 6; no `brep`                                                                                 | 1e-12 rel            | closed form                       | server                           |
| VC-MSH-19 | FR-18         | draw brush ρ 4, s 0.5 on an 80×80 grid                        | 24.78125 / 8.37757073057 / 8.37768936157 / 16.7310889254 (continuous 25.13 / 8.38 / 8.38 / 16.76)                         | 1e-9 rel             | exact PL sum                      | unit                             |
| VC-MSH-20 | FR-18         | flatten after draw; grab = draw                               | max \|z\| 0; equal arrays                                                                                                 | 1e-12                | brush definitions                 | unit                             |
| VC-MSH-21 | FR-18, 19, 28 | mirrored stroke; regenerate                                   | symmetry error 0; identical sha256                                                                                        | 1e-12 / exact        | AF-13                             | unit + golden                    |
| VC-MSH-22 | FR-22, 23     | icosphere → quad remesh 600 → cage fit 0.05 → B-spline        | quad_remesh (built): all quads, 8 valence-3 corners, quads within 15 % of 600, cage Hausdorff ≤ 0.1, B-spline faces = 4 × quads; fit (max deviation ≤ 0.05) not built | bound / measured | `plans/target_quad_remesh.json` | server (native) |
| VC-MSH-23 | FR-20, 21     | plate 40×30×5, hole r 5, exported STL                         | 6 planes + 1 cylinder r 5; B-rep V 5607.3009183                                                                           | 1e-9                 | closed form                       | server (native)                  |
| VC-MSH-24 | FR-21         | icosphere l2 faceted                                          | 320 faces, V 4047.04467998                                                                                                | 1e-9 rel             | exact sum                         | server                           |
| VC-MSH-25 | FR-25         | two parallel grids 0.5 apart                                  | Hausdorff = mean = rms = 0.5                                                                                              | 1e-12                | closed form                       | unit                             |
| VC-MSH-26 | FR-30, 35     | `plans/target_bad_plan_codes.json`                            | codes per step                                                                                                            | exact                | TECHNICAL §7.1                    | unit + CLI                       |
| VC-MSH-27 | FR-31, 32, 33 | STL without pin → decimate → check                            | `unverified` everywhere, provenance, named defaults                                                                       | exact                | AF-31..35                         | unit + CLI                       |
| VC-MSH-28 | FR-26         | clean, open, thin-wall, defect meshes                         | pass / NOT_CLOSED / WALL_THIN / non-manifold codes                                                                        | exact                | constructed                       | unit                             |
| VC-MSH-29 | FR-02, 34     | icosphere l8 + noise (1 310 720 triangles)                    | native completes within budgets (TBD); TS refuses with cap code; licences bundled                                         | TBD                  | —                                 | native gate                      |
| VC-MSH-30 | FR-27         | `plans/baseline_mesh_today.json`                              | plan `expect` (volumes, split sum, 320 triangles, manifold flag)                                                          | see plan             | `icosphere_convergence.json`      | golden (today)                   |
| VC-MSH-31 | FR-02, 27     | asset-backed l8 mesh                                          | full-resolution export 1 310 720 triangles; missing asset → `MESH_ASSET_MISSING`                                          | exact                | design rule                       | server                           |
| VC-MSH-32 | FR-28         | VC-05/06/08/19 inputs on TS and native                        | identical sha256                                                                                                          | bit                  | RS1 rule 3                        | server                           |
| VC-MSH-33 | FR-35, 36     | `llull search mesh`, `describe`, `guide`                      | 0 numbers without unit                                                                                                    | exact                | AF-01..04                         | contract                         |
| VC-MSH-34 | FR-37         | overlays on / off                                             | document unchanged                                                                                                        | exact                | L1 / L4                           | component                        |
| VC-MSH-35 | FR-07         | two overlapping sphere soups R 10, d 10 → wrap                | closed, 0 self-intersections, V 7068.58347058, A 1884.95559215                                                            | ≤ 18.85 abs          | lens closed form                  | unit (Manifold)                  |
| VC-MSH-36 | FR-11         | icosahedron midpoint subdivision                              | 80 faces, A 34.6410161514, V 17.453559925                                                                                 | 1e-12 rel            | linear subdivision                | unit                             |
| VC-MSH-37 | FR-24         | tilted plane grid → NURBS fit                                 | deviation 0, area 106.301458127                                                                                           | 1e-9                 | plane reproduction                | unit                             |
| VC-MSH-38 | FR-38         | icosphere R 12 l3 → icosphere R 10 l4                         | distance to target 0                                                                                                      | 1e-12                | closest point                     | unit                             |
| VC-MSH-39 | FR-39         | grid displaced by 0.5                                         | swept volume 200                                                                                                          | 1e-12 rel            | h·A                               | unit                             |

FR ↔ VC: 01 (01, 03) · 02 (29, 31) · 03 (01, 02, 04) · 04 (12) · 05 (04) · 06 (04, 05) · 07 (35) · 08 (06, 07) · 09 (10) ·
10 (08, 09) · 11 (36) · 12 (11) · 13 (12–14) · 14 (15) · 15 (16) · 16 (17) · 17 (18) · 18 (19–21) · 19 (21) · 20 (23) · 21 (23, 24) ·
22 (22) · 23 (22) · 24 (37) · 25 (07, 25) · 26 (28) · 27 (30, 31) · 28 (21, 32) · 29 (03) · 30 (26) · 31 (27) · 32 (27) · 33 (27) ·
34 (29) · 35 (26, 33) · 36 (33) · 37 (34) · 38 (38) · 39 (39). TR ↔ VC: TECHNICAL_SPEC §9.1; `expected_results.json` `proves`.

## 4. Findings from the reference scripts

1. **Icosphere convergence is second order** (`icosphere_convergence.json`): the volume error falls by 3.12, 3.74, 3.93,
   3.98, 3.996, 3.999 per level (→ 4 = h² with h halving); level 6 (81 920 faces) is still 1.35e-4 below 4/3 πR³. Mesh tests
   must compare against the **polyhedral** value, not the smooth one, or allow this discretisation error explicitly.
2. **Taubin with the paper's kPB 0.1 / λ 0.6307 grows a clean sphere** (+0.116 % mean radius in 10 iterations, +0.584 % in 50),
   because f(k) > 1 between 0 and kPB; Laplacian at the same λ shrinks it −1.78 % in 10. On noise (±0.1 mm) Taubin cuts the radial
   rms 0.0580 → 0.0200 while keeping the size; Laplacian cuts it to 0.0139 but shrinks. Hence `volumeCorrection` on by default.
3. **QEM keeps planar regions exactly**: both grids decimate from 288 to 46 / 48 triangles with area error ≤ 5.1e-13, zero
   distance from the plane and every collapse cost exactly 0 — Garland's "initial error … is 0" property, now a test (VC-MSH-06).
4. **Exact polyhedral Minkowski reference** (§4.3): the cube ⊕ icosphere volumes differ from the smooth formula by 1.26 %, 0.33 %,
   0.084 % at levels 1–3; a test against the smooth value would need a level-dependent tolerance, the zonotope identity needs none.
5. **Hole filling flat vs faired**: filling the 6-edge pole hole of an icosphere l3 with a flat patch loses 0.187 mm³
   (4152.74081709 → 4152.55404669); the faired patch must recover part of it (VC-MSH-05 sphere, TBD).
6. **Sculpt discretisation**: the `constant` falloff loses 1.4 % on the 0.25 mm grid (the disc edge is cut by triangles), `smooth`
   and `linear` are within 1.3e-5 relative of the continuous value; the gate uses the exact discrete value.
7. **Binary STL float32**: the binary fixture's volume differs from the ascii one by 1.2e-8 relative (float32 coordinates) — import
   tests must compute expectations from the float32 values (done in `stl_fixtures.json`).

### 4.3 Derivation — Minkowski sum of a convex body with an axis-aligned box

Let P be convex and S_x = [0,a]·e_x. P + S_x sweeps P along x: V(P + S_x) = V(P) + a·A_x(P), A_x = area of the projection of P on
the yz-plane. Its projection on the xz-plane is proj(P) + a segment along x, of area A_y(P) + a·w_z(P) (w_z = width of P along
z), so V(P + S_x + S_y) = V(P) + a(A_x + A_y) + a²w_z. Adding S_z the same way (projection on xy: A_z + a(w_x + w_y) + a²) gives

V(P + [0,a]³) = V(P) + a(A_x + A_y + A_z) + a²(w_x + w_y + w_z) + a³.

For a ball of radius r (A = πr², w = 2r): a³ + 6a²r + 3πar² + 4/3 πr³, the Steiner formula of the cube [S36] (6 face slabs, 12
quarter-cylinders a·πr²/4, 8 sphere octants). For P = cube b: (a + b)³. The generator evaluates the identity with the exact
projected hull areas and widths of each icosphere.

## 5. How a future implementation runs this pack

- `tests/unit/mesh/*.test.ts` read `data/*.json` directly (paths relative to this folder) and build the same meshes with a
  TypeScript port of `lib_mesh.mjs` (or import the JSON meshes).
- `tests/golden/plans.ts` adds `plans/baseline_mesh_today.json` now and each `target_*` plan once its commands exist.
- `server/tests/meshops.test.ts` runs the shared cases on both engines and compares sha256 (VC-MSH-32).
- The production-gate agent driver runs every `cli.run` of `expected_results.json` with `--json` and exit codes only.

## Baseline run (2026-10-22)

`llull run plans/baseline_mesh_today.json --continue` on origin/main 2c7ecc93, native kernel: 12/12 steps ok; icosphere l2 volume
4 047.045 (display mesh; VC-MSH-24 4 047.04467998), `split_body` halves 2 023.522 + 2 023.522 (exact B-rep, sum = whole), subdivision
solid 2 664.625 (display mesh).

# SWG — Validation pack

Proves a future implementation of [FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC.md](../TECHNICAL_SPEC.md). "Validated" =
every `VC-SWG-*` below passes in an automated gate on the **native OCCT kernel** (exact, 1e-6 rel) and, for the volume cases, on
**Manifold** (mesh, 0.5 %), with reference data generated here.

## 1. Contents

| File | What | How produced |
| --- | --- | --- |
| `generate_analytic_refs.mjs` | Closed forms for every geometric VC, each cross-checked by an independent mesh integral (parametric quad grid of the swept / lofted solid, divergence theorem, two resolutions, Richardson); helix fidelity of today's `add_coil`; Frenet-vs-RMF rotation by numeric RMF integration; Gordon reproduction | `node generate_analytic_refs.mjs` (Node ≥ 20, no dependencies) |
| `generate_expected.mjs` | `expected_results.json` from `data/*.json` (no hand-typed values) | `node generate_expected.mjs` |
| `make_plans.mjs` | `plans/*.json` + `proposed_steps.json` (plan → step index → proposed command) | `node make_plans.mjs` |
| `data/pappus.json`, `helical.json`, `twist.json`, `scale.json`, `twoRail.json`, `orientation.json`, `ruled.json`, `loftEnds.json`, `misc.json`, `gordon.json` | analytic datasets (value, formula, mesh check, rel. error) | generator |
| `data/coilBaseline.json` | measured deviation of today's `add_coil` centre line from the exact helix | generator (re-implements `coil.ts` + `catmullRomBeziers`) |
| `data/selfCheck.json` | the mesh-volume machinery on a plain cylinder (must match π r² h to 1e-6, else the generator throws) | generator |
| `plans/baseline_today_sweeps_lofts.json` | **runs on today's llull**: torus sweep, smooth-station taper, ruled loft frustum, `add_coil`, L-shaped elbow, each with `mass_properties` | `make_plans.mjs` |
| `plans/target_*.json` (5) | twist / scale / orientation; helix / spring / screw; rails + surface mode; loft conditions + alignment + centreline; network / ruled / developable | `make_plans.mjs` |
| `plans/bad_refusals.json` | one step per refusal code (VC-SWG-27) | `make_plans.mjs` |
| `expected_results.json` | every VC: value(s), tolerance, unit, source, grade, FR / TR proved, CLI call + JSON path | `generate_expected.mjs` |
| `sources.md` | every external source with access method and grade | — |

Regenerate: `cd docs/design/02-sweep-loft-guides/validation && node generate_analytic_refs.mjs && node generate_expected.mjs && node make_plans.mjs`.

## 2. Real use cases

| # | Use case | Benchmark feature | VCs |
| --- | --- | --- | --- |
| UC1 | Springs, coils, threads, worm and screw conveyors | Fusion Coil, Onshape Helix [R14] [R16]; CadQuery `makeHelix` [R28] | 08, 12–14, 27 |
| UC2 | Twisted / tapered bars, vanes, drill flutes, decorative columns | SolidWorks twist [R18], Onshape twist / scale [R12], NX scaling laws [R20] | 03–07, 09–11, 15 |
| UC3 | Handles, grips, hoses and hull strakes driven by rails | Rhino Sweep2 [R8], Fusion Path + Guide Rail [R15], CATIA two guides [R21] [R23] | 16–18, 35 |
| UC4 | Bottles, nozzles and fairings with tangent shoulders | SolidWorks / Onshape / Rhino loft end conditions [R19] [R13] [R10] | 21, 22, 26 |
| UC5 | Ducts and transitions, sheet-like parts (ruled / developable) | Rhino Loft straight sections, DevLoft [R10] [R11] | 19, 20, 24, 37 |
| UC6 | Freeform panels from a curve net | Rhino NetworkSrf [R9], NX Through Curve Mesh [R20], TiGL Gordon [R24] | 23, 26 |

## 3. Validation cases

Values and tolerances are authoritative in `expected_results.json`; summary here (mm, mm², mm³; angles rad). Every case runs as a CLI
script (AF-23): `cli.run` = calls with `--doc t.llull.json --kernel occt --json`, `cli.assert` = the JSON path. "Today" = runs on the
current code.

| VC | Proves (FR) | Setup | Expected | Tol | Source | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| VC-SWG-01 | 01, 03 | circle r 10 swept round a circle R 50 (**today**) | 98 696.0440 | 1e-6 / 0.5 % | Pappus 2π²Rr² | golden + server |
| VC-SWG-02 | 01 | quarter torus; square 10 offset 5 toward the centre on a quarter arc | 24 674.0110; 7 068.5835 (centred 7 853.98) | 1e-6 | Pappus, §4.1 | server |
| VC-SWG-03 | 02 | square 10, L 100, twist 90° / 360° / S-curve 180° | 10 000 each | 1e-6 | Cavalieri, §4.1 | unit + server |
| VC-SWG-04 | 02, 13 | off-centre rectangle 20 × 5 at (6, 0), twist 180°; square on helix R 20 p 10 × 3, twist 720° | 10 000; 37 818.2897 | 1e-6 | §4.1 | server |
| VC-SWG-05 | 05 | circle r 10, L 100, scale 1 → 0.5 linear | 18 325.9571 | 1e-6 | frustum | server |
| VC-SWG-06 | 05 | same, S-curve law | 18 625.1564 | 1e-6 | ∫w² = 13/35, §4.5 | server |
| VC-SWG-07 | 05, 23 | same, `1 + 0.25 sin(2πt)` | 32 397.6742 | 1e-6 | §4.5 | server |
| VC-SWG-08 | 13, 14, 15, 31 | helix R 20, p 10, 3 turns: centre-line distance to the exact helix | **today 0.2323 (ends), 0.0110 (interior)**; target ≤ 2e-5 | 1e-6 R | reference script, §4.12 | unit |
| VC-SWG-09 | 05 | square 10 on a quarter arc R 50, scale 1 → 0.5 | 4 581.4893 | 1e-6 | §4.1 | server |
| VC-SWG-10 | 05 | square, area law 100 → 25, L 100 | 6 250 (scale law would give 5 833.33) | 1e-6 | §4.5 | server |
| VC-SWG-11 | 06 | stations r 10 → 5 over 100: **today** measured 18 310.743 (frustum −0.083 %: blend sampled at path frames only); target `smooth` vs `linear` | 18 625.1564 vs 18 325.9571 | 1e-6 | §4.5 | golden |
| VC-SWG-12 | 13, 28 | tube r 2 on helix R 20, p 10, 3 turns | 4 752.3864; ρ_min 20.12665, τ 0.0039538, L 378.1829 | 1e-6 / 1e-9 | §4.3 | server |
| VC-SWG-13 | 03, 15, 16 | axial-plane rectangle 4 × 3 at r̄ 20, 3 turns, pitch 10 and 5 | 4 523.8934 both | 1e-6 | screw Jacobian, §4.3 | server |
| VC-SWG-14 | 13 | conical helix 20 → 10, p 10, 5 turns, wire r 1 | 1 489.4197 (L 474.0970) | 1e-6 | §4.3 (Simpson) | server |
| VC-SWG-15 | 03 | circle r 10, L 100 at 45°: `minimal` vs `fixed` | 31 415.9265 vs 22 214.4147 | 1e-6 | §4.2 | server |
| VC-SWG-16 | 09, 11 | two straight rails 20 → 10 over 100, `scale` | 18 325.9571; rail deviation 0 | 1e-6 | §4.6 | server |
| VC-SWG-17 | 09 | same, `maintainHeight` | 23 561.9449 | 1e-6 | §4.6 | server |
| VC-SWG-18 | 09, 12 | segment between two opposite helical rails a 10, p 20, 2 turns (`sweep_surface`) | area 1 555.8782 | 1e-5 | helicoid, §4.10 | server |
| VC-SWG-19 | 19, 26 | ruled loft circles R 10, h 50, seam offset φ = 0, 60, 90, 120, 180° | 15 707.96, 13 089.97, 10 471.98, 7 853.98, 5 235.99 | 1e-6 | §4.8 | server |
| VC-SWG-20 | 26, 27 | ruled / developable frustum r 10 → 5, h 50 | V 9 162.9786, lateral 2 367.9462, K = 0, flat arcs 2π·5, 2π·10 | 1e-6 / 1e-5 | §4.10 | unit + server |
| VC-SWG-21 | 17, 18 | loft circles r 10 → 5, h 50, `normal` both ends, m = 1 | 9 312.5782; end angles 0 | 1e-6; 1e-6 rad | Hermite, §4.7 | unit + server |
| VC-SWG-22 | 17, 21 | same with m = 2; centreline loft on a quarter arc R 50, r 10 | 9 462.1779; 24 674.0110 | 1e-6; 1e-4 | §4.7 | server |
| VC-SWG-23 | 22, 24 | 3 + 3 curves of z = sin πx + y³ (`loft_surface` guides **today**; `network_surface` unsorted) | max deviation 0 (reference 6.7e-16; sections-only skin 0.056) | 1e-5 | §4.9 | unit |
| VC-SWG-24 | 26 | ruled between (0,0,0)–(1,0,0) and (0,1,0)–(1,1,1) | area 1.2807893, K(½,½) −0.4444444 | 1e-7 | §4.10 | unit |
| VC-SWG-25 | 03, 28 | Frenet vs RMF rotation per turn on helix R 20, p 10 | 0.4984243 rad (script: −0.4984243) | 1e-6 | §4.4 | unit |
| VC-SWG-25b | — (TR-02) | **today**: TS RMF mesh vs OCC corrected-Frenet solid, rectangle 10 × 2 on the same helix | TBD — measure with `llull --kernel occt` | — | grade C | server |
| VC-SWG-26 | 25, 17 | network / loft edge G1 to a neighbour sheet | G1 angle 0 | 0.01 rad | OCCT TolAngular [R1] | unit |
| VC-SWG-27 | 02, 04, 10, 16, 31 | `plans/bad_refusals.json` (+ anchor-less rail, `fitTolerance` 1e-12) | `SWG_SELF_INTERSECTION_LOCAL`, `SWG_CLOSED_TWIST_NOT_PERIODIC`, `SWG_FRAME_DEGENERATE`, `SWG_SELF_INTERSECTION_GLOBAL`, `SWG_LAW_NONPOSITIVE`, `SWG_LAW_INVALID`, `SWG_GUIDE_ANCHOR_UNDEFINED`, `SWG_FIT_TOLERANCE` | exact | TECHNICAL §7.1 | unit + CLI |
| VC-SWG-28 | 29, 30 | `check_sweep_loft` over every target plan; with the exact kernel also the volume consistency (`volumeConsistencyRel` 1e-4, `data.volumeChecks`) | pass; every tolerance named, `defaulted`, `source`; 13 volume comparisons within 1.1e-6 | exact | TECHNICAL §5.8, §16 | unit + CLI + server |
| VC-SWG-29 | 14 | native `sheetSolid` (recipe node, also bored tubes with laws: outer minus bore), `helixEdge`, `pipeShell` vs the evaluator | 0 free edges; volumes as above; bored tubes with laws within 1e-8 of their closed forms | 1e-6 | TECHNICAL §16 | server (cargo + node) |
| VC-SWG-30 | 32, 34, 35 | `llull search` / `describe` audit | 0 params / result numbers without unit | exact | AF-01..04, AF-10 | contract |
| VC-SWG-31 | 33, 36 | edit a law / rail / pitch in history; replay existing goldens | ids stable; old snapshots bit-identical | exact | L8 | golden |
| VC-SWG-32 | 37 | every volume VC on Manifold (the mesh path, no exact kernel), as one table | within 0.5 %: 37 of 37 rows, worst 3.9e-3 (VC-36), table in section 6 | 5e-3 | — | unit (`tests/unit/sweep/volumes.test.ts`) |
| VC-SWG-33 | 38 | budgets TECHNICAL §8 | within 4 × | — | — | perf |
| VC-SWG-34 | 03, 12 | 10 mm segment along the reference-surface normal round a circle R 50: plane / cylinder | area 3 141.5927 / 3 455.7519 | 1e-5 | closed form | unit |
| VC-SWG-35 | 08 | one rail 10 → 5 (`scale`); helical rail r 5 p 100, square, `orient` | 18 325.9571; 10 000 | 1e-6 | §4.6, §4.1 | server |
| VC-SWG-36 | 19 | square 10, h 50, seams one corner apart: `none` vs `auto` | 3 333.3333 vs 5 000 | 1e-6 | §4.8 | unit + server |
| VC-SWG-37 | 20, 26 | ruled square 20 → circle r 10, h 50, arc-length coupling; vertex coupling | 17 904.7632 (reference code); 4 longitudinal corner edges | 1e-5 | reference code | server |
| VC-SWG-38 | 07 | L path 100 + 100, circle r 5: round corner bend 30 (**today**) / mitre | 14 696.6759 / 15 707.9633 | 1e-6 | §4.11 | golden + server |

FR ↔ VC coverage: 01 (01, 02) · 02 (03, 04, 27) · 03 (01, 13, 15, 25, 34) · 04 (27) · 05 (05–07, 09, 10) · 06 (11) · 07 (38) · 08 (35) ·
09 (16–18) · 10 (27) · 11 (16) · 12 (18, 34) · 13 (04, 08, 12, 14) · 14 (08, 29) · 15 (08, 13) · 16 (13, 27) · 17 (21, 22, 26) · 18 (21) ·
19 (19, 36) · 20 (37) · 21 (22) · 22 (23) · 23 (07) · 24 (23) · 25 (26) · 26 (19, 20, 24, 37) · 27 (20) · 28 (12, 25) · 29 (28) · 30 (28) ·
31 (08, 27) · 32 (30) · 33 (31) · 34 (30) · 35 (30) · 36 (31) · 37 (32) · 38 (33). TR ↔ VC: TECHNICAL §9.1.

## 4. Derivations

### 4.1 Volume of a general sweep (Pappus for space curves)

Let the path C(s) (arc length s, tangent T, curvature κ, principal normal N) carry a planar section in the plane ⟂ T, placed by any
in-plane frame (n, b) rotating with any twist φ(s) and scaled by σ(s): X(s, x, y) = C(s) + σ(s)[x n(s) + y b(s)]. ∂X/∂x and ∂X/∂y lie in
the section plane; the component of ∂X/∂s along T is 1 − κ σ ξ, where ξ = (x n + y b) · N is the section coordinate toward the
principal normal (twist, torsion and σ′ only add in-plane components). The volume element is therefore (1 − κσξ) σ² dA₀ ds and

V = ∫ σ² (A₀ − κ σ Q₀(s)) ds,  Q₀ = ∫ ξ dA₀ (first moment of the section about the line through the path point ⟂ N).

When the section centroid stays on the path, Q₀ = 0 for every rotation φ, so **V = ∫ A(s) ds** for any twist, scale law, frame mode
that keeps the section normal to the path, and any path — as long as 1 − κσξ > 0 (no local fold: the self-intersection margin of
TECHNICAL §5.4) and the solid does not overlap itself globally. For a planar circular path this is Pappus [R26]; an off-centre
section on a circular arc gives V = A θ (R − d) (VC-SWG-02); on a straight path κ = 0 and V = A L even for an off-centre twisted
section — Cavalieri [R27] (VC-SWG-03/04).

### 4.2 Fixed (non-normal) orientation

With `fixed`, the section stays in its start plane (normal e). Slices by planes ⟂ e are congruent sections, so V = A × (extent of the
path along e) = A L cos α for a straight path at angle α to e (VC-SWG-15: 22 214.41 = π·100·100·cos 45°).

### 4.3 Helices

x = R cos a, y = R sin a, z = c a, c = p / 2π. Length per turn 2π√(R² + c²); κ = R / (R² + c²); τ = c / (R² + c²); radius of curvature
R + c² / R (20.12665 for R 20, p 10). Tube (section normal to the helix, centroid on it): V = A L (4.1). **Screw sweep** (section in the
plane through the axis, coordinates radius r and axial offset y): X = (r cos a, r sin a, y + c a); the Jacobian of (r, y, a) is r, so
V = ∫∫ r dA · 2π n = 2π n A r̄ — independent of the pitch (VC-SWG-13; `add_coil` already uses this for its flat wire). No overlap of
consecutive turns needs the section's axial extent < pitch (`SWG_SELF_INTERSECTION_GLOBAL`). Conical helix: L = ∫ √(r(a)² + r′(a)² + c²) da
(Simpson, 20 000 intervals).

### 4.4 Frenet vs rotation-minimizing frame

The RMF has no rotation about T; the Frenet frame rotates about T at rate τ (Frenet–Serret: N′ = −κT + τB). Over one helix turn the
relative angle is τ L₁ = 2πc / √(R² + c²) = 0.4984243 rad for R 20, p 10. The generator integrates the RMF by double reflection
(20 000 steps) and measures −0.4984243 (the RMF lags), confirming both the closed form and the sign convention (VC-SWG-25).

### 4.5 Laws

With w(t) = 3t² − 2t³ (S-curve, also today's station blend): ∫₀¹ w = 1/2, ∫₀¹ w² = 13/35. Scale law s = s₀ + d·w: ∫ s² = s₀² + s₀ d + 13 d²/35;
linear: (s₀² + s₀s₁ + s₁²)/3. For r 10 → 5 over 100: frustum 18 325.957, S-curve 18 625.156 (+1.63 %). Expression 1 + 0.25 sin 2πt:
∫ s² = 1 + 0.25²/2 = 1.03125. Area law A(t) linear: V = L (A₀ + A₁)/2 = 6 250, vs the scale law with the same end areas 5 833.33.

### 4.6 Rails

Two straight rails y = ±d(x)/2, d linear d₀ → d₁: uniform scale of a circle of diameter d ⇒ cone frustum π L (d₀² + d₀d₁ + d₁²)/12;
`maintainHeight` (height d₀ kept, width d) ⇒ elliptic sections, V = π d₀ L (d₀ + d₁)/8. One rail at distance 10 → 5 from a straight
spine with `scale` ⇒ the same frustum. A helical rail of radius 5 through the mid-edge anchor of a 10-square with `orient` ⇒ a linear
twist of one turn ⇒ V = A L (4.1).

### 4.7 Loft with normal end conditions

Two sections, both ends `normal` with magnitude m: in v the surface is the cubic Hermite with end derivatives m h ẑ. Radial part:
h₀₀ r₀ + h₀₁ r₁ = r₀ + (r₁ − r₀) w(v); axial part z(v) = m h (h₁₀ + h₁₁) + h h₀₁, which for m = 1 is exactly h v. Hence V = π h (r₀² + r₀d +
13 d²/35) = 9 312.578 (d = −5), and the end angle to the normal is 0 (w′(0) = w′(1) = 0). For m = 2, z′(v) = h(6v² − 6v + 2) > 0 and V =
∫ π r(v)² z′(v) dv = 9 462.178 (Gauss–Legendre). Free ruled: frustum 9 162.979.

### 4.8 Twisted ruled lofts and seam alignment

Parameter-coupled ruled loft between a section p(u) and its copy rotated by φ at height h: X = ((1 − t)I + tR_φ) p(u) + t h ẑ. The slice
at height th is the section mapped by M(t) = (1 − t)I + tR_φ, det M = (1 − t)² + t² + 2t(1 − t) cos φ = 1 − 2t(1 − t)(1 − cos φ), so
V = A h (1 − (1 − cos φ)/3) for **any** section (circles: the hyperboloid of one sheet; φ = π: a double cone). A square whose second
seam is one corner on (φ = 90°) gives 2/3 of the prism; `alignment: 'auto'` must restore the prism (VC-SWG-19, 36).

### 4.9 Gordon reproduction

Gordon surface: S = Σᵢ φᵢ(u) f(uᵢ, v) + Σⱼ ψⱼ(v) f(u, vⱼ) − Σᵢⱼ φᵢ(u) ψⱼ(v) f(uᵢ, vⱼ). For f = g(u) + h(v) and blending functions with
Σφᵢ = Σψⱼ = 1, the three terms are (Σφᵢgᵢ + h) + (g + Σψⱼhⱼ) − (Σφᵢgᵢ + Σψⱼhⱼ) = g + h: exact, whatever the (cardinal, partition-of-unity)
blending. The generator confirms 6.7e-16 with quadratic Lagrange blending on z = sin πx + y³ while skinning through the sections alone
deviates by 0.056. The llull tolerance (1e-5) covers the interpolation of the sin guides by 41 points.

### 4.10 Ruled, developable, helicoid

Frustum: V = π h (r₁² + r₁r₂ + r₂²)/3, lateral π (r₁ + r₂) s, s = √(h² + (r₁ − r₂)²); developable (K = 0); flat pattern = annular
sector of radii ρᵢ = rᵢ s / (r₁ − r₂), angle 2π (r₁ − r₂)/s, arcs 2π r₂ and 2π r₁. Helicoid x = u cos a, y = u sin a, z = c a, u ∈ [−a₀, a₀]:
|X_u × X_a| = √(u² + c²), area 2π n ∫ √(u² + c²) du, K = −c²/(u² + c²)² (not developable). Hyperbolic paraboloid z = xy: area
∫∫ √(1 + x² + y²) = 1.2807893 (Gauss–Legendre 40 × 40), K = −1/(1 + x² + y²)².

### 4.11 Corners

Round corner of bend radius R_b on an L path of legs L₁, L₂ (90°): straight parts L − R_b each plus a quarter torus (Pappus): V = A (L₁ +
L₂ − 2R_b + πR_b/2). Mitre: the mitre plane is a symmetry plane of the joint, the wedge beyond each leg's end replaces the wedge
missing from the other: V = A (L₁ + L₂).

### 4.12 Finding: today's `add_coil` helix

`add_coil` places 16 helix points per turn and joins them with centripetal Catmull-Rom Béziers (`catmullRomBeziers`, open, phantom end
points 2p₀ − p₁). Re-implemented in the generator (Newton foot points on the exact helix, 400 samples per span): max distance 0.2323 mm
for R 20, p 10, 3 turns — **1.16 % of R, at the two end segments** (the reflected phantom point bends the end tangent); 0.0110 mm
(5.5e-4 R) in the interior; centre-line length −0.044 %. `data.analyticVolume` uses the exact helix length, so the returned analytic
volume and the solid differ by about that length error. FR-SWG-15 replaces the path by the exact helix.

## 5. How a future implementation runs this pack

- `tests/unit/sweep/laws.test.ts`, `frames.test.ts`, `helix.test.ts` iterate `data/*.json` (closed forms, 1e-9 to 1e-12).
- `tests/unit/sweep/volumes.test.ts` builds each VC on the Manifold (mesh) path and checks `mass_properties` within 0.5 % (VC-SWG-32) as one table; it fails when the pack gains a volume value the table lacks.
- `server/tests/nativeKernelSweeps.test.ts` runs the same table on the native sidecar at 1e-6 rel (VC-SWG-29).
- `tests/golden/plans.ts` imports `plans/baseline_today_sweeps_lofts.json` now and each `plans/target_*.json` once
  `proposed_steps.json` is empty for it (until then they are listed in `tests/unit/contract/blockedPlanCommands.json`).
- The production-gate agent driver runs every `cli.run` with `--json` and compares `cli.assert` with `expected_results.json`.
- Baseline run 2026-10-22 (`llull run plans/baseline_today_sweeps_lofts.json --continue`, native kernel, 12/12 steps ok): torus sweep
  98 696.044 (VC-SWG-01, = Pappus), L-path bend 14 696.676 (VC-SWG-38, = closed form), taper 18 310.743 display mesh (VC-SWG-11: the
  frustum, not the smoothstep value — see FR-SWG-06), ruled loft 9 161.906 exact, `add_coil` 3 turns 4 750.288. VC-SWG-25b still TBD.

## 6. VC-SWG-32 as built (2026-10-25)

`tests/unit/sweep/volumes.test.ts`: `mass_properties` volume without an exact kernel (mesh path; round sections without laws by closed form) against the closed forms of `expected_results.json`; limit `meshKernelRel` 5e-3. mm³ and relative error:

| VC | Case | Expected | Mesh path | Rel. error |
| --- | --- | --- | --- | --- |
| 01 | torus sweep | 98 696.04 | 98 696.04 | 6e-14 |
| 02 | quarter torus / offset square on a quarter arc | 24 674.01 / 7 068.583 | 24 674.01 / 7 057.234 | 9e-13 / 1.6e-3 |
| 03 | twist 90° / 360° / S-curve 180° | 10 000 | 9 998.996 / 9 997.115 / 9 996.584 | 1.0e-4 / 2.9e-4 / 3.4e-4 |
| 04 | off-centre rectangle 180° / square on a helix 720° | 10 000 / 37 818.29 | 9 997.153 / 37 808.59 | 2.9e-4 / 2.6e-4 |
| 05 / 06 / 07 | cone / S-curve / expression laws (round) | 18 325.96 / 18 625.16 / 32 397.67 | closed form | 2e-12 / 9e-13 / 1e-12 |
| 09 | square on a quarter arc, scale 1 → 0.5 | 4 581.489 | 4 581.029 | 1.0e-4 |
| 10 | area law 100 → 25 | 6 250 | 6 249.894 | 1.7e-5 |
| 11 | stations r 10 → 5, linear / smooth | 18 325.96 / 18 625.16 | 18 310.74 / 18 609.31 | 8.3e-4 / 8.5e-4 |
| 12 / 14 | tube on a helix / conical helix wire (round) | 4 752.386 / 1 489.420 | closed form | 9e-13 / 3e-12 |
| 13 | screw rectangle, pitch 10 / 5 | 4 523.893 | 4 525.704 / 4 524.395 | 4.0e-4 / 1.1e-4 |
| 15 | normal / fixed 45° (round) | 31 415.93 / 22 214.41 | closed form | 5e-12 / 5e-12 |
| 16 / 17 / 35 | rails: uniform scale / maintain height / one rail | 18 325.96 / 23 561.94 / 18 325.96 | 18 325.98 / 23 561.94 / 18 325.98 | 1.1e-6 / 1e-12 / 1.1e-6 |
| 19 | ruled circles, seam turned 0 / 60 / 90 / 120 / 180° | 15 707.96 / 13 089.97 / 10 471.98 / 7 853.982 / 5 235.988 | 15 705.01 / 13 078.21 / 10 459.27 / 7 843.21 / 5 235.00 | 1.9e-4 / 9.0e-4 / 1.2e-3 / 1.4e-3 / 1.9e-4 |
| 21 / 22 | loft end conditions m 1 / m 2, centreline quarter arc | 9 312.578 / 9 462.178 / 24 674.01 | 9 307.77 / 9 454.29 / 24 666.89 | 5.2e-4 / 8.3e-4 / 2.9e-4 |
| 36 | squares one corner apart, `none` | 3 333.333 | 3 320.312 | 3.9e-3 |
| 37 | square 20 → circle 10, arc-length coupling | 17 904.76 | 17 910.17 | 3.0e-4 |
| 38 | L path round corner / mitre (round) | 14 696.68 / 15 707.96 | closed form | 2e-12 / 3e-12 |

Three mesh-path faults found by the table were fixed rather than excused: polygon-section lofts were displayed through a Catmull-Rom smoothing of their corners (VC-36 was 32 % off), the path of an off-centre profile was sampled too coarsely (VC-02 offset square 6.4e-3), and a round section driven by rails meshed as a 24-gon (1.14 % small). Details: TECHNICAL_SPEC §16.3.

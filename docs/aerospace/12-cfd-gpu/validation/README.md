# Gap 12 CFD — Validation pack

This pack is how a future implementation proves that llull's local GPU CFD is right. Every expected value is one of:

- a **closed form** of a cited model, computed by [`derive_references.py`](derive_references.py) (stdlib Python; re-run with
  `python3 -I derive_references.py` from this folder, output `data/analytic_references.json`, byte-identical);
- a **literature value** with its grade (see [sources.md](sources.md));
- **TBD**, with the tool or data needed to fill it.

**No expected value was produced by running llull** (nothing is implemented yet). Only closed forms and grade-A values are pass /
fail gates; grade B and TBD values are documentation until their primary data is pinned (sha256) in `data/`.

All cases run automatically once built:

- Solver-level cases (Poiseuille, Taylor-Green, Sod, streamlines in an analytic field) are Rust tests in `solver/crates/llull-flow-*/tests`.
- Command-level cases (`prepare_cfd_case`, records, stale flags) are Vitest tests in `tests/unit/aero/cfd/` and `server/tests/cfd/`.
- Scenario plans in `plans/` are CLI scripts (AF-23): `actions` are `build_project` steps, `cli` lines run the transports, and
  `expected` rows are compared with the JSON the CLI writes, by the benchmark runner (`llull run_benchmarks`, PHY-00).

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `derive_references.py` | generator of every closed-form expected value | — |
| `data/analytic_references.json` | Sod exact Riemann solution; oblique shocks (M 2 / 10°, M 3 / 15°); stagnation Cp (isentropic M 0.3 / 0.8, Rayleigh pitot M 2 / 2.5); Schiller-Naumann sphere Cd (Re 20–200); Poiseuille and Taylor-Green exact solutions; streamlines of potential flow about a sphere; voxel volume bound; blockage of a 1:1:2 building; Billig stand-off (documentation) | closed form (A), Billig B |
| `data/literature_benchmarks.json` | Schäfer-Turek 2D-1 cylinder, AIJ case A, Ghia cavity, Billig stand-off, ONERA M6: definitions, the values found, their provenance and what must be pinned | B / TBD |
| `expected_results.json` | index of every VC: command, reference, tolerance, grade, FR proved, test | — |
| `plans/sc-cfd-0*.json` | CLI scenarios (draft: the commands do not exist yet) | — |

## Real use cases

| # | Use case | What llull must do | VC / SC |
| - | -------- | ------------------ | ------- |
| U1 | Supersonic winged body (the owner's shuttle image): surface Mach and streamlines at Mach 2 | prepare an assembly, Euler solve, streamlines, PNG | VC-CFD-31, 32, 40, 53; SC-CFD-03, 04, 05 |
| U2 | Wind around buildings (the owner's second image): speed and pressure around blocks | buildings domain, LBM solve, probes at pedestrian height | VC-CFD-12, 21, 24; SC-CFD-01 |
| U3 | Drag of a cyclist or a car body | LBM solve, CdA for 10 AER `road_load_power` | VC-CFD-20, 21, 42; SC-CFD-02 |
| U4 | Nose-cone pressure of a sounding rocket at Mach 2.5 | Euler solve, stagnation pressure, shock stand-off | VC-CFD-32, 33; SC-CFD-04 |
| U5 | An agent checks trust before reporting | convergence, grid study, GPU / CPU agreement, stale flags | VC-CFD-26, 35, 50–52, 55 |

## Validation cases

| VC | What | Reference | Tolerance | Test |
| -- | ---- | --------- | --------- | ---- |
| VC-CFD-10 | Voxelised sphere volume | bound A·(√3/2)h / V: 16.2 / 8.12 / 4.06 % at 16 / 32 / 64 cells per radius | inside the bound, decreasing with h | `prepare.test.ts`, SC-CFD-01 |
| VC-CFD-11 | Watertight check and union | open box: 4 open edges; two unit cubes overlapping by 0.5: union volume 1.5 m³, no internal face | exact | `prepare.test.ts`, SC-CFD-01 |
| VC-CFD-12 | Buildings domain and blockage | COST 732 / AIJ rules [S1][S2]; 1:1:2 block: top at 6H, blockage 1·2 / (21·12) = 0.794 % | 1e-6 rel | `prepare.test.ts`, SC-CFD-01 |
| VC-CFD-13 | Aero domain defaults are large enough | sphere Re 100 at 1× and 1.5× the default domain | Cd change < 1 % | `domainSensitivity.test.ts` |
| VC-CFD-14 | Preparation is deterministic | same `geometryHash` after save / load and replay | exact | `prepare.test.ts` |
| VC-CFD-15 | Small-feature report | 2 mm hole on a 1 m box at h = 10 mm | flagged `CFD_SMALL_FEATURE` | `prepare.test.ts` |
| VC-CFD-16 | Boundary tags and regime | tags survive replay; LBM forced at Mach 0.5 | identical tags; `CFD_REGIME_MISMATCH` | `caseCommands.test.ts` |
| VC-CFD-20 | LBM Poiseuille | exact parabola [S7] | observed order ≥ 1.8 (16 / 32 / 64 cells) | `poiseuille.rs` |
| VC-CFD-21 | LBM sphere drag Re 20 / 50 / 100 / 200 | Schiller-Naumann: 2.6096 / 1.5381 / 1.0917 / 0.8056 [S14] | 10 % at 32 cells per diameter | `sphere.rs`, SC-CFD-02 |
| VC-CFD-22 | LBM Taylor-Green decay | exp(−2νk²t) = 0.45404 (ν 0.01, k 2π, t 1) | 1 % at 64² | `taylor_green.rs` |
| VC-CFD-23 | Schäfer-Turek 2D-1 | Cd 5.5795 (grade B) | planned 3 %; not a gate until pinned | M5 |
| VC-CFD-24 | AIJ case A | TBD | planned AIJ hit rate; not a gate | M5 |
| VC-CFD-25 | Ghia cavity | TBD | planned 2 %; not a gate | M5 |
| VC-CFD-26 | GPU vs CPU | the CPU backend | fields 1e-4, forces 1e-5 rel | `equivalence.rs`, SC-CFD-02 |
| VC-CFD-30 | Euler Sod tube | exact Riemann: p* 0.30313, u* 0.92745, ρ*L 0.42632, ρ*R 0.26557; shock at x = 0.85043 at t = 0.2 [S6][S9] | wave positions 2 cells at 400 cells; L1 order ≥ 0.6 | `sod.rs` |
| VC-CFD-31 | Euler wedge | M 2 / 10°: β 39.314°, Cp 0.25235; M 3 / 15°: β 32.240°, Cp 0.28914 [S4] | β 0.5°, Cp 2 % | SC-CFD-03 |
| VC-CFD-32 | Euler stagnation Cp | M 0.3: 1.0227; M 0.8: 1.1704; M 2: 1.6573; M 2.5: 1.7203 [S4] | 2 % | SC-CFD-04 |
| VC-CFD-33 | Bow-shock stand-off | Billig: Δ/R 0.321 (M 2), 0.240 (M 2.5), 0.205 (M 3) [S15] | 15 %, documentation only | SC-CFD-04 |
| VC-CFD-34 | ONERA M6 | TBD (AR-138 Cp) | planned; not a gate | M5 |
| VC-CFD-35 | Euler entropy error | exact value 0 in smooth inviscid flow | max \|s − s∞\| falls with order ≥ 0.8 | `entropy.rs` |
| VC-CFD-40 | Streamlines | Stokes stream function of potential flow about a sphere | ψ drift 1e-4; offsets 1e-3 R | `streamlines.rs`, SC-CFD-05 |
| VC-CFD-41 | Surface field mapping | linear field p = x | h·\|∇p\| | `surface_map.rs` |
| VC-CFD-42 | Force consistency | momentum exchange vs surface integration | 2 % | `forces.rs` |
| VC-CFD-43 | Overlay legend | result peaks, `resultColor` | exact | `CfdOverlay.test.tsx` |
| VC-CFD-50 | Memory refusal | adapter memory | refused before allocation | `memory.test.ts` |
| VC-CFD-51 | No-GPU fallback | VC-CFD-26 | warning + CPU result | `fallback.test.ts` |
| VC-CFD-52 | Stale result | geometry moved after solve | `stale: true` | `stale.test.ts` |
| VC-CFD-53 | End-to-end CLI demo | supersonic free stream undisturbed ahead of the bow shock | upstream Mach 1e-3 rel; PNG written | SC-CFD-05 |
| VC-CFD-55 | Not converged is never silent | step limit 100 on sphere Re 100 | `converged: false`, `CFD_NOT_CONVERGED`, still recorded | `convergence.test.ts` |
| VC-CFD-54 | Performance | TBD — measure | regression > 20 % fails | M5 |

### Derivations used as expectations

- **Sod (VC-CFD-30).** Left (ρ, u, p) = (1, 0, 1), right (0.125, 0, 0.1), γ = 1.4, interface at x = 0.5. The star pressure solves
  f_L(p) + f_R(p) = 0 with Toro's shock / rarefaction functions (Newton, |Δp| < 1e-15). The shock speed is
  S = u_R + a_R √((γ+1)/(2γ) p*/p_R + (γ−1)/(2γ)). These are the textbook Sod values (p* 0.30313, u* 0.92745).
- **Wedge (VC-CFD-31).** Weak root of tan θ = 2 cot β (M² sin² β − 1)/(M²(γ + cos 2β) + 2), then the normal-shock relations on
  M sin β, Cp = (p₂/p₁ − 1)/(½γM²). The M 2 / 10° values equal those already validated by 11 FLD (`compressible_naca1135.json`:
  39.31°, 1.7066, M₂ 1.6405). The scenario reads values at mid-span, x ≤ 0.5 m, which the tip Mach cones do not reach: downstream
  of the shock μ = asin(1/1.6405) = 37.6°, so a tip disturbance reaches y = 0.5·tan 37.6° = 0.38 m < 0.5 m at x = 0.5 m.
- **Stagnation (VC-CFD-32).** Subsonic: p₀/p = (1 + (γ−1)/2 M²)^(γ/(γ−1)). Supersonic: Rayleigh pitot formula
  p₀₂/p₁ = [(γ+1)² M² / (4γM² − 2(γ−1))]^(γ/(γ−1)) · (1 − γ + 2γM²)/(γ+1). Cp = (ratio − 1)/(½γM²).
- **Sphere drag (VC-CFD-21).** Cd = 24/Re (1 + 0.15 Re^0.687), valid for Re < 800. The 10 % band is llull's acceptance for a
  staircase wall at 32 cells per diameter, not a claim on the correlation's own accuracy.
- **Streamlines (VC-CFD-40).** ψ = ½ U r² sin²θ (1 − R³/r³). A seed at (−10, y₀) keeps ψ(seed); at x = 0 the line sits at the root
  of ½ U y² (1 − R³/y³) = ψ; by fore-aft symmetry of potential flow it returns exactly to y₀ at x = +10.
- **Voxel bound (VC-CFD-10).** Every misclassified cell is cut by the surface, so it lies within (√3/2) h of it; the volume error is
  at most A·(√3/2) h, i.e. 3(√3/2)(h/R) relative for a sphere.
- **Blockage (VC-CFD-12).** Block B = D = 1 m, H = 2 m; domain width B + 2·5H = 21 m, height H + 5H = 12 m; blockage =
  B·H / (21 · 12) = 0.794 % < 3 %.

### Known biases (expected, documented, not failures)

- Euler results have no viscous drag and no separation; surface Cp near trailing edges and in wakes differs from experiments.
- Half-way bounce-back walls are staircase walls: drag converges at first order with cell size near curved walls; interpolated walls
  (V1) are expected to improve VC-CFD-21 at the same resolution.
- LBM at lattice Mach 0.1 has a compressibility error of order Ma² (≈ 1 %) in incompressible benchmarks.

## What could not be verified

- FEATFLOW / Schäfer-Turek reference tables (host not reachable): only secondary extracts (Cd 5.5795 / 5.58, Cl 0.0107).
- Ghia et al. 1982 Table I: not read from a primary copy; no value transcribed.
- AIJ case A data and ONERA M6 AR-138 Cp files (NASA NPARC archive not reachable): to download and pin.
- COST 732 and AIJ 2008 primary documents: the 5H / 15H / 3 % rules come from three concordant secondary sources (grade B).
- Billig 1967 primary report: one secondary citation (grade B).

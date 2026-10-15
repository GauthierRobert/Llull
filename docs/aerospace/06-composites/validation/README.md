# CMP: composite structures validation pack

This pack defines what a future llull composites implementation must reproduce before the gap counts as
closed: CLT, failure, layup rules, zones and ramps, drape, flat patterns and exports. Each case lists its
expected value, tolerance, and where the value comes from. Every external source is listed with its access
date in [`sources.md`](sources.md). In this authoring session direct page fetches were blocked by the
sandbox, so sources were checked through search-result excerpts. `sources.md` says what each excerpt
confirmed.

## 1. Files

| File | Kind | What it is |
| ---- | ---- | ---------- |
| `generate_clt_reference.py` | generator (python3, stdlib only) | CLT: Q, Qbar, ABD, a/b/d, engineering constants, ply stresses, first-ply failure (max stress, Tsai-Hill, Tsai-Wu) for 2 materials x 7 laminates x 4 unit loads; plus closed-form identities |
| `clt_reference.json` | output | 14 cases, about 300 kB; regenerate with `python3 generate_clt_reference.py`; `--check` diffs |
| `generate_drape_reference.py` | generator | Pin-jointed-net (Mack & Taylor fishnet) drape of a R = 100 mm hemisphere at step d = 4, 2, 1 mm with Gauss-Bonnet and symmetry self-checks; analytic flat patterns of a cylinder, a cone and a frustum |
| `drape_reference.json` | output | Diagonal shear profile, max shear, shear-limit counts, flat-pattern dimensions |
| `generate_layup_rules_reference.py` | generator | Stacking-notation parser (`[0/±45/90]s`, `[0/90]_2s`, `[(0/90)_2/45]s`, middle ply `~`) and rule checks R1-R5 |
| `layup_rules_reference.json` | output | 10 notation strings with their expansion and rule verdicts |
| `expected_results.json` | expected values | Every VC value with tolerance, unit, provenance (a quoted / b derived / c TBD) and the FR/TR ids it proves |
| `plans/cmp-flat-panel-zones.json` | draft `build_project` plan | Zone-based flat skin panel (8/16/24 plies), ramps, core samples, rule check, CLT, DXF, ply book |
| `plans/cmp-hemisphere-drape.json` | draft plan | Woven ply draped on the hemisphere, producibility check, flat pattern |
| `plans/cmp-cone-flat-pattern.json` | draft plan | UD ply on a full cone (r = 100, h = 100), developable flat pattern |
| `sources.md` | sources | 40 external sources, what was verified, access date |

The plans use **proposed** command names from TECHNICAL_SPEC §4 (`create_lamina_material`,
`define_rosette`, `create_composite_part`, `define_zone`, `add_ply`, `generate_plies_from_zones`,
`core_sample`, `analyze_laminate`, `check_laminate_rules`, `check_producibility`, `export_flat_patterns_dxf`,
`export_ply_book`). Only `set_units`, `add_box`, `add_sphere` and `add_cone` exist today. The plans become
golden-corpus entries once the commands land.

Run every generator, then confirm the committed outputs still match:

```bash
cd docs/aerospace/06-composites/validation
for g in generate_*.py; do python3 "$g" && python3 "$g" --check; done
```

## 2. Real use cases (why these tests matter)

| Programme / case | Fact (source) | What the user needs from llull | VCs |
| ---------------- | ------------- | ------------------------------ | --- |
| Airbus A350 XWB | Composites are 53 % of the airframe by weight, including the fuselage and wings (S1, S2) | Ply-based skins with thousands of plies, zones, ramps, ply books | VC-CMP-08, 10, 11, 16 |
| Boeing 787 | About half the airframe weight is CFRP and other composites (S3, S4) | Same, plus laminate stiffness to hand off to analysis | VC-CMP-01..07 |
| Lockheed Martin JSF inlet duct (Quickstep, Fibersim) | Engineering time 300 h to 150 h, manufacturing time 450 h to 200 h (S30) | Automatic flat patterns and manufacturing data from the 3D ply model | VC-CMP-14..17 |
| SpaceX fairing boat-tail panel (Fibersim) | Design-to-manufacturing time 7 days to 2 days (S31, secondary source) | Producibility and flat-pattern export without hand templates | VC-CMP-12..16 |
| Doubly curved woven preforms (domes, radomes, nacelle lips) | A hemisphere is the standard forming benchmark (S19); fabrics lock at a characteristic shear angle (S22) | Drape simulation with locking-angle warnings before cutting cloth | VC-CMP-12, 13 |

## 3. Validation cases

Tolerance notation: `rel` = relative, `abs` = absolute. Unless stated otherwise, units are N, mm, MPa and
degrees.

### 3.1 Laminate mechanics (CLT)

**VC-CMP-01: lamina reduced stiffness.** Proves FR-CMP-30 and TR-CMP-30.
For T300/5208 (S10, S11), Q11 = 181 800 MPa and Q22 = 10 340 MPa are **quoted** from S12, rel 1e-3; the
generator gives 181 811 and 10 346.2. Q12 = 2 896.92 MPa is derived from
Q12 = nu12 E2 / (1 - nu12 nu21) with nu21 = nu12 E2 / E1, rel 1e-5.

**VC-CMP-02: unidirectional laminate.** Proves FR-CMP-31.
For [0]8 with h = 1 mm, A = Q h, B = 0 and D = Q h³/12, so D11 = 15 150.9 N·mm. The membrane constants
reproduce E1, E2, G12 and nu12 exactly (rel 1e-9). This holds because a11 = 1/(h (Q11 - Q12²/Q22)), and
Q11 - Q12²/Q22 = E1.

**VC-CMP-03: quasi-isotropic identity.** Proves FR-CMP-31.
With the Tsai-Pagano invariants U1 = (3Q11+3Q22+2Q12+4Q66)/8, U4 = (Q11+Q22+6Q12-4Q66)/8 and
U5 = (Q11+Q22-2Q12+4Q66)/8, any π/n laminate (n ≥ 3, equal thickness per angle) has A11 = A22 = U1 h,
A12 = U4 h, A66 = U5 h and A16 = A26 = 0. Hence:

- Ex = Ey = (U1² - U4²)/U1 = 69 675.7 MPa for T300/5208, and 51 061.4 MPa for AS4/3501-6
- nu = U4/U1
- Gxy = U5 = Ex/(2(1+nu))

The test must give the **same** values for [0/45/-45/90]s and [0/60/-60]s, rel 1e-5.

**VC-CMP-04: symmetry and balance zeros.** Proves FR-CMP-31 and FR-CMP-20.
Every symmetric case has B = 0 (|B| < 1e-9 · max|A| · h). Every balanced case has A16 = A26 = 0. The
generator zeroes round-off below 1e-12 relative. An implementation may keep 1e-9.

**VC-CMP-05: unsymmetric coupling and sign convention.** Proves FR-CMP-31 and TR-CMP-31.
For [0/90]T with t = 0.125 and the 0° ply at the bottom (z in [-t, 0]):
B11 = ½ (Q11 (0 - t²) + Q22 (t² - 0)) = (Q22 - Q11) t²/2 = -1 339.57 N, and B22 = +1 339.57 N.
Flipping the stacking direction flips the sign of B. This test pins llull's convention (bottom to top,
+z = laminate normal). The free-bending membrane modulus Ex (from the 6x6 inverse) is 38 616.0 MPa, against
95 991.3 MPa from A⁻¹ alone. The UI must label which of the two it shows.

**VC-CMP-06: closed-form first-ply failure.** Proves FR-CMP-32.
For [0]8 under Nx, all three criteria give Nx,FPF = Xt h = 1 500 N/mm (T300/5208) and 1 950 N/mm
(AS4/3501-6; the Tsai-Wu quadratic F11 σ² + F1 σ = 1 has root σ = Xt). Under Ny the result is Yt h = 40, and
under Nxy it is S h = 68. Tolerance rel 1e-9.

**VC-CMP-07: multi-ply first-ply failure.** Proves FR-CMP-32.
Strength ratios from `clt_reference.json` (`first_ply_failure_multiplier`), rel 1e-4, critical ply
included:

| Laminate | Material | Load | Max stress | Tsai-Hill | Tsai-Wu (F12* = -0.5) | Critical ply |
| -------- | -------- | ---- | ---------- | --------- | --------------------- | ------------ |
| [0/45/-45/90]s | T300/5208 | Nx | 293.725 | 290.22 | 276.119 | 90° |
| [0/45/-45/90]s | AS4/3501-6 | Nx | 240.958 | 239.15 | 226.587 | 90° |
| [0/90]s | T300/5208 | Nx | 187.139 | 187.118 | 186.698 | 90° |
| [±45]s | T300/5208 | Nx | 68.0 | 66.0979 | 61.6141 | 45° |

These values are derived (provenance b). Before the gate is frozen, cross-check them against one
independent CLT tool. Candidates: the Ansys ACP or Altair laminate tools, or a textbook worked example once
a copy of Kaw or Jones is available. Record the comparison in this file.

### 3.2 Layup definition and design rules

**VC-CMP-08: stacking notation and rules.** Proves FR-CMP-04, FR-CMP-20 and FR-CMP-21.
All 10 cases in `layup_rules_reference.json` must expand to the listed angle arrays exactly and return the
same R1-R5 verdicts with the defaults (max 4 consecutive plies, 10 % minimum per family). Examples:

- `[0_5/45/-45/90]s` fails R4 with a run of 5 plies.
- `[0/45/90]s` fails R2 (unbalanced).
- `[0/90]_2s` fails R3 (no ±45 plies).
- `[45/-45/0_2/90~]s` expands to 9 plies with an unduplicated middle 90° ply.

**VC-CMP-09: rule configuration.** Proves FR-CMP-21.
Re-running `[±45/0_4/90_2]s` with `maxConsecutive: 3` must flip R4 to fail. With `minFraction: 0.3` it must
flip R3 to fail (0° = 0.5, ±45 = 0.25, 90° = 0.25). This is derived from the same JSON.

### 3.3 Zones, core samples and ramps

**VC-CMP-10: core samples (plan `cmp-flat-panel-zones`).** Proves FR-CMP-10 and FR-CMP-11.

- At (50, 50): 8 plies, 1.0 mm thick, angles [45, -45, 0, 90, 90, 0, -45, 45].
- At (300, 200): 24 plies, 3.0 mm thick.
- The report also lists each ply's material, sequence and orientation in global and rosette axes.
- `generate_plies_from_zones` must report that the base stack is a subsequence of the pad stack, which is a
  subsequence of the hole stack (blending feasibility). If any zone pair is not blendable, it must reject the
  input with the zone names.

**VC-CMP-11: ramps and ply drops.** Proves FR-CMP-12.
For rampRatio 20 and t = 0.125, an n-ply step needs a ramp width of n·t·20. The 8-ply step needs 20 mm. The
k-th dropped ply sits 2.5·k mm outside the full-thickness boundary, and the stagger of 2.5 mm satisfies the
minimum of 3 × 0.125 = 0.375 mm. If two zone boundaries are closer than the needed ramp, the check reports
that conflict. In the plan, the gap between the pad and hole boundaries is 60 mm against 20 mm needed, so it
passes. Ratio 20 is a **user rule**: S16 reports that 1:20 suppresses delamination in single-drop specimens,
and it is not presented as a mandated value.

### 3.4 Drape and producibility

**VC-CMP-12: hemisphere kinematic drape.** Proves FR-CMP-40, TR-CMP-40 and TR-CMP-41.
Setup: sphere R = 100, seed at the pole, warp along +x and weft along +y as geodesic generators, step
d = 1 mm. The net is evaluated on the upper hemisphere.

- Shear at the diagonal node nearest a polar angle of 45° (i = 53, polar angle 44.865°): 15.726°, abs 0.6°.
  An independent implementation will place nodes slightly differently. The tolerance covers the O(d)
  discretisation, which is 1.2° at d = 4 and 0.3° at d = 1 against the continuum check below.
- **Gauss-Bonnet / Hazzidakis self-check.** For a Chebyshev net, φ_uv + K sin φ = 0 (S20, S21), where φ is
  the angle between the threads. The mirror symmetry of the set-up about the xz and yz planes forces
  φ = 90° on the generators, because a weft thread crossing the warp generator is mapped onto itself
  reversed. Writing dA = sin φ du dv and integrating over the patch [0,u]×[0,v] gives
  γ(u,v) = 90° - φ(u,v) = K · Area(patch). At d = 1 mm the generator gives |γ - K·A| = 0.20°, 0.30° and 0.38°
  at polar angles 30°, 45° and 60°. **Gate: ≤ 0.5° at d = R/100**, decreasing as d shrinks.
- Shear across the generator ≤ 0.05° at d = 1 mm (symmetry).
- Maximum shear on the hemisphere sits at the equator on the diagonal: 51.894° at d = 1 mm (51.413° at
  d = 2). Richardson estimate for d → 0 is 52.37°. Tolerance abs 1.0°. A published numeric cross-check
  against the S19 hemisphere figures is still **TBD**, because the excerpt did not show the number.

**VC-CMP-13: producibility flags.** Proves FR-CMP-41 and FR-CMP-42.
With the warning and lock limits at 30, 40 and 50°, the flagged fractions of interior quadrant nodes at
d = 1 mm are 0.2149, 0.0852 and 0.0053, abs 0.01. They come from `interior_nodes_over_shear_limit` divided
by `interior_nodes_on_hemisphere`. The producibility report must:

- colour the same regions;
- name the ply;
- suggest a dart or splice when shear exceeds the material `lockingAngle`;
- refuse to emit a flat pattern for nodes past the lock unless `allowOverLock` is set.

The Altair default maximum shear of 55° (that is, 90° - 35° lock) is quoted from S22 only as context.

### 3.5 Flat patterns and exports

**VC-CMP-14: cylinder (developable).** Proves FR-CMP-43.
For r = 50 and L = 200, the flat pattern is a 314.159265 × 200 rectangle (abs 0.01 mm) and the shear is
0 for every fibre angle. A 45° fibre is a straight line in the flat pattern. Its helix pitch on the part is
2πr/tan θ = 314.159 mm, and one turn is 2πr/sin θ = 444.288 mm long.

**VC-CMP-15: cone and frustum.** Proves FR-CMP-43.

- Full cone r = 100, h = 100 (plan `cmp-cone-flat-pattern`): slant s = 141.421356, sector angle
  360·r/s = 254.558441°, area πrs = 44 428.8294 mm². Tolerance rel 1e-4.
- Frustum r1 = 100, r2 = 50, h = 150: R_out = s·r1/(r1-r2) = 316.227766, R_in = 158.113883, sector angle
  113.841996°, area 74 509.412 = π(r1+r2)s.
- Meridians map to radial lines, and geodesic fibres map to straight lines.

**VC-CMP-16: DXF flat pattern round trip.** Proves FR-CMP-50 and TR-CMP-60.
Export the cone ply with `export_flat_patterns_dxf`, re-import it with the existing `import_dxf`, then run
`measure_area`. The closed polyline area must be 44 428.83 mm², rel 2e-3 (arc chord tolerance). The file
must also satisfy the following:

- `$INSUNITS = 4` (mm).
- One layer per ply, named after the ply.
- A text label with the ply name, orientation, sequence and material.
- A 0° orientation arrow on its own layer.
- Exactly one closed boundary per ply piece.

**VC-CMP-17: laser projection export.** Proves FR-CMP-52.
For each ply, the 3D boundary points are ordered with consistent winding. The gap between consecutive
points is at most `spacing` (default 75 mm, about the 3 in practice quoted in S27), and a point is present
at every corner where the turn angle is 20° or more. The file is plain text with x y z in tool coordinates
and a ply header.

**VC-CMP-18: laminate mass.** Proves FR-CMP-33.
The Z-base region alone is 600 × 400 × 1.0 mm at density 0.0016 g/mm³, which gives 384.0 g, rel 1e-6. The
whole-part mass equals the sum of ply-piece area × thickness × density, including the ramp regions.

**VC-CMP-19: STEP AP242 composite export (V2).** Proves FR-CMP-55.
Status **TBD**: validate against the CAx-IF composite recommended practices v4.x (S8) and the validation
properties (S9) with a STEP checker or a CAx-IF test round. The MVP fallback, an explicit per-ply
tessellated solid plus a CSV ply table, is checked structurally: one solid per ply piece, and solid volume =
area × t within 0.5 %.

### 3.6 Architecture and determinism

**VC-CMP-20: purity and replay.** Proves TR-CMP-01, TR-CMP-02 and TR-CMP-03.
Each new mutating command has an `is pure` unit test. Each plan in `plans/` replays to identical ids and
entities, as golden id-normalised snapshots. Derived ply geometry is read-only: editing a derived ply
boundary entity is refused by the derivation guard.

**VC-CMP-21: surface parity.** Proves FR-CMP-60 and TR-CMP-70.
The same plan run through the UI dispatch, `llull --doc plan.json` and the MCP `build_project` gives
identical documents and identical query `data` for `core_sample` and `analyze_laminate`.

**VC-CMP-22: performance budget.** Proves TR-CMP-80.
A 200-ply zone-based panel with 3 zones regenerates in ≤ 2 s on the desktop reference machine. Drape at
d = 2 mm on the hemisphere (about 17 k nodes across 4 quadrants) takes ≤ 500 ms. These are TBD
measurements, recorded with `npm run quality`.

**VC-CMP-23: optional external cross-check (V2).** Proves FR-CMP-56.
`class40.cdb` (S37: MIT licence, sha256 `8446…7bd7`, 963 506 bytes) is the hull mesh used by the PyACP
tutorials. If llull gains an Ansys CDB or mesh import, draping a 0° ply on the hull and comparing shear
against PyACP output is a V2 cross-check. The file is pinned only.

## 4. Traceability matrix (FR → VC)

| FR | VC |
| -- | -- |
| FR-CMP-01..03 (materials) | VC-CMP-01, 06 |
| FR-CMP-04 (notation) | VC-CMP-08 |
| FR-CMP-05..07 (rosettes, part, plies) | VC-CMP-10, 12, 14, 20 |
| FR-CMP-10..13 (zones, core sample, ramps, cores) | VC-CMP-10, 11 |
| FR-CMP-20..22 (rules) | VC-CMP-04, 08, 09 |
| FR-CMP-30..34 (CLT, failure, mass, hand-off) | VC-CMP-01..07, 18 |
| FR-CMP-40..44 (drape, producibility, flat) | VC-CMP-12..15 |
| FR-CMP-50..56 (exports) | VC-CMP-16, 17, 19, 23 |
| FR-CMP-60..62 (surfaces, agents) | VC-CMP-20, 21 |
| FR-CMP-70 (performance) | VC-CMP-22 |

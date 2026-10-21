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
`core_sample`, `analyze_laminate`, `check_laminate_rules`, `check_layup`, `check_producibility`, `export_ply_flat_patterns_dxf`,
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

Every case runs unattended from the CLI (AF-23): `expected_results.json` → `cli_by_vc[<VC>]` gives the call
sequence (`--doc t.llull.json --kernel occt --json`) and the JSON path compared with the case value and
tolerance. Exit codes are asserted (0, or 1 for expected refusals); no UI is involved. The production-gate agent
driver runs them in order.

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
Export the cone ply with `export_ply_flat_patterns_dxf`, re-import it with the existing `import_dxf`, then run
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
The same plan run through the UI dispatch, `llull run plan.json --doc <file>` and the MCP `build_project` gives
identical documents and identical query `data` for `core_sample` and `analyze_laminate`.

**VC-CMP-22: performance budget.** Proves TR-CMP-80.
A 200-ply zone-based panel with 3 zones regenerates in ≤ 2 s on the desktop reference machine. Drape at
d = 2 mm on the hemisphere (about 17 k nodes across 4 quadrants) takes ≤ 500 ms. These are TBD
measurements, recorded with `npm run quality`.

**VC-CMP-23: optional external cross-check (V2).** Proves FR-CMP-56.
`class40.cdb` (S37: MIT licence, sha256 `8446…7bd7`, 963 506 bytes) is the hull mesh used by the PyACP
tutorials. If llull gains an Ansys CDB or mesh import, draping a 0° ply on the hull and comparing shear
against PyACP output is a V2 cross-check. The file is pinned only.

### 3.7 Remaining functional coverage

**VC-CMP-24: cores.** Proves FR-CMP-13.
Add a 10 mm honeycomb core (chamfer 30°) inside Z-base. A core sample through the core lists 4 plies, then
the core, then 4 plies, with total thickness 1.0 + 10.0 = 11.0 mm (derived). At the chamfer mid-run, the
core thickness is 5.0 mm (linear chamfer).

**VC-CMP-25: extra rules.** Proves FR-CMP-22.
With `maxAngleChange: 45`, `[0/90/45/-45]s` is flagged at the 0→90 interface (change of 90°) and at the
45→-45 interface (90°). `[45/0/-45/90]s` passes. Derived by inspection, with angle differences taken modulo
180°.

**VC-CMP-26: FEA laminate sections.** Proves FR-CMP-34.
`export_laminate_sections` on the flat panel gives 3 sections. Their ply lists equal the core samples of
VC-CMP-10, and the sum of t equals the zone thickness: 1.0, 2.0 and 3.0 mm.

**VC-CMP-27: fibre deviation.** Proves FR-CMP-44.
On the cylinder and cone (developable, geodesic generators), the deviation is 0 within 0.01°. On the
hemisphere, the deviation along the generators is 0 within 0.05°. It is non-zero elsewhere and equals the
local warp rotation; this value is reported, not gated.

**VC-CMP-28: ply book.** Proves FR-CMP-51.
For the flat panel, the book has one sheet per sequence label (24 sequences for 24 master plies). Each sheet
holds a 3D view, the flat pattern and a table row whose area equals the DXF piece area within 0.2 %. The
check is structural: the SVG is parsed by the existing sheet tests.

**VC-CMP-29: ply table round trip.** Proves FR-CMP-53.
`export_ply_table`, then `import_ply_table` into an empty part on the same tool, then `export_ply_table`
again: the two CSVs are byte-identical.

**VC-CMP-30: per-ply solids.** Proves FR-CMP-54.
For the flat panel, each ply solid's volume equals area × 0.125 within 0.5 %, solids stack without
interference (`check_model` interference = 0), and `export_step_ap242` contains one MANIFOLD_SOLID_BREP per
ply piece.

**VC-CMP-31: material provenance.** Proves FR-CMP-02 and FR-CMP-03.
The in-plane compliance is positive definite only if 1 − ν12ν21 > 0, that is ν12² < E1/E2. With
E1 = E2 = 10 000, `create_lamina_material` must reject ν12 = 1.1 (1.21 ≥ 1) and accept ν12 = 0.9. With the
T300/5208 moduli, the bound is ν12 < √(181/10.3) = 4.19. The `source` and `basis` strings survive save and
load unchanged.

**VC-CMP-32: parametric regeneration.** Proves FR-CMP-61.
Bind `rampRatio` to parameter `ramp = 20`, then run `set_parameter ramp 30`. The ramp width of the 8-ply
step becomes 30 mm, the flats are regenerated, and undo restores 20 mm. Ids stay identical across the edit
(L8).

**VC-CMP-33: dart and re-drape.** Proves FR-CMP-42, FR-CMP-40 and TR-CMP-40.
Split the hemisphere ply of VC-CMP-12 with 4 darts along the old generators (azimuth 0°, 90°, 180°, 270°,
from the pole to the equator) using `split_ply`. Each of the 4 quadrant pieces is re-draped from the pole with
its warp along its own bisector (azimuth 45° + k·90°). The sphere is rotationally symmetric, so the shear
field of each piece is the VC-CMP-12 field rotated by 45°: the old diagonal becomes a generator and the old
generator (now the piece edge) becomes the diagonal. Expected (derived from `drape_reference.json`):

- 4 pieces with deterministic ids; drape and flats are computed per piece;
- shear on each piece bisector 0°, abs 0.05°;
- shear at the piece-edge node nearest a polar angle of 45°: 15.726°, abs 0.6°;
- maximum shear 51.894° at the equator on the piece edges, abs 1.0°.

This case checks the cut / per-piece re-drape mechanism. The rotated seed alone does not reduce the peak
shear; producibility gains come from flattening the pieces separately and from boundary edits.

### 3.8 Agent-first cases

**VC-CMP-34: stable error codes.** Proves FR-CMP-65 and TR-CMP-81.
A plan with the stacking string `[45/-45/0/9O]s` (letter O), a material with E1 = E2 = 10 000 and ν12 = 1.1,
and two zones whose stacks do not embed (`[0/90]s` and `[45/-45]s`) must be refused by `llull run bad.plan.json
--validate` and by the run, exit 1, with codes `CMP_NOTATION_PARSE`, `CMP_MATERIAL_NOT_POSITIVE_DEFINITE` and
`CMP_ZONES_NOT_BLENDABLE`, each with the step path, the param and a remediation.

**VC-CMP-35: unverified propagation.** Proves FR-CMP-68, FR-CMP-72 and TR-CMP-83.
AS4/3501-6 entered with `basis: "mean"` (the S14 values are typical lamina data, not allowables).
`analyze_laminate`, `laminate_mass` and `check_layup` all report `unverified: true`; `check_layup` lists the
warning `CMP_MATERIAL_UNVERIFIED`, which a threshold or rule config cannot remove; `provenance` names the
material record.

**VC-CMP-36: named defaults and review flag.** Proves FR-CMP-67, FR-CMP-69 and TR-CMP-82.
On the flat panel with no F12* and no rule thresholds given: `analyze_laminate` reports
`defaults.tsaiWuF12Star = {value: -0.5, unit: "-", defaulted: true, source: "S36"}`; `check_layup
purpose=release` reports the R3 / R4 thresholds (0.10, 4) and the ramp ratio (20) as `NamedDefault` with
`defaulted: true`, a `CMP_DEFAULT_USED` warning, and `reviewRequired: true` with a reason. A drape on a material
without `lockingAngle` is refused with `CMP_DRAPE_LIMIT_MISSING` (no default allowed).

**VC-CMP-37: human gate on a negative margin.** Proves FR-CMP-71 and TR-CMP-82.
Z-base [45/-45/0/90]s T300/5208 under Nx = 400 N/mm: the Tsai-Wu strength ratio is 276.119 / 400 = 0.690 < 1
(from VC-CMP-07, linear scaling), so `check_layup` fails with `CMP_FPF_RATIO_BELOW_ONE`. The agent calls
`request_layup_waiver` (accepted, pending). An agent-caller `record_approval` through 09 PLM is refused
(TR-PLM-16, enforceable on an authenticated server). `check_layup` still fails with `waiverStatus: "pending"` and
`CMP_WAIVER_PENDING`.

**VC-CMP-38: units, discovery and data shapes.** Proves FR-CMP-60, FR-CMP-63, FR-CMP-64 and TR-CMP-84.
`llull search laminate ply drape` returns `create_lamina_material`, `define_zone`, `generate_plies_from_zones`,
`analyze_laminate`, `check_layup`, `drape_ply`; for every composites command `llull describe <cmd> --json` has a
unit in every numeric param description, and every number in query `data` has a unit field or suffix.

## 4. Traceability matrix (FR → VC)

| FR | VC |
| -- | -- |
| FR-CMP-01 | VC-CMP-01, 06 |
| FR-CMP-02, 03 | VC-CMP-31 |
| FR-CMP-04 | VC-CMP-08 |
| FR-CMP-05 (rosettes) | VC-CMP-12, 14, 15 (orientation from rosette) |
| FR-CMP-06 (part on face) | VC-CMP-10, 12, 15, 20 |
| FR-CMP-07 (plies) | VC-CMP-12, 14, 20 |
| FR-CMP-10, 11 | VC-CMP-10 |
| FR-CMP-12 | VC-CMP-11, 32 |
| FR-CMP-13 | VC-CMP-24 |
| FR-CMP-20 | VC-CMP-04, 08 |
| FR-CMP-21 | VC-CMP-08, 09 |
| FR-CMP-22 | VC-CMP-25 |
| FR-CMP-30 | VC-CMP-01 |
| FR-CMP-31 | VC-CMP-02..05 |
| FR-CMP-32 | VC-CMP-06, 07 |
| FR-CMP-33 | VC-CMP-18 |
| FR-CMP-34 | VC-CMP-26 |
| FR-CMP-40 | VC-CMP-12 |
| FR-CMP-41 | VC-CMP-13 |
| FR-CMP-42 | VC-CMP-13, 33 |
| FR-CMP-43 | VC-CMP-14, 15 |
| FR-CMP-44 | VC-CMP-27 |
| FR-CMP-50 | VC-CMP-16 |
| FR-CMP-51 | VC-CMP-28 |
| FR-CMP-52 | VC-CMP-17 |
| FR-CMP-53 | VC-CMP-29 |
| FR-CMP-54 | VC-CMP-30, 19 |
| FR-CMP-55 | VC-CMP-19 |
| FR-CMP-56 | VC-CMP-23 |
| FR-CMP-60, 62 | VC-CMP-21, 38 |
| FR-CMP-61 | VC-CMP-32, 20 |
| FR-CMP-70 | VC-CMP-22 |
| FR-CMP-63, 64 | VC-CMP-38 |
| FR-CMP-65 | VC-CMP-34 |
| FR-CMP-66 | VC-CMP-36, 37 (and every plan ends with `check_layup`) |
| FR-CMP-67 | VC-CMP-36 |
| FR-CMP-68 | VC-CMP-35 |
| FR-CMP-69 | VC-CMP-36 |
| FR-CMP-71 | VC-CMP-37 |
| FR-CMP-72 | VC-CMP-35 |

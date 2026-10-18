# Gap 05 FEA: validation pack

This pack proves a future implementation of the FEA / CAE hand-off described in `../FUNCTIONAL_SPEC.md`
(`FR-FEA-*`) and `../TECHNICAL_SPEC.md` (`TR-FEA-*`). Every expected value falls into one of three groups:

- **(a) Quoted** from a source in [`sources.md`](sources.md).
- **(b) Derived** by [`generate_fea_analytic.py`](generate_fea_analytic.py) from a cited formula. The script
  needs only the Python standard library and is deterministic. Run it with `python3 -I generate_fea_analytic.py`.
- **(c) Extracted** from a pinned public reference output (CalculiX `.ref` files), or marked **TBD** with the
  tool to measure it.

Tolerances are **llull acceptance choices**, explained per case. No source claims them.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_fea_analytic.py` | generator | Writes the four analytic files below. |
| `fea_analytic_expected.json` | (b) | VC-FEA-10…14, 20…22 and 60…65: cantilever deflection/stress/moment, natural frequencies, Euler buckling, SS-plate buckling, Kirsch Kt, margin-of-safety table, von Mises tensors, unit conversion, and the agent-first result contract (named factors, `reviewRequired`, human gate, unverified propagation, error codes). Each case has value, unit, tolerance, derivation, source ids and cross-checks against CalculiX. |
| `cantilever_modes.csv` | (b) | Clamped-free roots βnL (n = 1…6) and frequency ratios. |
| `kirsch_hole_profile.csv` | (b) | σxx/S along the transverse axis (y/a = 1…10), and the hoop stress on the hole edge versus θ. |
| `plate_buckling_k.csv` | (b) | k_min(a/b) and the number of half-waves for a simply supported plate in uniaxial compression, a/b = 0.2…5.0. |
| `mesh_quality_reference.json` | (b) + (a) | Verdict metrics of reference elements (regular, tri-rectangular, sliver and inverted tet; square, 2:1 and 10:1 quads), plus the acceptable ranges quoted from Verdict [S12]. |
| `nafems_benchmarks.json` | (a) | NAFEMS LE1 and LE10: geometry, BCs, loads, targets (92.7 MPa and −5.38 MPa), and pinned FeenoX geometry/STEP files (URL + sha256, GPL so not stored here). |
| `calculix_reference_cases.json` | (c) | Five CalculiX test-suite decks with sha256 values and the reference numbers extracted from `.dat.ref`/`.frd.ref` at a pinned commit (GPL, not stored here). |
| `plans/*.plan.json` | draft plans | `build_project` action lists. The geometry steps use existing llull commands. The analysis steps use the **proposed** commands of TECHNICAL_SPEC §4 (`create_analysis`, `set_part_idealization`, `add_fea_constraint`, `add_fea_load`, `set_mesh_controls`, `add_result_probe`) and the **proposed gap 08** material commands (`define_material_record`, `set_material_property`, `create_material` + `recordId`). They stay drafts until those commands exist. |
| `sources.md` | register | Every external source, its access date, and what was verified. |

No third-party file is stored in this folder. Every external file is GPL (CalculiX, FeenoX) or too large
(the Gmsh wheel), so each one is pinned by URL, commit and sha256. The M4 test fixture loader downloads
them into a git-ignored cache and checks their hashes.

## Real use cases (value statements are sourced)

| # | Use case | Who / programme | Evidence of value | Cases |
| - | -------- | --------------- | ----------------- | ----- |
| U1 | Show that a part has positive margins under limit loads × 1.5 | Every part 25 transport-category airframe structure | 14 CFR 25.303 requires FoS = 1.5 on limit loads, and 25.305 requires ultimate loads to be carried 3 s without failure [S1, S1a]. The factor has been US practice since the Air Corps adopted it in 1930/1934 [S5]. | VC-FEA-20, 30, 31 |
| U2 | Spaceflight hardware margins | NASA programmes and suppliers | NASA-STD-5001B defines MS = allowable / (limit × FoS) − 1 for yield and ultimate [S2]. NASA-HDBK-5026 requires positive MS [S4]. | VC-FEA-20 |
| U3 | Hand a mesh/deck to the analysis department's Nastran | OEM stress offices. NASTRAN has been the NASA structural analysis system since the early 1970s, "the first of its kind" [S31]. | The BDF card set (GRID, CTETRA, CQUAD4, PSHELL, MAT1, SPC1, FORCE, PLOAD4) is the de facto exchange format, and open tools read and write it (pyNastran [S14], meshio [S13], Gmsh [S10]). | VC-FEA-15 |
| U4 | Fully open, offline analysis loop on a desktop | Small suppliers, universities, CubeSat teams | FreeCAD FEM already chains Gmsh/Netgen → CalculiX → FRD import [S15], which shows the stack works. CalculiX ships 638 regression decks with reference outputs [S30]. | VC-FEA-16, 40–44 |
| U5 | Solver/element verification before trusting results | All analysis groups | Commercial vendors publish NAFEMS LE1/LE10 verification (Abaqus, OptiStruct, COMSOL [S40–S45]). Open-source FeenoX + Gmsh reproduces 92.7011 and −5.37968 MPa [S43]. | VC-FEA-30, 31 |

## Validation cases

Status: **P** = proposed (no implementation yet). Every case runs on the **desktop OCC kernel**, with the
bundled CPython (Gmsh) and CalculiX, unless the Gate column says otherwise.

| VC | Proves | Setup | Expected | Tolerance | Source | Gate |
| -- | ------ | ----- | -------- | --------- | ------ | ---- |
| VC-FEA-01 | FR-FEA-01, 07, 08, 22; TR-FEA-01, 02 | Run `plans/fea_cantilever_static_beamp.plan.json`, then save, load and `replay_history`. | `analysis` slice deep-equal after the round-trip. Ids are step-scoped and identical. `is pure` holds for every new command. | exact | L1 (L3, L8) | unit + golden |
| VC-FEA-02 | FR-FEA-02 | Gap 08 `set_material_property` on a record: E = 70 GPa and ν = 0.33; also ν = 0.5, ν = −1.2 and E ≤ 0. Then build the `FeaMaterialView`. | First calls accepted, and the view gives E = 70000 MPa, G = 26315.8 MPa (derived) in N-mm-t-s. The others are rejected with `invalid params` or a validation summary, and the doc is unchanged. | exact | — | unit |
| VC-FEA-03 | FR-FEA-05; TR-FEA-20 | (i) `add_box` 100×50×2 with `anchor: "min"`, then `extract_midsurface`. (ii) `add_box` 100×60×40, `shell_solid` thickness 2 inward with no open face, then `extract_midsurface`. | (i) One planar face at z = 1 of area 5000 mm². (ii) A closed midsurface 98×58×38 of area 2(98·58 + 98·38 + 58·38) = **23 224 mm²** (derived). Coverage 100 % and no unpaired faces. | area ±0.1 %, position ±1e-6 | derived | unit (OCC) |
| VC-FEA-04 | FR-FEA-06 | Box 100×50×10 minus a cylinder r = 1 through z, then `defeature` with maxFeatureSize = 3. | The derived analysis shape has volume 50 000 mm³ (box). Design entity volume is unchanged: 50 000 − π·1²·10 = 49 968.584 mm³ (derived). | ±1e-6 rel | derived | unit (OCC) |
| VC-FEA-05 | FR-FEA-07; TR-FEA-03 | beamp plan, then `set_parameter`-driven length change 8 → 10 (parametrised variant), then replay. | The `facesNear` root and tip targets re-resolve to the faces at z = 0 and z = 10. The report shows 0 unresolved targets. | exact | KI5 (L1) | golden |
| VC-FEA-06 | FR-FEA-09; TR-FEA-30 | Mesh the beamp model twice (`General.NumThreads = 1`). | Same `meshHash` (sha256 of the canonical node and element arrays). | exact | — | integration (desktop) |
| VC-FEA-07 | FR-FEA-10; TR-FEA-31 | The TS Verdict port (`@lib/meshQuality`) evaluated on the elements of `mesh_quality_reference.json`. | Regular tet: SJ = 1, AR = 1. Tri-rectangular tet: SJ = 0.707107, AR = 1.36603. Sliver: SJ = 0.10567, AR = 8.22575. Inverted: SJ = −1. Quads: AR = 1, 1.5, 5.5. | 1e-6 abs | (b) [S12] | unit |
| VC-FEA-08 | FR-FEA-10 | Inject one inverted tet into a mesh artifact, then run the `fea_export` transport. | Export refused. The summary names the element count with SJ ≤ 0. | exact | — | unit |
| VC-FEA-09 | FR-FEA-09 | Mesh a 10 mm cantilever with one element through the span (globalSize ≥ L). | Warning "fewer than 2 elements through span / thickness". CalculiX simplebeam shows a 10 % stiff result with 1 element (VC-FEA-43). | exact | (c) [S30] | unit |
| VC-FEA-10 | FR-FEA-16, 17, 21 | beamp plan, then mesh (tet10, h = 0.25), CalculiX solve, import. | Tip u_y = 0.0877714 mm (EB) [10.a]. Root σ (surface, z ≥ 2h from the root) = 432 MPa × (L−z)/L [10.c]. M(z = 6) = 18 N·mm [10.d]. | 2 % / 5 % / 0.1 % | (b) + CalculiX 0.0876111 | integration (desktop) |
| VC-FEA-11 | FR-FEA-19 | beamf plan, modal analysis with 4 modes. | f1 = 13096.7 Hz (EB weak axis), f2 = 19645.1 Hz (strong axis), f3 = 82075.8 Hz. CalculiX reference: 13096.03 / 19319.52 / 76839.71 Hz. **f3 pairing TBD**: that CalculiX mode 3 is the 2nd weak-axis bending mode (not torsion, rough estimate ≈ 85 kHz) must be confirmed from the `beamf.frd.ref` mode shape before 11.c is used as a gate. | 1 % / 3 % / 8 % vs EB, 1 % vs CalculiX ref | (b) + (c) | integration |
| VC-FEA-12 | FR-FEA-20 | Column 20×10×500 mm, fixed-free, E = 70 GPa (test input), axial unit load, linear buckling. | P_cr = π²EI/(4L²) = **1151.45 N**. | 2 % | (b) | integration |
| VC-FEA-13 | FR-FEA-20, 21 | SS plate 600×200×2 mm, E = 70 GPa, ν = 0.33, uniform edge compression on the 200 edges. Shell quad8, out-of-plane w = 0 on all edges, in-plane rigid-body modes removed. | σ_cr = **25.8434 MPa** (k = 4, m = 3). `plate_buckling_k.csv` covers other a/b. | 3 % | (b) [S22] | integration |
| VC-FEA-14 | FR-FEA-17, 21 | `plans/fea_plate_hole_kirsch.plan.json`: quarter plate, W/d = 10, 100 MPa remote tension. | σxx(0, a) = 3 × 100 = **300 MPa** (gross Kt = 3). The profile along y follows `kirsch_hole_profile.csv` for y/a ≤ 3. | 5 % at the hole edge, 3 % on the profile | (b) [S21] | integration |
| VC-FEA-15 | FR-FEA-11, 12; TR-FEA-40, 41 | Export the beamp model as `.inp` and `.bdf`. | `.inp`: CalculiX 2.2x exits 0 and the result matches VC-FEA-10. `.bdf`: pyNastran `read_bdf(xref=True)` passes. Card counts: GRID = nodes, CTETRA = elements, MAT1 = 1, PSOLID = 1, SPC1 ≥ 1, FORCE = loaded nodes. Σ FORCE = (0, 9, 0) N. | exact / 1e-9 | [S14, S30] | integration (CI Python) |
| VC-FEA-16 | FR-FEA-13 | Parse the pinned `beamp.frd.ref`, `beamf.frd.ref` and `simplebeam.frd.ref` [S30]. | beamp: 261 nodes, mean tip U2 = 0.0876111. beamf: 10 PMODE blocks. simplebeam: node 1 U1 = 9.22015e-2. | exact (string → float) | (c) | unit (fixture download) |
| VC-FEA-17 | FR-FEA-17, 17b | VC-FEA-14 result rendered with field = von Mises and deformation ×100. | Legend max equals the max nodal von Mises (data). Screenshot diff against the golden image is ≤ 1 % of pixels. | — | — | e2e (Playwright) |
| VC-FEA-18 | FR-FEA-14 | Read an OP2 written by a Nastran-compatible solver from the VC-FEA-15 BDF. | TBD: measure with pyNastran on an OP2 produced by MYSTRAN or a licensed Nastran (fixture to be produced and pinned). | — | TBD | integration (optional) |
| VC-FEA-19 | FR-FEA-15 | Export VTU of the VC-FEA-10 results. Read it back with meshio. | Same node count, and point data `displacement` and `von_mises` present. | exact | [S13] | integration |
| VC-FEA-20 | FR-FEA-18 | `compute_margins` with allowable/limit pairs from `fea_analytic_expected.json` and FoS 1.5. | MS = 0.0, 0.5, 0.0, −0.0666667. A negative MS is flagged `FAIL`. | 1e-9 | (b) [S1, S2] | unit |
| VC-FEA-21 | FR-FEA-17, 18 | von Mises of the 4 tensors. | 100, 86.6025, 0, 157.083 MPa (12 significant digits in the JSON). | 1e-9 rel | (b) | unit |
| VC-FEA-22 | FR-FEA-25 | mm document, material density 0.0078 g/mm³, written to the deck. | `*DENSITY` / MAT1 RHO = 7.8e-9 (t/mm³). E = 2.1e11 Pa is written as 210000 (MPa). | 1e-12 rel | (b) [S30] | unit |
| VC-FEA-23 | FR-FEA-03, 18 | `compute_margins` on (i) a gap 08 record without Ftu/Fty and no explicit allowable, and (ii) a record with Ftu and Fty `PropertyValue`s at basis `B` with provenance `{ sourceId: 'MAT:<id>', locator }`. | (i) Refused, with a summary naming the material. (ii) Each row carries `basis` and `provenance` unchanged. | exact | gap 08 | unit |
| VC-FEA-24 | FR-FEA-26 | LE10 meshed with `mesher: 'netgen'` (tet10). | σyy(D) = −5.38 MPa. | 3 % | (a) | integration (optional) |
| VC-FEA-25 | FR-FEA-27 | beamp with `elementFamily: 'hex_dominant'` (Gmsh transfinite + recombine). | Tip u_y = 0.0877714 mm (EB). | 2 % | (b) | integration |
| VC-FEA-26 | FR-FEA-29 | VC-FEA-15 BDF run in a user-configured Nastran-compatible solver, OP2 imported (as VC-FEA-18). | Tip u_y within 2 % of VC-FEA-10. TBD: needs a solver install (MYSTRAN licence not verified). | 2 % | TBD | manual / optional |
| VC-FEA-27 | FR-FEA-30 | V2: a laminate from gap 06 exported as `*SHELL SECTION, COMPOSITE` / PCOMP. | TBD: reuse the gap 06 classical-laminate-theory expected values (ABD) for an equivalent plate-bending check. | TBD | gap 06 pack | deferred |
| VC-FEA-30 | FR-FEA-04, 11, 24 | `plans/fea_nafems_le1.plan.json`: plane stress, quad8, h = 50. | σyy(D) = **92.7 MPa**. | 2 % | (a) [S40–S43] | quality gate |
| VC-FEA-31 | FR-FEA-09, 11, 24 | `plans/fea_nafems_le10.plan.json`: tet10, refined at D. Variant: import the pinned FeenoX `nafems-le10.step`. | σyy(D) = **−5.38 MPa**. | 3 % | (a) [S43–S45] | quality gate |
| VC-FEA-40 | FR-FEA-13, 16 | Rebuild beamp natively, export `.inp`, and run it next to the pinned `beamp.inp`. | Section shear 8.99964 N and moment 17.99943 N·mm (from the reference deck run). Native deck tip u_y within 2 % of 0.0876111. | 1e-4 rel (ref deck), 2 % (native) | (c) | integration |
| VC-FEA-41 | FR-FEA-19 | Run the pinned `beamf.inp`, then import. | 10 frequencies equal `calculix_reference_cases.json`. | 1e-4 rel | (c) | integration |
| VC-FEA-42 | FR-FEA-20 | Run the pinned `beamb.inp`, then import. | 10 buckling factors equal the reference (48.15456 …). | 1e-4 rel | (c) | integration |
| VC-FEA-43 | FR-FEA-09 | Run the pinned `simplebeam.inp`. | Tip ux = 0.0922015 (1-element result, not analytic). | 1e-4 rel | (c) | integration |
| VC-FEA-44 | FR-FEA-04 | Run the pinned `shell1.inp` and `shellf.inp`, then parse. | TBD: values extracted by the M3 parser and frozen. | 1e-4 rel | (c) | integration |
| VC-FEA-28 | FR-FEA-22; TR-FEA-33 | Call `record_fe_mesh` / `record_fea_results` through `execute` with (i) a hash absent from the artifact store, (ii) a real hash but an edited summary (node count + 1), (iii) the genuine summary. | (i) and (ii) no-op with "artifact not found" / "summary mismatch". (iii) accepted. | exact | — | unit (fake artifact port) |
| VC-FEA-29 | TR-FEA-92 (planned, RS-5) | VC-FEA-17 plot (VC-FEA-14 result, von Mises, deformation ×100) and one large plot, rendered headless by the TS raster and by `llull-compute raster` (GPU and its CPU twin) at the same size and view. | Same legend, levels, min / max data and SVG frame. Native PNG vs TS PNG: share of differing pixels and max band-index difference within tolerance. `data.raster.engine` names the path; GPU runs carry `deterministic: false`. | pixel tolerance TBD — measure (band edges and silhouettes are where they may differ) | [RS1](../../../decisions/RS1-native-compute.md) | native + server tests |
| VC-FEA-60 | FR-FEA-31, 37; TR-FEA-90 | `llull compute_margins analysisId=$an --json` on the VC-FEA-20 rows with no factors given. | `data.factors` deep-equals `fea_analytic_expected.json` VC-FEA-60 (`ultimate` 1.5 from 14 CFR 25.303, `defaulted: true`; `yield` 1.0). | exact | (b) [S1, S1a] | unit + CLI |
| VC-FEA-61 | FR-FEA-18, 32, 37 | Same call. | Every row matches VC-FEA-61 (unit-suffixed `appliedMPa`/`allowableMPa`, `ms`, `status`, `reviewRequired: true` with `reviewReason`, `disposition`). `data.reviewRequired` is true and `summary` contains "not approved". | ms 1e-9 abs; rest exact | (b) | unit + CLI |
| VC-FEA-62 | FR-FEA-33, 35 | `llull check_analysis analysisId=$an --json` after VC-FEA-61. | `data.status: "fail"`; codes `FEA_MS_NEGATIVE`, `FEA_DISPOSITION_PENDING`, `FEA_MARGINAL_BAND_UNSET`. | exact | — | unit + CLI |
| VC-FEA-63 | FR-FEA-33; TR-FEA-91 | Agent runs `llull dispose_margin analysisId=$an rowId=r4 decision=accepted justification="…" --json` (no human signature). | Exit 1, `data.code: "FEA_HUMAN_GATE"`, document hash unchanged, row r4 still `pending_human`. | exact | — | unit + CLI |
| VC-FEA-64 | FR-FEA-34 | VC-FEA-61 set-up with E taken from a gap 08 record at basis `typical` (`unverified`). | Margin rows and results summary carry `unverified: true` with the reason; `check_analysis` has warning `FEA_MATERIAL_UNVERIFIED`. The mesh summary stays unflagged (it does not use the material). | exact | — | unit |
| VC-FEA-65 | FR-FEA-36 | The nine deliberately wrong set-ups listed in VC-FEA-65 of the JSON. | Each: exit 1, the listed `data.code`, non-empty `data.remediation`, `data.ids` or `data.path`. | exact | TECHNICAL_SPEC §7.1 | unit + CLI |
| VC-FEA-50 | FR-FEA-22 | VC-FEA-10, then `set_parameter` length = 10. | Results marked `stale`. `compute_margins` refuses stale results with a summary naming the changed recipe. | exact | — | golden |
| VC-FEA-51 | FR-FEA-23 | Run the same plan through UI dispatch, `llull --doc plan.json`, and MCP `build_project`. | Identical document hash and identical deck sha256. | exact | — | integration (server tests) |
| VC-FEA-52 | FR-FEA-28 | Desktop package. | `ccx` and the gmsh module are present. `resources/licenses/{CalculiX,Gmsh}` contain the GPL text, plus a source offer or source archive. The About box lists them. | exact | [S10, S30] | desktop tests |
| VC-FEA-53 | FR-FEA-09, 16; TR-FEA-80 | LE10, tet10, about 50k nodes, on the reference machine. | Mesh plus solve plus import in under 60 s. TBD: measure on the CI desktop runner and freeze. | — | TBD | production gate |

## CLI harness (AF-23)

Every VC runs unattended as a script; no UI is involved except VC-FEA-17 (screenshot) and the human-gate check of VC-FEA-63
(which asserts that the agent path is refused). Pattern, with `D="--doc case.llull.json --kernel occt --json"`:

```bash
an=$(llull run plans/fea_cantilever_static_beamp.plan.json $D | jq -r '.data.steps[] | select(.command=="create_analysis") | .affected[0]')
llull fea_mesh analysisId=$an $D --timeout 300 > mesh.json
llull check_analysis analysisId=$an $D > check.json            # must not contain severity "error"
llull fea_solve analysisId=$an $D --timeout 900 > solve.json
llull fea_report analysisId=$an $D > report.json               # probe "tip" u_y vs VC-FEA-10.a (2 %)
llull compute_margins analysisId=$an $D > margins.json         # VC-FEA-60/61 shape
python3 -I compare.py report.json fea_analytic_expected.json VC-FEA-10.a   # value, tolerance, unit
```

The comparison script (M4, `server/tests`) reads `value`, `tolerance_rel`/`tolerance_abs` and `unit` from
`fea_analytic_expected.json`, and the reference numbers of `calculix_reference_cases.json` / `nafems_benchmarks.json`. Exit codes
are asserted too (0 on success, 1 with `data.code` on the refusal cases).

## How the gates run (proposal)

- `npm test`: unit cases (02, 07, 08, 09, 16, 20, 21, 22) with no external process. FRD fixtures are
  downloaded by hash or skipped with an explicit `SKIPPED (fixture)` line.
- `npm --prefix server test`: integration cases that need the Python bridge (Gmsh) and `ccx`. They are
  skipped when `LLULL_CCX` is unset.
- `npm run quality` gets a new `quality:fea` step that runs VC-FEA-30/31 and the analytic cases 10–14 on the OCC
  kernel and writes a table like `quality/drawings/README.md`.
- `npm --prefix desktop test`: VC-FEA-52.
- `npm run native:check` + `npm --prefix server test`: VC-FEA-29 (RS-5 native raster), skipped with a logged reason when
  `llull-compute` is missing; the GPU half also skips without an adapter, the CPU twin always runs.

## Re-generating

```bash
cd docs/aerospace/05-fea-cae-handoff/validation
python3 -I generate_fea_analytic.py   # rewrites fea_analytic_expected.json, *.csv, mesh_quality_reference.json
git diff --stat .                     # must be empty unless the generator changed
```

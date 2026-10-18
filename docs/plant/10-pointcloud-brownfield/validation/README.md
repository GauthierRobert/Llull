# Gap 10 SCN — Validation pack

This pack checks llull's point-cloud and brownfield commands against reference values. Every reference comes from one of
three places:

- **Real files read by two independent readers.** These are E57 and LAS / LAZ test files from libE57Format, pye57 and laspy.
  Each is read by our own Python reader and by the reference library. For E57, the libE57Format unit-test assertions are a
  third check.
- **Closed forms on synthetic clouds.** The clouds are generated with fixed seeds, so the true geometry is known exactly.
  Tolerances come from the noise level (Cramér–Rao bound) or from exact geometry.
- **A reference algorithm run in a scratch venv** (numpy / scipy). It shows that each tolerance can be met by a published
  method.

**No expected value was produced by running llull.** Sources and grades are listed in [sources.md](sources.md).

All cases run unattended once the commands exist:

- Unit tests read `data/*.json` directly, in the same way as the other packs (`tests/unit/scan/*.test.ts`).
- `server/tests/packReplay10scn.test.ts` imports the files with the host transport (`llull scan import`). It then runs every
  `plans/*.json` through `build_project` and compares the results with `expected_results.json`. This is the same path as
  `llull run plan.json --json` (AF-23).

## Gate policy

- Only **grade A** values and **cited closed forms** are pass / fail thresholds.
- Tolerances marked **TOL-ENG** are engineering choices. They are stated, bounded from below by the noise, and never tighter
  than the CRLB. They gate the llull implementation, but they are not claims about any standard.
- Cases marked **REF-TBD** have generator truth but no reference-algorithm run yet. They gate once the run in
  `data/tools/reference_check.py` is extended to cover them (TECHNICAL_SPEC §9). Until then they report and do not fail.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/e57/*.e57` (10 files) | E57 test files: coloured cube (float / double), bunny (double / ScaledInteger int32), empty, zero points, bad CRC, LAS-derived attributes, normals, pose with translation | A |
| `data/las/*.las, *.laz` (10 files) | LAS 1.1 / 1.2 / 1.3 / 1.4, PDRF 1 / 3 / 4 / 6, EVLR, extra bytes, LAZ pairs, a 110 000-point LAZ tile | A |
| `data/e57_reference.json` | Per file: sha256, version, page size, CRC status, GUID, scans, point counts, fields, pose, local bounds and centroid, file-frame centroid. Lists `test.e57` / `testSpherical.e57` by hash | A |
| `data/las_reference.json` | Per file: version, PDRF, compression, record length, counts, scale, offset, header bounds, decoded bounds and centroid, return and class histograms, header-vs-data flag | A |
| `data/synthetic/*.csv` + `data/synthetic_truth.json` | 8 synthetic clouds (cylinders, elbow, IPE 300, sphere targets, scanned DN200 run) with ground truth, CRLB and tolerances | closed form |
| `data/tools/*.py` | `e57_own_reader.py`, `las_own_header.py` (independent readers), `e57_pye57_reference.py`, `las_laspy_reference.py`, `gen_synthetic.py` (generator), `reference_check.py` (reference algorithms) | — |
| `data/reference_check_output.json` | Output of `reference_check.py` on this data (all pass) | A (run) |
| `data/licenses/` | CC0 1.0, libe57.org Test Data License, pye57 MIT, laspy BSD-2 | — |
| `expected_results.json` | Index of every VC: command, inputs, expected value, tolerance, source, test file | — |
| `plans/sc-scn-0*.json` | CLI scenarios (`build_project` actions + `expected` rows, with host prerequisites) | — |

Reproduce the references (Python ≥ 3.10; run from any directory; the tools only read files):

```
python3 -m venv /tmp/scnvenv && /tmp/scnvenv/bin/pip install --only-binary :all: pye57==0.4.19 laspy==2.7.0 lazrs==0.8.2 numpy scipy
python3 -I data/tools/e57_own_reader.py data/e57/*.e57
/tmp/scnvenv/bin/python -I data/tools/e57_pye57_reference.py data/e57/*.e57
python3 -I data/tools/las_own_header.py data/las/*
/tmp/scnvenv/bin/python -I data/tools/las_laspy_reference.py data/las/*
/tmp/scnvenv/bin/python -I data/tools/gen_synthetic.py /tmp/scn-out        # byte-identical to data/synthetic
/tmp/scnvenv/bin/python -I data/tools/reference_check.py data               # all "pass": true
```

## Real use cases

| # | Use case | What llull must do | VC |
| - | -------- | ------------------ | -- |
| U1 | Revamp of a pump skid: the contractor delivers one E57 per scanner station, already registered | Import E57, keep the station poses, stream the cloud in the viewport, snap to points, slice at pipe-rack level | VC-SCN-01..05, 12, 24, SC-SCN-01 |
| U2 | An aerial / mobile LiDAR tile of the site (LAS / LAZ, georeferenced) as a context for a new pipe rack | Import LAS / LAZ with large coordinates without precision loss; LOD streaming | VC-SCN-06..10, SC-SCN-01 |
| U3 | Model the existing DN100 / DN200 lines from the scan so that new lines can tie in | Cylinder extraction, DN snap, centreline and elbow tracing, then pipe runs flagged as-built | VC-SCN-20..22, SC-SCN-02 |
| U4 | Two unregistered scans of the same area | Target-based coarse registration, ICP fine registration, a quality report | VC-SCN-30..32, SC-SCN-03 |
| U5 | Before fabrication: does the new spool clash with existing plant, and was the old line built where the design says? | Cloud-to-model deviation and design-vs-cloud clash with clearance | VC-SCN-40..43, SC-SCN-04 |
| U6 | Existing steel: add a new platform beam to an existing IPE column | Steel profile fit against the catalogue | VC-SCN-23, SC-SCN-05 |

## Validation cases

### Import and formats (FR-SCN-01..07, 11)

| VC | What | Reference | Tolerance | Test |
| -- | ---- | --------- | --------- | ---- |
| VC-SCN-01 | E57 inventory of 10 files: `data3D` count, `recordCount` per scan, prototype fields, file GUID, version 1.0, page size 1024 | `e57_reference.json`; libE57Format assertions: ColouredCubeFloat 7 680, bunnyDouble / bunnyInt32 30 571, ZeroPoints 0, empty 0 scans [S2] | exact | `scan/e57Reader.test.ts` |
| VC-SCN-02 | Corrupt page: `bad-crc.e57` is refused with `SCN_E57_CHECKSUM` (page 0 CRC-32C mismatch) and no asset is written | libE57Format throws `ErrorBadChecksum`; our reader finds 1 bad page [S2] | exact code | `e57Reader.test.ts`, server transport test |
| VC-SCN-03 | Empty clouds: `empty.e57` (0 scans) and `ZeroPoints.e57` (1 scan, 0 points) give `SCN_CLOUD_EMPTY`; nothing is attached | [S2] | exact code | `e57Reader.test.ts` |
| VC-SCN-04 | Encodings: `bunnyInt32.e57` (ScaledInteger, scale 1e-6) and `bunnyDouble.e57` decode to the same 30 571 points; local bounds [−0.094689, 0.040011, −0.061873]..[0.061009, 0.187321, 0.058799] m, centroid [−0.027513, 0.103078, 0.008644] m | `e57_reference.json` (pye57) | max point difference ≤ 5e-7 m (half the ScaledInteger quantum); bounds and centroid ±1e-6 m | `e57Reader.test.ts` |
| VC-SCN-05 | Pose: `translationWithoutRotation.e57` (4 points, local centroid [0.5, 0.5, 0], pose translation [4, 5, 6], identity rotation) → file-frame centroid [4.5, 5.5, 6.0]. `ColourRepresentation.e57` exposes `returnIndex`, `returnCount`, `pointSourceId` and colour fields for its 153 points | `e57_reference.json` (pye57 `transform=True`) | 1e-9 m; field list exact | `e57Reader.test.ts` |
| VC-SCN-06 | LAS / LAZ inventory of 10 files: version, PDRF, compressed flag, record length, VLR / EVLR counts, point count, scale, offset; the decoded point count equals the header count | `las_reference.json` [S4, S5] | exact; scale and offset bit-exact doubles | `scan/lasReader.test.ts` |
| VC-SCN-07 | LAZ equals LAS: `simple.laz` ≡ `simple.las` (19 dimensions) and `1_4_w_evlr.laz` ≡ `1_4_w_evlr.las` (18 dimensions), every dimension of every point | laspy + lazrs comparison (this pack) | bit-exact | `lasReader.test.ts` (with the LAZ decoder port) |
| VC-SCN-08 | Inconsistent header: `simple1_3.las` stores bounds in record units (min x −235434519) while the data spans −235434.519..−234935.841. Import warns `SCN_LAS_HEADER_BOUNDS` and uses the bounds recomputed from the data | `las_reference.json` (`headerBoundsMatchData: false`) | recomputed bounds = decoded min / max, exact | `lasReader.test.ts` |
| VC-SCN-09 | Large coordinates: `test1_4.las` (x ≈ 1.694e6 m, scale 1.1645e-6 m). After import into the octree asset, every coordinate matches laspy within half a quantum | Closed form. Storing int32 relative to the node origin at the source quantum gives error ≤ scale/2. Counter-example (documented): absolute float32 loses up to 0.062 m on this file, measured, because float32 spacing at 2^20..2^21 is 0.125 m | ≤ 0.5 × scale per axis (5.83e-7 m in x) | `scan/octreeAsset.test.ts` |
| VC-SCN-10 | Octree / LOD invariants on `autzen_trim.laz` (110 000 points): node points sum to 110 000; every node ≤ `maxPointsPerNode`; level spacing halves each level; a query with budget B returns ≤ B points and a coarser level is never skipped; the asset hash is identical on two runs | invariants (closed form) | exact | `octreeAsset.test.ts` |
| VC-SCN-11 | Proprietary formats: `.rcp` / `.rcs` are refused with `SCN_FORMAT_PROPRIETARY` and the remediation "export E57 from ReCap" | policy (FR-SCN-11) | exact code | server transport test |
| VC-SCN-12 | Snap to a point: `nearest_cloud_point` on `ColouredCubeFloat.e57` from [0.6, 0.6, 0.6] returns record 6606 = [0.4936402, 0.4993396, 0.5] at 0.1773272 m. The second-nearest point is 0.0105 m further away, so the answer is unique | brute force (reference run) | index exact; distance ±1e-6 m | `scan/nearest.test.ts` |

### Extraction (FR-SCN-12..16)

The cylinder tolerances are `max(5 × CRLB std, floor)`. The CRLB is cov ≥ σ²(JᵀJ)⁻¹ at the true parameters, with the
orthogonal residual of S9 [S13]. Floors: radius 0.2 mm, axis angle 0.05°, axis position 1 mm. The reference run
(RANSAC [S8] + Levenberg–Marquardt) passes all three cases.

| VC | What | Truth (`synthetic_truth.json`) | Tolerance | Reference run | Test |
| -- | ---- | ------------------------------ | --------- | ------------- | ---- |
| VC-SCN-20a | CYL-A: DN100, r 57.15 mm, 2 m, half-arc (scanner side), σ 1 mm, 4 000 points, no outliers | axis [0.8, 0.6, 0] through [1, 2, 3] | r ±0.2 mm, axis 0.05°, position 1 mm | r +0.032 mm, 0.0018°, 0.13 mm | `scan/cylinderFit.test.ts` |
| VC-SCN-20b | CYL-B: DN200, r 109.55 mm, 3 m, full arc, σ 2 mm, 6 000 points + 25 % uniform outliers (2 000) | axis tilted 2° from +z | r ±0.2 mm, 0.05°, 1 mm | r −0.001 mm, 0.0049°, 0.14 mm | `cylinderFit.test.ts` |
| VC-SCN-20c | CYL-C: DN50, r 30.15 mm, 1 m, 120° arc, σ 1 mm, 1 500 points + 10 % outliers | axis (1, 1, 1)/√3 | r ±0.717 mm, 0.0555°, 1.008 mm | r −0.194 mm, 0.0152°, 0.25 mm | `cylinderFit.test.ts` |
| VC-SCN-21 | DN snap: fitted OD 2r → DN 100 / 200 / 50 through llull's EN 10220 table (`pipeSizes.ts`, snap tolerance 1.5 mm). A cylinder of r 70 mm (OD 140 mm, 0.3 mm from DN125 139.7) snaps to DN125; one of OD 150 mm reports `SCN_FIT_NO_STANDARD_SIZE` and keeps the measured OD | llull table [S15] | exact DN / code | — | `cylinderFit.test.ts` |
| VC-SCN-22 | ELB-A: DN100 straight 1.5 m along +x, 90° long-radius bend R 152.4 mm, straight 1.0 m along +y (σ 1 mm, 6 500 points). `trace_pipe_centreline` finds 2 straights + 1 bend; intersection point [1.6524, 0, 1] | generator | r ±1 mm, bend R ±10 mm, angle ±1°, intersection point ±5 mm (TOL-ENG) | REF-TBD | `scan/centreline.test.ts` |
| VC-SCN-23 | STL-A: IPE 300, 2 m along +y, faces seen from +x / +z (8 000 points, σ 1 mm). `fit_steel_member` ranks IPE 300 first among the catalogue and returns h, b, axis | generator; catalogue neighbours IPE 270, IPE 330, HEA 300 | h, b ±3 mm, axis 0.2°, section centre 3 mm (TOL-ENG); tw / tf are reported, not gated | REF-TBD | `scan/steelFit.test.ts` |
| VC-SCN-24 | Slice: a 20 mm slab of CYL-B normal to its axis at mid-length → circle fit r = 109.55 mm | generator. About 6000 × 0.02 / 3 = 40 inliers at σ 2 mm, so σ_r ≈ σ/√N ≈ 0.32 mm | ±1.6 mm (5σ_r) | REF-TBD | `scan/slice.test.ts` |

### Registration (FR-SCN-08..10)

| VC | What | Truth | Tolerance | Reference run | Test |
| -- | ---- | ----- | --------- | ------------- | ---- |
| VC-SCN-30 | ICP-A: source = `bunnyInt32.e57` (30 571 points); target = R·source + t, 70 % random subsample (seed 401), σ 0.2 mm; R = 10° about (0.3, 0.5, 0.8)/‖·‖, t = [0.05, −0.03, 0.02] m; ICP starts from identity | `synthetic_truth.json` ICP-A | rotation 0.05°, translation 0.5 mm, final RMS ≤ RMS at the true transform + 1e-5 m (sampling-limited) | 0.0054°, 0.0067 mm, RMS 0.5534 mm vs 0.5536 mm at truth, 45 iterations | `scan/icp.test.ts` |
| VC-SCN-31 | TGT-A: 4 sphere targets (r 72.5 mm, σ 1.5 mm, visible caps) in 2 stations related by a 37° rotation about z and t = [12, −4, 0.35] m; sphere fit + Horn | truth centres and transform | centre 2 mm, rotation 0.05°, translation 3 mm | max centre error 0.34 mm, 0.0018°, 0.27 mm; target RMS 0.095 mm | `scan/targets.test.ts` |
| VC-SCN-32 | Degenerate registration: 2 targets → `SCN_REG_TARGETS_INSUFFICIENT`; 3 collinear targets → `SCN_REG_DEGENERATE`; ICP with < 10 % overlap → `SCN_REG_NOT_CONVERGED`; the document is unchanged in each case | closed form (Horn needs ≥ 3 non-collinear points [S11]) | exact codes | — | `targets.test.ts`, `icp.test.ts` |

### As-built comparison and clash (FR-SCN-17..20)

| VC | What | Truth | Tolerance | Test |
| -- | ---- | ----- | --------- | ---- |
| VC-SCN-40 | C2M-A: 6 points against a 1 × 1 m square of 2 triangles → unsigned distances [0.04, 0.04, 0.04, √(0.3² + 0.04²), √(0.2² + 0.03²), 0.5] m | Pythagoras [S12] | 1e-12 m | `scan/deviation.test.ts` |
| VC-SCN-41 | DEV-A: the noise-free scanned DN200 run (2° × 20 mm grid, 18 180 points) against a design cylinder of the same radius whose axis is 25 mm lower (−y). Signed distance d(θ) = √(r² + D² + 2rD cos θ) − r: max +0.025, min −0.025, RMS 0.0176485 m; fraction with \|d\| > 10 mm = 0.744444 (134 of 180 angles; the nearest angle is 1.1e-4 m from the threshold); fitted axis offset 0.025 m | closed form | 1e-6 m (CSV stores µm); fraction exact | `deviation.test.ts` |
| VC-SCN-42 | DEV-A with the design tessellated by llull (64 segments) instead of the analytic cylinder | sagitta bound r(1 − cos(π/64)) = 1.32e-4 m | \|d_mesh − d_exact\| ≤ 1.32e-4 m; the result reports the bound | `deviation.test.ts` |
| VC-SCN-43 | CLH-A: a new DN150 (r 84.15 mm) line parallel to the scanned DN200 at axis spacing 0.15 / 0.25 / 0.50 m, required clearance 75 mm → `hard` (gap −43.7 mm), `clearance` (gap 56.3 mm), `clear` (gap 306.3 mm) | gap = D − r_scan − r_design | gap ±(r(1 − cos 1°) + 1e-6) = ±1.77e-5 m; status exact | `scan/asbuiltClash.test.ts` |

### Agent-first behaviour (AF-11, AF-20, AF-31..33)

| VC | What | Expected | Test |
| -- | ---- | -------- | ---- |
| VC-SCN-50 | A wrong plan (unknown cloud id, crop box with min > max, fit on a region with 0 points) returns the stable codes `SCN_CLOUD_NOT_FOUND`, `SCN_CROP_INVALID`, `SCN_FIT_TOO_FEW_POINTS`, with `paths` and a remediation | exact codes | `scan/agentCodes.test.ts` |
| VC-SCN-51 | Unverified propagation: an extraction from a cloud whose registration has no quality record (`registration.status: "unverified"`) carries `unverified: true`. So does the pipe run created from it, and `check_point_clouds` lists it as a warning | flags present | `scan/checkPointClouds.test.ts` |
| VC-SCN-52 | A deviation or clash report used for a tie-in carries `reviewRequired: true` with the reason ("tie-in dimensions from a scan — field-verify before fabrication"). The defaulted clash noise threshold (`minPointsInVolume: 10`) is named in `data` with `defaulted: true` | flags present | `asbuiltClash.test.ts` |

### Derivations used as expectations

- **DN snap (VC-SCN-21).** OD_fit = 2 r_fit. The DN is the table row with |OD_fit − OD_table| ≤ 1.5 mm (existing llull
  constant). For CYL-A, 2 × 57.15 = 114.3 → DN100 exactly.
- **VC-SCN-09.** Error with an int32 code relative to a node origin o at quantum q: x̂ = o + q·round((x − o)/q). The error is
  ≤ q/2 when o is itself on the source grid (o = offset + k·q), and is 0 for a LAS source with the same q and offset.
  Absolute float32: spacing 2^(e−23) with e = ⌊log2 1.694e6⌋ = 20, so the spacing is 0.125 m and the error is up to 0.0625 m.
  Measured: 0.0620 m.
- **VC-SCN-43.** Two parallel cylinders with axis spacing D. The surface gap is D − r1 − r2 at the facing generators. With a
  scanned grid of angular step Δ, the nearest sampled generator is at most Δ/2 = 1° away, which adds at most r1(1 − cos 1°).

### Known limits (documented, not failures)

- Our E57 reader handles only the XML section and the page CRCs. The binary decoding of compressed vectors, including
  bit-packed ScaledInteger, is checked against pye57. llull's TS reader must implement it in full (TECHNICAL_SPEC §5.1).
- ICP from identity converges on ICP-A because the rotation is 10°. Rotations above about 30° need the coarse step
  (targets, or the FPFH / RANSAC global registration of V1). VC-SCN-32 makes sure a non-converged run is reported, never
  silently accepted.

## What could not be verified

- No public real-world plant scan with surveyed pipe ground truth under 5 MB was reachable (sources.md). Extraction on real
  scans (insulation, partial occlusion, clamps, flanges) is validated only through the robustness of the synthetic cases
  (outliers, partial arcs). The production gate should add a real customer scan with a field-measured line list
  (TECHNICAL_SPEC §11 Q6).
- ELB-A, STL-A and the slice case have generator truth only (REF-TBD).
- RCP / RCS: no public specification; refusal only (VC-SCN-11).

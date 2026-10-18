# Gap 10 SCN — Point clouds and brownfield revamps: functional specification

Status: written 2026-10-18, specification only, nothing implemented. Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md),
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md). Operator model: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md).
Validation: [`validation/README.md`](validation/README.md).

## 1. Summary

Most process-plant work happens in existing plants: debottlenecking, a new pump, a replaced exchanger, a tie-in to a
live line. The only trustworthy picture of an existing plant is a laser scan, because the old drawings are wrong or
missing. Every plant design tool in the Plant 3D / E3D / Smart 3D class can do four things with a scan: load it, show it,
draw on it, and check new design against it.

llull cannot do any of them today. It has no point-cloud data type and no E57 or LAS reader. The viewport cannot draw
millions of points. There is no registration, no shape fitting on scanned points, no cloud-to-model distance, and no clash
between a new design and the as-built scan. An agent asked to "route a new DN80 line from the existing header to the new
pump" has no way to find where the existing header is.

This gap adds a **scan workspace**:

- import of E57 (ASTM E2807) and LAS / LAZ (ASPRS LAS 1.4), plus ASCII XYZ / PTS;
- a content-addressed, octree-indexed cloud **asset** that the document references but does not contain;
- LOD streaming in the viewport;
- crop boxes, slices and snapping to points;
- target-based and ICP registration with a quality record;
- extraction of pipes (cylinder fit, centreline and elbow tracing, DN snap) and steel members (catalogue profile fit),
  which create normal llull pipe runs and steel members flagged as-built;
- as-built-vs-design deviation and design-vs-scan clash, with numeric results an agent can act on.

Autodesk ReCap RCP / RCS files are proprietary and are refused with a remediation: export E57.

## 2. Plant context and value

Context in this section is **grade C**. It comes from the authors' knowledge of these products and was not re-read in this
session (sources.md S19). No requirement depends on it.

| Who | Typical brownfield task | Tools used today | What llull adds |
| --- | ----------------------- | ---------------- | --------------- |
| Owner-operator engineering (small revamp) | "Where exactly is the existing 8-inch header, and can a new branch fit between it and the rack steel?" | ReCap to prepare scans; AutoCAD Plant 3D or Navisworks to view; tape measure on site | One agent run: import, slice at rack level, fit the header, report clearance numbers |
| EPC piping designer | Model the existing lines in the tie-in area as intelligent pipe, route new lines, clash against the scan | Plant 3D with point-cloud snapping; AVEVA E3D with LFM / Laser Modeller; CADWorx with Leica CloudWorx; Smart 3D | The same steps as commands, scriptable and repeatable, with fit quality in numbers |
| Scan / survey contractor | Register stations, deliver E57 plus a registration report | Scanner vendor software (Cyclone, SCENE, RealWorks), ReCap | Check the delivered registration (target residuals, overlap) before design starts |
| Fabricator | Field-fit welds: is the as-built tie-in point where the iso says? | Field measurement, sometimes a scan of the tie-in | Deviation of the scanned tie-in against the design, flagged for field verification |
| Automatic extraction specialist | Extract hundreds of pipes from a scan | ClearEdge3D EdgeWise and similar | V1 batch extraction with a per-pipe fit report; MVP covers one pipe at a time |

Why this blocks plant use: an agent cannot design a tie-in, a replacement or a new line in an existing unit without
as-built geometry. Without this gap llull is limited to greenfield plants.

## 3. Personas and user stories

- **Operator: an AI agent using the `llull` CLI** (AF-01..05). It receives scan files and an intent. It imports with
  `llull scan import`, attaches and works with `build_project` plans, and reads every result from `data` (AF-10). It cannot
  see the cloud unless it renders it (`render_view --save`, AF-22), so every visual check has a numeric equivalent (AF-21).
- **Owner: not an engineer.** For example, a plant manager who wants to know "will the new pump fit, and do the new pipes
  hit anything?" They get a short answer in plain words (AF-36). Every number derived from a scan is marked as such, with
  its fit quality.
- **Qualified reviewer: a piping engineer or field engineer.** Needed when a scan-derived dimension is used for
  fabrication (tie-in points, spool lengths) or when a clash or deviation result is accepted as "no issue". llull marks
  these results `reviewRequired` (AF-33). It never claims a scan-derived dimension is fabrication-ready without field
  verification (AF-34 human gate: `accept_asbuilt_extraction`).

User stories:

1. As an agent, I import three E57 station files from a contractor and see in `data` how many points, which fields, which
   poses, and whether the registration was supplied (FR-SCN-01, 04).
2. As an agent, I attach a georeferenced LAS tile next to a local plant model and get coordinates at full precision
   (FR-SCN-02, 05).
3. As an agent, I crop to the tie-in area, cut a 20 mm slice at rack level, and get the pipe sections as fitted circles
   (FR-SCN-06, 16).
4. As an agent, I fit the existing DN200 header and turn it into a pipe run flagged as-built, with radius, axis and RMS
   (FR-SCN-12, 13).
5. As an agent, I follow a line from a picked point through its elbows and get straights, bends and intersection points
   (FR-SCN-14).
6. As an agent, I register two unregistered stations with sphere targets, refine with ICP, and get residuals I can show a
   reviewer (FR-SCN-08..10).
7. As an owner, I ask "does the new line clash with the existing plant?" and get a list of clashes, each with a gap in mm, a
   location and the number of scan points involved (FR-SCN-19).
8. As a reviewer, I get a deviation report showing where the existing line differs from the old design model, with the
   method, the thresholds and the review flag (FR-SCN-17, 18, 22).

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | E57 import: Cartesian and spherical, ScaledInteger / float / double, intensity, colour, station poses, CRC check. LAS 1.0–1.4 PDRF 0–10 and LAZ import (LAZ decoder bundled). ASCII XYZ / PTS / CSV import. Content-addressed octree asset with lossless coordinates. Document references (`attach_point_cloud`). LOD streaming with a point budget. Crop box. Slice. Nearest-point snap and point-to-point measure. Colour by RGB / intensity / elevation / deviation. Cylinder, plane, sphere and circle fit in a region. Pipe extraction for one pipe per call, with EN 10220 / ASME B36.10M DN snap. As-built pipe run creation. Target-based registration (spheres, picked points). Point-to-point and point-to-plane ICP. Registration quality record. Cloud-to-model deviation against llull solids and pipes. Design-vs-scan clash with clearance. `check_point_clouds`. Stable `SCN_*` codes. RCP / RCS refusal. |
| V1 | Centreline tracing through elbows and reducers. Batch pipe extraction in a region. Steel member fit against the catalogue (IPE / HE / UPN / L / SHS / RHS / CHS). Flange and valve detection by diameter steps. Global registration without targets (FPFH + RANSAC). Multi-station bundle adjustment. E57 export of a cropped or registered cloud. COPC import and export. Deviation colour map export (PNG, CSV). Scan-derived equipment envelopes (box / cylinder fit). |
| V2 | M3C2 distance for noisy surfaces. Automatic segmentation of a whole unit into pipe / steel / equipment / other with a learned classifier, reviewed by a human. Panoramic image (E57 `images2D`) overlay. Mesh reconstruction (Poisson) for visual context. Change detection between two scan epochs. Streaming from a server asset store for very large projects (over 10⁹ points). |
| Out of scope | Reading RCP / RCS (proprietary, no public specification). Scanner control and field acquisition. Photogrammetry (structure from motion). Survey-grade network adjustment for legal survey deliverables. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-SCN-01 | MUST | Import E57 1.0 files: every `data3D` scan with Cartesian or spherical coordinates, ScaledInteger / Integer / Float fields, invalid-state fields, intensity, colour, return index / count. Keep each scan's pose (unit quaternion + translation) and GUID. Refuse files with a bad page CRC (`SCN_E57_CHECKSUM`) and empty files (`SCN_CLOUD_EMPTY`) | E57 is the vendor-neutral exchange format every scanner exports | ASTM E2807 [R1]; libE57Format [R2] |
| FR-SCN-02 | MUST | Import LAS 1.0–1.4 (PDRF 0–10, VLR / EVLR, extra bytes) and LAZ. Apply X = Xrecord·scale + offset. Recompute the bounds from the data and warn when the header disagrees (`SCN_LAS_HEADER_BOUNDS`). Keep the classification, return and GPS-time fields | Aerial / mobile LiDAR and many scanner exports | ASPRS LAS 1.4 R15 [R3]; LASzip / lazrs [R4] |
| FR-SCN-03 | SHOULD | Import ASCII XYZ / PTS / CSV with a declared column order and unit | Contractor exports, synthetic data | — |
| FR-SCN-04 | MUST | A point cloud is a **referenced external asset**, not entities. The document stores a reference: source file hash, asset key, name, unit, pose / registration transform, CRS, display settings, crop boxes, header summary. Points never enter the document, the feature history or the undo stack | Clouds have 10⁶–10⁹ points; the document must stay small and replayable (L4, L8) | architecture L4, L8 |
| FR-SCN-05 | MUST | Coordinates keep the source precision. A stored point differs from the source by at most half the source quantum (LAS scale, E57 ScaledInteger scale; 0.01 mm for float / double sources). Georeferenced clouds work next to a local plant through the site calibration of the civil CRS | Projected coordinates near 10⁶ m lose 6 cm in float32 (VC-SCN-09) | VC-SCN-09 |
| FR-SCN-06 | MUST | The viewport shows clouds through an octree with level of detail. A point budget (default 3 M desktop, 1 M browser) is never exceeded. Nearer and larger nodes are refined first. Colour by RGB, intensity, elevation, classification or deviation. Crop boxes and the section plane apply to clouds | Plant scans are 10⁸ points and more; review needs smooth navigation | Potree [R7]; COPC [R6] |
| FR-SCN-07 | MUST | Snap to scan points (nearest point within a pick radius) in the UI and as a query (`nearest_cloud_point`). Measure point-to-point and point-to-model distances on the cloud | Drawing on the scan is the base brownfield workflow | — |
| FR-SCN-08 | MUST | Target-based registration: sphere targets (fitted), checkerboard / picked points, or named survey control points. At least 3 non-collinear pairs. Closed-form rigid transform. Per-target residuals and RMS | Coarse registration and survey tie-in | Horn 1987 [R11] |
| FR-SCN-09 | MUST | ICP fine registration (point-to-point and point-to-plane, trimmed) from an initial transform, with convergence criteria, overlap ratio and final RMS. Non-convergence is reported (`SCN_REG_NOT_CONVERGED`), never applied silently | Station-to-station and scan-to-model alignment | Besl & McKay [R9]; Chen & Medioni [R10] |
| FR-SCN-10 | MUST | Every applied registration is stored as a record: method, inputs, transform, residuals, date, and status `computed` / `accepted` / `unverified` (clouds delivered pre-registered without a report). Accepting a registration is a human act for fabrication use (AF-34) | Traceability of every downstream dimension | AF-32, AF-34 |
| FR-SCN-11 | MUST | Proprietary formats (ReCap RCP / RCS, Faro FLS, Leica native) are refused with `SCN_FORMAT_PROPRIETARY` and the remediation "export E57 (or LAS) from the vendor tool" | No public specification; avoid reverse-engineering | — |
| FR-SCN-12 | MUST | Fit primitives in a region (box, seed + radius, slice): plane, cylinder, sphere, circle (in a slice), with RANSAC for outliers and least-squares refinement. Return parameters, inlier count, RMS, coverage angle and the parameter uncertainty (covariance) | Base of every extraction and of target fitting | Schnabel 2007 [R8]; Lukács 1998 [R12] |
| FR-SCN-13 | MUST | Pipe extraction: fit a cylinder, snap the OD to a size table (EN 10220 / ASME B36.10M, from 01 PSC; tolerance named), optionally account for an insulation thickness, and (on commit) create an `add_pipe_run` flagged `asBuilt` with provenance (cloud, region, fit quality). Off-table diameters are kept as measured with `SCN_FIT_NO_STANDARD_SIZE` | Turning scan into intelligent pipe for tie-ins | VC-SCN-20, 21 |
| FR-SCN-14 | SHOULD | Centreline tracing from a seed: follow a pipe along its axis and detect bends (torus fit), reducers (radius step) and ends. Return straights, bends (radius, angle), intersection points (PI). Optionally create one pipe run with bends | Existing lines are rarely one straight | VC-SCN-22 |
| FR-SCN-15 | SHOULD | Steel member fit: project a region onto the member's section plane, rank catalogue profiles by fit (h, b, flange and web faces), return the best candidates with scores, and optionally create `add_steel_member` flagged `asBuilt` | Tie-ins to existing steel for supports and platforms | VC-SCN-23 |
| FR-SCN-16 | MUST | Slice: a planar slab of given thickness returns the points (bounded) and fitted 2D primitives (circles, lines). Optionally commit them as 2D entities on a work plane for drafting (`draw_polyline`, `draw_circle`) | Plan and section drawings from scans | VC-SCN-24 |
| FR-SCN-17 | MUST | Cloud-to-model deviation: for chosen entities (solids, pipe runs, meshes), the signed distance of every cloud point in range to the nearest surface. Analytic distance for llull primitives (cylinder, box, sphere). Tessellated distance otherwise, with the tessellation error bound reported. Statistics: min, max, mean, RMS, histogram, and the fraction beyond a threshold | As-built vs design check; fabrication tie-in verification | VC-SCN-40..42 |
| FR-SCN-18 | SHOULD | Deviation per entity: for pipes, the fitted axis offset and radius versus the design; for steel, the axis offset and roll | Engineers think in "the line is 25 mm low", not in histograms | VC-SCN-41 |
| FR-SCN-19 | MUST | Design-vs-scan clash: for chosen design entities, report scan points inside the entity (hard) or within a required clearance, with a minimum gap, the location, the point count, and a noise threshold (`minPointsInVolume`, default named). Points of the design's own as-built source are excluded | The main brownfield safety net before fabrication | VC-SCN-43 |
| FR-SCN-20 | MUST | `check_point_clouds` (read-only): missing assets, unregistered or unverified registration, unit mismatches, stale extractions (cloud transform changed after the fit), high fit RMS, clashes not reviewed. Pass / warn / fail with codes | AF-20: the agent ends every scan job with it | AF-20 |
| FR-SCN-21 | MUST | Every refusal and every warning has a stable `SCN_*` code, the offending ids or paths, and a one-line remediation | AF-11 | AF-11 |
| FR-SCN-22 | MUST | Provenance and trust: every scan-derived entity and result carries the cloud asset key, the region, the method and quality. `unverified` propagates from the registration status and from fit quality (AF-32). Results that can feed fabrication or a tie-in carry `reviewRequired` (AF-33) | Non-engineer operator; scan errors are invisible | AF-31..35 |
| FR-SCN-23 | COULD | E57 export of a cropped / registered cloud; COPC export | Hand-back to contractors and GIS | V1 |
| FR-SCN-24 | COULD | Global registration without targets (features + RANSAC) | Unordered scans | V1 |

## 6. Workflows

### 6.1 CLI (primary, complete)

```
# 1. import: the host parses, indexes and stores the asset; prints sourceSha256, assetKey, header summary
llull scan import scans/unit200_st01.e57 --json
llull scan import scans/site_lidar.laz sourceUnit=m --json

# 2. plan: attach, register, extract, compare (build_project; validated before any heavy work)
llull run tiein_plan.json --validate
llull run tiein_plan.json --doc unit200.llull --json --progress

# 3. look at it (multimodal agents) and check it
llull render_view --doc unit200.llull view=iso clouds=all --save tiein.png
llull check_point_clouds --doc unit200.llull --json

# 4. deliver numbers
llull cloud_to_model_deviation cloudId=st01 entityIds=pipe-12.1 threshold=0.01 --json --save deviation.csv
```

A typical `tiein_plan.json`: `attach_point_cloud` → `set_scan_crop` → `slice_cloud` (find the header) → `extract_pipes`
(query: the fit) → `commit_asbuilt_extraction` (creates the as-built run from the fit numbers) → `add_pipe_run` (new branch,
02 RTE) → `check_asbuilt_clash` → `check_point_clouds`. Heavy work on points is always a query. Only the numbers it produced
are committed, so the document replays without the scan (TECHNICAL §2). See `validation/plans/` for five complete scenarios.

### 6.2 MCP (cloud agents)

The same commands appear in the `scan` toolset. Import is an MCP host tool (`scan_import` with a file upload or an
`LLULL_EXCHANGE_DIR` path), like `fea_import_field`. Queries are bounded: `query_cloud_points` pages by `maxPoints`. A
cloud is never returned whole (AF-12).

### 6.3 UI (review and approval)

- Clouds render under the model with a point-budget slider, colour mode and point size. Crop boxes and the section plane
  apply to them.
- The snap marker shows "scan point", with the cloud name and point index.
- The Scan panel lists clouds, registrations (residual table), extractions (fit quality, `unverified` badge) and
  deviation / clash runs. A row click zooms to the region.
- Human gates: `accept_registration` and `accept_asbuilt_extraction` (reviewer signature, AF-34a). The agent can prepare
  them but cannot complete them.

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-01 | The 10 E57 test files | `llull scan import <f> --json` | the scan count, point counts, fields and GUID equal `e57_reference.json`; `bad-crc.e57` exits 1 with `SCN_E57_CHECKSUM`; `empty.e57` and `ZeroPoints.e57` give `SCN_CLOUD_EMPTY` | VC-SCN-01..03 |
| AC-02 | `bunnyInt32.e57` and `bunnyDouble.e57` | both are imported and queried in full | the points are equal within 5e-7 m; bounds and centroid as in the reference within 1e-6 m | VC-SCN-04 |
| AC-03 | `translationWithoutRotation.e57` | attached with station poses | `describe_point_cloud` reports the centroid [4.5, 5.5, 6.0] | VC-SCN-05 |
| AC-04 | The 10 LAS / LAZ files | imported | the header fields equal `las_reference.json`; each LAZ equals its LAS twin bit for bit; `simple1_3.las` warns `SCN_LAS_HEADER_BOUNDS` and uses the data bounds | VC-SCN-06..08 |
| AC-05 | `test1_4.las` (x ≈ 1.69e6 m) | imported and queried | every coordinate equals laspy within half the LAS scale | VC-SCN-09 |
| AC-06 | `autzen_trim.laz` | queried with a budget of 20 000 | ≤ 20 000 points are returned; the asset holds exactly 110 000; two imports give the same asset key | VC-SCN-10 |
| AC-07 | an `.rcp` file | imported | exit 1, `SCN_FORMAT_PROPRIETARY`, remediation names E57 | VC-SCN-11 |
| AC-08 | the cube cloud | `nearest_cloud_point point=[0.6,0.6,0.6]` | record 6606 at 0.177327 m | VC-SCN-12 |
| AC-09 | CYL-A / B / C | `fit_primitive kind=cylinder` / `extract_pipes` | radius, axis and position are within the CRLB-derived tolerances; DN 100 / 200 / 50 | VC-SCN-20, 21 |
| AC-10 | ELB-A | `trace_pipe_centreline seed=[0.5,0,1]` | 2 straights, 1 bend of 90° ± 1° and R 152.4 ± 10 mm, PI within 5 mm | VC-SCN-22 |
| AC-11 | STL-A | `fit_steel_member` | IPE 300 is ranked first; h and b within 3 mm | VC-SCN-23 |
| AC-12 | a 20 mm slice of CYL-B | `slice_cloud fit=circle` | r = 109.55 ± 1.6 mm | VC-SCN-24 |
| AC-13 | the bunny and its moved copy | `compute_registration method=icp` | rotation error ≤ 0.05°, translation ≤ 0.5 mm, RMS ≤ RMS at truth + 1e-5 m | VC-SCN-30 |
| AC-14 | 2 stations with 4 sphere targets | `compute_registration method=targets` | translation ≤ 3 mm, rotation ≤ 0.05°; with 2 targets: `SCN_REG_TARGETS_INSUFFICIENT`, document unchanged | VC-SCN-31, 32 |
| AC-15 | the scanned DN200 and a design 25 mm lower | `cloud_to_model_deviation` | max +25 mm, min −25 mm, RMS 17.6485 mm, 74.44 % beyond 10 mm; the tessellated mode reports its sagitta bound | VC-SCN-41, 42 |
| AC-16 | three new DN150 routes at 0.15 / 0.25 / 0.50 m | `check_asbuilt_clash clearance=0.075` | hard / clearance / clear with gaps −43.7 / 56.3 / 306.3 mm; `reviewRequired: true`; `minPointsInVolume` named as defaulted | VC-SCN-43, 52 |
| AC-17 | a pipe run extracted from a cloud with an unverified registration | `check_point_clouds` | warning `SCN_REGISTRATION_UNVERIFIED` listing the run | VC-SCN-51 |
| AC-18 | a plan with a wrong cloud id, an inverted crop box and an empty fit region | `llull run --json` | codes `SCN_CLOUD_NOT_FOUND`, `SCN_CROP_INVALID`, `SCN_FIT_TOO_FEW_POINTS`, each with paths and a remediation | VC-SCN-50 |

## 8. Standards and formats

| Item | Status in llull | Notes |
| ---- | --------------- | ----- |
| ASTM E2807 (E57 1.0) [R1] | import MVP, export V1 | Paywalled; implemented from the public structure proven by the readers in the pack (validation/sources.md S1, S2) |
| ASPRS LAS 1.4 R15 [R3] | import MVP | Public specification (lasformat.org) |
| LAZ (LASzip) [R4] | import MVP via the native `laz` crate (laz-rs) in the bundled `llull-compute`; WASM build of the same crate in the browser | De-facto standard; crate under MIT / Apache-2.0 (RS1 §2 rule 7) |
| COPC 1.0 [R6] | V1 import / export | LAZ 1.4 + octree VLR; written natively by `llull-cloud`. The internal cache stays llull's own format (TECHNICAL §3.1, Q2 settled) |
| ReCap RCP / RCS | refused | Proprietary |
| EN 10220 / ASME B36.10M OD tables | used for DN snap | Owned by 01-piping-specs-catalog |
| EN 10365 steel sections | used for profile fit | llull steel catalogue (`packages/domain-aec/src/steel/profiles.ts`) |
| IFC 4.3 | out of scope here | as-built entities export through 08-plant-data-reports-interop like any pipe or member |

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Import throughput (desktop, LAS / E57 uncompressed, SSD) | ≥ 2 M points/s parse + index; 100 M points in < 2 min (TECHNICAL §8) |
| Viewport | ≥ 30 fps at a 3 M point budget on a mid-range GPU; first frame < 1 s after attach |
| Pipe fit on synthetic VCs | 100 % within the CRLB tolerances |
| Agent completion | SC-SCN-01..05 complete unattended, apart from the human gates (AF-23) |
| Reviewer trust | Every scan-derived dimension in a deliverable traces to a cloud, a region, a method and a quality |

## 10. Risks and assumptions

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Real scans: occlusion, insulation, clamps, flanges, reflective stainless, people in the scan | Fits biased, extraction fails | Coverage angle and RMS reported. Insulation thickness parameter. Fit refused below a coverage threshold. A human gate before fabrication use. A real-scan production-gate case is still needed (Q6) |
| Registration error passes silently into design | Wrong tie-in points | Registration record with residuals; `unverified` propagation; `check_point_clouds` |
| Memory: 10⁸–10⁹ points | Browser crash | Octree asset out of core; point budget; desktop as primary host; browser limited to smaller clouds (TECHNICAL §8) |
| E57 complexity (bit-packed compressed vectors, many optional fields) | Incomplete reader | Test files cover ScaledInteger, float, double, spherical, attributes, empty and corrupt cases; pye57 as a cross-check in CI |
| Licence of decoders and viewers | Distribution risk | Only MIT / BSD / Apache code is bundled: the Rust `e57`, `las` and `laz` crates in `llull-compute` ([RS1](../../decisions/RS1-native-compute.md) §2 rule 7; no libE57Format addon). CloudCompare (GPL) is used only as an external comparison tool, never linked |
| Large georeferenced coordinates | cm-level error | Integer coding at the source quantum; floating render origin (existing `RenderOriginSyncer`) |
| Vendor feature parity expectations (EdgeWise-level automatic extraction) | Over-promise | MVP is one pipe per call; batch extraction in V1 with a review queue |

Assumptions: the desktop app (Electron + Node server) is the primary host for large clouds. Contractors can deliver E57.
Units of scan files are metres unless declared.

## 11. References

- [R1] ASTM E2807-11(2019)e1, Standard Specification for 3D Imaging Data Exchange, Version 1.0 — ASTM International — https://www.astm.org/e2807-11r19e01.html (catalogue page, as cited by libE57Format; accessed 2026-10, not reachable from the authoring sandbox)
- [R2] libE57Format — A. Maloney — https://github.com/asmaloney/libE57Format (sources read from the pye57 0.4.19 sdist, accessed 2026-10)
- [R3] ASPRS LAS Specification 1.4 R15 — ASPRS LAS Working Group — https://github.com/ASPRSorg/LAS, https://lasformat.org (accessed 2026-10)
- [R4] laspy 2.7.0 and lazrs 0.8.2 — https://pypi.org/project/laspy/, https://pypi.org/project/lazrs/ (accessed 2026-10)
- [R5] pye57 0.4.19 — D. Caron — https://pypi.org/project/pye57/ (accessed 2026-10)
- [R6] COPC — Cloud Optimized Point Cloud specification 1.0 — Hobu, Inc. — https://copc.io (README via raw.githubusercontent.com/copcio/copcio.github.io, accessed 2026-10)
- [R7] Potree / PotreeConverter 2.0 — M. Schütz — https://github.com/potree/PotreeConverter (README read, accessed 2026-10); Schütz M., Potree: Rendering Large Point Clouds in Web Browsers, TU Wien, 2016
- [R8] Schnabel R., Wahl R., Klein R., Efficient RANSAC for Point-Cloud Shape Detection, Computer Graphics Forum 26(2), 2007
- [R9] Besl P. J., McKay N. D., A Method for Registration of 3-D Shapes, IEEE PAMI 14(2), 1992
- [R10] Chen Y., Medioni G., Object modelling by registration of multiple range images, Image and Vision Computing 10(3), 1992
- [R11] Horn B. K. P., Closed-form solution of absolute orientation using unit quaternions, JOSA A 4(4), 1987
- [R12] Lukács G., Martin R., Marshall D., Faithful least-squares fitting of spheres, cylinders, cones and tori for reliable segmentation, ECCV 1998
- [R13] Lague D., Brodu N., Leroux J., Accurate 3D comparison of complex topography with terrestrial laser scanner (M3C2), ISPRS J. Photogramm. 82, 2013
- [R14] llull architecture laws — `.claude/rules/architecture.md`; agent-first rules — `docs/aerospace/AGENT_FIRST.md`
- Sibling gaps: `../01-piping-specs-catalog` (size tables), `../02-spec-driven-routing` (new lines, ports, tie-in connectors), `../06-plant-structures-access` (steel generators), `../08-plant-data-reports-interop` (as-built attributes in IFC / lists), `../09-plant-visualization-review` (renderer budgets, review redlines)

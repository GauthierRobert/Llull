# XCH validation pack — AP242 / IGES / JT / QIF / LOTAR

Proves the requirements of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (FR-XCH-*) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (TR-XCH-*). Every expected number is (a) quoted from a pinned public file,
(b) derived analytically by a script in this folder, or (c) marked `TBD — measure with <tool>`.

## 1. Files in this folder

| File | What | How produced |
| ---- | ---- | ------------ |
| `expected_results.json` | All VC cases: expected value, tolerance, unit, source/derivation, FR/TR proven | hand-written from the files below |
| `analytic_gvp_reference.json` / `.csv` | Volume, area, centroid, bbox of 9 reference parts (box, cylinder, offset sphere, torus, plate with centred / offset hole, L-bracket, inch box, 2-instance assembly) with tolerance | `python3 -I generate_analytic_gvp.py <this folder>` |
| `plans/*.json` | Draft llull `build_project` plans building each analytic part (same format as `quality/drawings/plans/*.json`) | written by the generator |
| `nist_pmi_gvp_reference.json` | For each of the 28 STEP files of the official NIST archive (17 AP242 + 11 AP203): sha256, bytes, FILE_SCHEMA, length unit, validation-property counts, embedded GVP values, entity census (PMI / tessellation / B-rep / assembly types) | `python3 -I extract_validation_properties.py <files>` on the extracted archive, post-filtered (all-zero placeholder GVP dropped and counted) |
| `xch_corpus.json` | Pinned corpus for the quality gate: NIST archive (URL + sha256) and members, OCCT IGES samples with entity census, reused `quality/corpus.json` STEP entries | hand-assembled from downloads of 2026-10-15 |
| `extract_validation_properties.py` | Stdlib-only, OCC-independent Part 21 reader for CAx-IF GVP + census (reference for TR-XCH-18) | — |
| `generate_analytic_gvp.py` | Analytic generator | — |
| `sources.md` | Every external source, access date, what was verified, fetched vs search-extract | — |

No third-party file is stored here: the NIST files are US Government data but are pinned by URL + sha256 rather than
copied (sizes 0.2–6 MB, and NIST states they are *not* error-free reference files); the OCCT IGES samples are > 1 MB.

## 2. Real use cases the pack represents

| Use case | Public evidence | Pack case |
| -------- | --------------- | --------- |
| Supplier receives OEM AP242 model with PMI (Airbus "Real Time Supplier Data", cabin equipment) | Airbus GPDIS 2018/2019 [R18] | VC-XCH-05, -07 |
| Cross-CAD data that must be verified before use (A380 CATIA V4/V5 wiring DMU) | SAE Mobility Engineering article [R19] | VC-XCH-05, -06 |
| CAx-IF testing of AP242 implementations with NIST CTC/FTC/STC models | NIST MBE PMI project [R23], NIST archive README [R4] | VC-XCH-05..09 |
| LOTAR archive of type-design data for > 50 years, verified by validation properties | LOTAR overviews by Boeing/Airbus and GIFAS [R17][R20]; EN 9300-110 [R16] | VC-XCH-13 |
| Legacy IGES surface data (MRO, tooling) | OCC IGES guide (IGES ≤ 5.3) [R7] | VC-XCH-10, -11 |

## 3. Tolerance policy (summary; full derivation in `expected_results.json` → `tolerancePolicy`)

| Comparison | Volume / area | Centroid | Basis |
| ---------- | ------------- | -------- | ----- |
| llull model vs analytic closed form | 1e-9 relative | 1e-9 × bbox diagonal | `BRepGProp` integration on exact analytic surfaces (≤ 1.1e-14 measured, 01 KRN `occt_crosscheck.json`; same as VC-KRN-01) |
| IGES export → import (sewing) | 1e-6 relative (provisional) | 1e-6 × diagonal | solids rebuilt by sewing (TR-XCH-12); replace by a measured bound after VC-XCH-11 |
| llull export → llull import (same OCC) | 1e-9 relative | 1e-9 × diagonal | only REAL serialization (≥ 15 digits, TR-XCH-05) |
| llull import vs GVP embedded by another CAD | green ≤ 1e-3; yellow ≤ 1e-2; red beyond | green ≤ 1e-3 × diagonal; yellow ≤ 1 mm | yellow = CATIA default (1 %, 1 mm) [R14]; CAx-IF three-tier results [R13]; green checked against the measured sender-vs-OCCT agreement of the 6 NIST files whose GVP match their geometry (≤ 7.5e-5 volume, ≤ 9.4e-4 area, ≤ 0.0064 mm — 01 KRN `nist_gvp_vs_occt.json`); the 4 gross disagreements (≥ 1.06e-2 volume) are red. Single band policy of llull (01 KRN defers to it) |
| Tessellated vs exact | 5e-3 relative (provisional) | — | to be replaced by a measured bound (VC-XCH-09) |

Measured cross-CAD spread on NIST CTC-02 (two different CAD systems, AP203 `_rc` vs AP242 `-e2`), computed from the
pinned files: volume +1.117e-4 relative, solid surface area −4.928e-4 relative, centroid 0.0181 mm. Both are inside the
green band, which is the point of VC-XCH-06. Caveat (01 KRN measurement, OCCT 7.9.3): the two files' geometries
differ by 5.2 % in volume and each file's GVP disagrees with its own geometry, so this is a GVP-to-GVP spread, not a
geometric one.

## 4. Validation cases

| VC | Proves | Input | Expected (abridged) | Tol. | Source | Gate |
| -- | ------ | ----- | ------------------- | ---- | ------ | ---- |
| VC-XCH-01 | FR-01, FR-02, TR-01, TR-02, TR-05 | 9 analytic plans | per `analytic_gvp_reference.json`, e.g. box 120000 mm³ / 18400 mm²; torus 14804.406601634037 / 5921.762640653615 | 1e-9 vs analytic; 1e-9 round trip | analytic | unit (OCC) |
| VC-XCH-02 | FR-03, TR-06, TR-18 | plate, offset hole | GVP in file: V 113716.81469282041, A 19028.31853071796, c (−1.3813228334244487, 0, 0) | 1e-9 | analytic | unit |
| VC-XCH-03 | FR-01, TR-04, TR-19 | any export | FILE_SCHEMA `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF…`; implementation level `2;1`; byte-identical for same timestamp | exact | NIST file headers [R4] | golden |
| VC-XCH-04 | FR-04, TR-07 | `xch-assembly-2x`, `as1-oc-214`, `red-cube-blue-cylinder` | 1 product / 2 occurrences, V 2000, c (50,0,0); 18 placed parts; names+colours kept | exact / 1e-9 | analytic; quality corpus | unit + quality |
| VC-XCH-05 | FR-05, FR-06, TR-08 | 7 NIST AP242 files with GVP + STC-06 | embedded GVP e.g. CTC-01 V 14644822.6361138 mm³, A 807080.802199914 mm², c (−2.2926, −1.3635, −32.2974); STC-06 → not-checkable; CTC-02 e2 and STC-08 e3 embedded GVP disagree with the OCCT-recomputed geometry (01 KRN, measured) → expected red, reported, import succeeds | green band (except knownIssue entries) | NIST files | quality `step-ap242` |
| VC-XCH-06 | FR-06 | CTC-02 AP203 + AP242 | Δ 1.1168549051822634e-4 / −4.928412593244942e-4 / 0.018141545708500635 mm | 1e-12 rel on reproduction | NIST files | unit (pure TS) |
| VC-XCH-07 | FR-07, TR-09 | CTC-01..05, FTC-06, STC-06/08 | census, e.g. CTC-01: 3 DATUM, 9 DIMENSIONAL_SIZE, 2 DIMENSIONAL_LOCATION, 1 ANGULAR_LOCATION, tolerances 1 flatness, 1 perpendicularity, 2 position, 2 surface profile | all accounted | NIST census; SFA report | quality (V1) |
| VC-XCH-08 | FR-08, TR-10 | toleranced llull part (gap 03) | identical PMI after round trip; SFA semantic PMI clean | exact | PMI RP v4.1 [R12] | unit + SFA (V1) |
| VC-XCH-09 | FR-09, TR-11 | FTC-08 `-e4-tg` | 1 tessellated solid → 1 non-empty mesh; triangle count TBD — measure with OCC | provisional | NIST census/README | quality (V1) |
| VC-XCH-10 | FR-10, TR-12 | OCCT `bearing.iges`, `hammer.iges` | ≥ 213 / ≥ 45 faces (type-144 roots; a review run with OCP 7.9.3 `IGESControl_Reader` read exactly 213 / 45 — to be recorded by a script in this folder before it becomes `=`); area TBD — measure with OCC (unit setting to pin) | — | file census; OCC guide [R7] | quality `iges-import` |
| VC-XCH-11 | FR-11, TR-13 | plate + L-bracket | analytic GVP after IGES round trip | 1e-6 (provisional, `igesRoundTrip`) | analytic | unit |
| VC-XCH-12 | FR-12, TR-14 | inch box; FTC-09 AP203 (inch); CTC-05 AP203 (inch, secondary) | 131096.512 mm³ / 18064.48 mm² / z 12.7 mm; FTC-09: 136445.10481135413 mm³, 96614.23380695238 mm², c (2.1859, 1.5150, 4.5543) mm → green (OCCT agrees to 1e-10 after × 25.4^k); CTC-05: converted GVP 12694914.68692222 mm³ still 1.06e-2 from the geometry → red | 1e-9; band | analytic; NIST × 25.4^k; 01 KRN measurement | unit + quality |
| VC-XCH-13 | FR-13, FR-14, TR-15 | L-bracket package | sha256 match; V 56000, A 14800, c (25,20,20) on retrieval | 1e-9 | analytic | unit (V1) |
| VC-XCH-14 | FR-15, TR-16 | truncated / garbage / oversize / zero-GVP | exit 1, `affected: []`, code `KRN_STEP_UNREADABLE` / `XCH_FILE_TOO_LARGE` + remediation; never throws | — | llull L1 | unit fuzz |
| VC-XCH-15 | FR-16 | JT sample | TBD — no openly licensed sample pinned | — | ISO 14306 [R5] | V2 |
| VC-XCH-16 | FR-17 | toleranced part | QIF XML validates vs QIF 3.0 XSD; characteristic count = PMI count | — | ISO 23952 [R6] | V2 |
| VC-XCH-17 | FR-18, TR-17 | VC-01..04 outputs | SFA: 0 syntax errors, GVP listed | exact | SFA [R10] | production (gate machine) |
| VC-XCH-18 | FR-19 | plate + steel material + layer | density 0.00785 g/mm³ kept; mass 892.6769953386402 g; layer kept | 1e-9 | analytic | unit |
| VC-XCH-19 | FR-20 | CAx-IF composite / kinematic files | TBD | — | RPs [R15] | V2 |
| VC-XCH-20 | FR-21, FR-22, TR-03 | any | identical `data` from UI dispatch, CLI, MCP; 0 network calls | exact | L1/L5/L6, KI6 | integration |
| VC-XCH-21 | FR-23, FR-24, TR-20, TR-21 | deliberately wrong calls (`expected_results.json`) | each exits 1 with the listed `XCH_*` / `KRN_*` code and a remediation; document unchanged | exact (codes) | requirement; CTC-02 e2 red measured | CLI script |
| VC-XCH-22 | FR-27, TR-24 | STC-06 (placeholder solid GVP) | provenance `unverified` (`import_gvp_not_checkable`); `mass_properties` `.data.unverified.reasons` contains it; `XCH_GVP_NOT_CHECKABLE` warning | exact | pinned file | CLI script |
| VC-XCH-23 | FR-28, TR-25 | CTC-02 e2 import; L-bracket archive; CTC-01 e1 (green) | `reviewRequired.value` true / true / false with reasons; summary wording | exact | requirement + measured bands | CLI script |
| VC-XCH-24 | FR-29, TR-26 | agent `export_step_ap242 {acceptUnverified}` with a red body | exit 1, `XCH_HUMAN_GATE`, no file; human caller proceeds | exact | requirement | unit + desktop test |
| VC-XCH-25 | FR-25, FR-26, TR-22, TR-23 | any import / export | named `policy` / `schema` defaults with sources; GVP unit fields; FTC-09 `fileUnit` inch, `unitFactor` 25.4; provenance fields | exact | §5.3, [R14] | CLI script |
| VC-XCH-26 | FR-30, TR-27 | CTC-02 AP242 | `--dry-run` → `.changed == false`; progress stages; JT without converter → `XCH_CONVERTER_MISSING` | exact | requirement | CLI script |

### 4.1 CLI form of the validation cases (AF-23)

Each VC runs unattended: a plan (`llull run … --validate`, then `llull run …`), a `--json` query, and a `jq -e`
comparison with `expected_results.json`; exit codes only, no UI. Pattern (VC-XCH-02):

```bash
P=docs/aerospace/04-interop-ap242-jt-iges/validation
llull run $P/plans/xch-plate-offset-hole.json --validate --doc t.llull
llull run $P/plans/xch-plate-offset-hole.json --kernel occt --doc t.llull
llull export_step_ap242 '{"includeValidationProperties":true,"timestamp":"2026-10-15T00:00:00Z"}' --save t.stp --kernel occt --doc t.llull
python3 -I $P/extract_validation_properties.py t.stp \
  | jq -e --slurpfile er $P/expected_results.json \
      '($er[0].cases[] | select(.id=="VC-XCH-02") | .expected.volume) as $v
       | [.[0].geometricValidationProperties[].values[] | select(.item=="volume measure") | .value][0] as $got
       | (($got - $v) | fabs) <= 1e-9 * $v'
llull verify_exchange_file file=t.stp --kernel occt --json | jq -e '.data.band == "green"'
```

VC-XCH-05/-12/-22/-23 use `llull import_step_exact file=<pinned NIST member> verify=true --json` and assert on
`.data.gvpCheck`, `.data.reviewRequired`, then `llull mass_properties … --json` for `.data.unverified`; VC-XCH-21
iterates the `calls` list of its expected entry and checks exit code + `.data.error.code`.

## 5. How to run (future implementation)

```bash
# 1. Fetch the pinned corpus (quality-gate style; never committed)
#    download archives[nist-pmi-step-files].url, check sha256 1fb91bb8…4f90, unzip, check each member sha256
# 2. Reference data (already generated; re-run to check reproducibility)
python3 -I docs/aerospace/04-interop-ap242-jt-iges/validation/generate_analytic_gvp.py docs/aerospace/04-interop-ap242-jt-iges/validation
python3 -I docs/aerospace/04-interop-ap242-jt-iges/validation/extract_validation_properties.py <unzipped>/NIST-PMI-STEP-Files/*.stp <unzipped>/NIST-PMI-STEP-Files/"AP203 geometry only"/*.stp
# 3. llull side (after implementation)
llull run docs/aerospace/04-interop-ap242-jt-iges/validation/plans/xch-plate-offset-hole.json --doc /tmp/p.llull
llull geometric_validation_properties --doc /tmp/p.llull --json
llull export_step_ap242 --save /tmp/p.stp --doc /tmp/p.llull
llull verify_exchange_file file=/tmp/p.stp --json
```

Expected for step 3: `geometric_validation_properties` and `verify_exchange_file` both report V 113716.81469282041,
A 19028.31853071796, c (−1.3813228334244487, 0, 0) within 1e-9, band green.

## 6. Known caveats of the reference data

- `lengthUnitDetected` in `nist_pmi_gvp_reference.json` is the first `LENGTH_UNIT` found in the file; confirm per
  file when an implementation disagrees (e.g. FTC-07 AP242 reports mm with a ~12 mm bounding box — plausible but
  unverified against the NIST drawing).
- The NIST archive README states the files are *not* error-free reference files and that SFA reports some syntax
  errors in them; a llull import must tolerate this.
- GVP "area" names vary by sender: `surface area measure`, `wetted area measure` (solid) and `independent surface
  area measure` (free surfaces). CTC-02 AP203's part-level area (2486265.124614) includes 4417.488569853 of
  independent surface; compare solid with solid (2481847.636045).
- The CTC-01 file in the third-party mirror `pzfreo/draftwright` differs from the current official file (NIST updated
  CTC 1, CTC 4, FTC 8, FTC 11, STC 9 in February 2026): always use the official archive hashes.
- IGES Global-section "version flag" values (9 in both OCCT samples) are not mapped to IGES versions here: the
  mapping table could not be verified from a fetched source in this session.

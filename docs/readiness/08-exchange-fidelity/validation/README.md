# 08 XCH — Validation plan

Pack default readiness level **PRL 3** (daily-capable, [`../../VALIDATION.md`](../../VALIDATION.md)); robustness under hostile
files is required at PRL 2 (VC-XCH-121). Machine profile `ref-win11` for baselines; budgets confirmed on `office-min` by
pack 03. Grades: [`sources.md`](sources.md). Machine index: [`expected_results.json`](expected_results.json) (schema
[`../../vc.schema.json`](../../vc.schema.json)). Ids start at 101: aerospace 04 owns `VC-XCH-01..26`.

## Use cases

1. **UC-1 Open what I was sent.** DWG / DXF of any version since R14 (R12 DXF), with blocks, attributes, dimensions, hatches,
   text, layers, layouts (VC-101…115, 119–122).
2. **UC-2 Send what they expect.** DWG / DXF back in a chosen version; it opens in DWG TrueView without recovery
   (VC-116…118).
3. **UC-3 Supplier STEP.** Exact, editable, named, coloured; back out as STEP (VC-123…128).
4. **UC-4 Architect's IFC as reference** (VC-129).
5. **UC-5 Issue and print drawings.** Vector PDF at scale with fonts and layers, PDF/A, plot styles, print (VC-130…135).
6. **UC-6 Trace over a vendor PDF** (VC-136).
7. **UC-7 Ship it legally and reachably** (VC-137, 138) and deterministically (VC-139, 140).

## Oracles

Fidelity is never judged by the codec under test. DXF: ezdxf (MIT) plus [`plans/dxf_census.mjs`](plans/dxf_census.mjs);
DWG: LibreDWG `dwgread` (GPL-3.0, installed on the test machine only) and ACadSharp (MIT), which must agree; visual
acceptance: DWG TrueView through a recorded review ([`plans/procedures.md`](plans/procedures.md) P2). STEP: OCCT reference
reader `quality/step_reference.py` and the analytic synthetic cases. PDF: closed-form unit conversion (1 mm = 72 / 25.4 pt)
and veraPDF (GPL-3.0, test-only).

## Validation cases

| VC | Level | Proves | Driver | Input | Expected | Tolerance | Source / grade |
| -- | ----- | ------ | ------ | ----- | -------- | --------- | -------------- |
| VC-XCH-101 | PRL3 | FR-XCH-101, TR-XCH-101 | cli | 16 pinned DWGs AC1014…AC1032 (`data/corpus.json`), no converter on `PATH`, network disabled | 16 / 16 open; no `XCH_DRW_CODEC_UNAVAILABLE` | exact | baseline M2 (A): refused; target. AC1009 / AC1012 DWG samples to pin (none public found yet) |
| VC-XCH-102 | PRL3 | FR-XCH-101, FR-XCH-103, TR-XCH-114 | cli | `acs-dwg-ac1015 … ac1032` and `acs-dxf-ac1032-ascii` (same drawing) | per-type census of the imported documents identical across the 6 versions and equal to the DXF oracle | exact | M3 (A): source census of AC1015 and AC1032 ASCII identical |
| VC-XCH-103 | PRL3 | FR-XCH-102, TR-XCH-101 | cli | `acs-dxf-ac1009-binary`, `acs-dxf-ac1032-binary` | census equals that of the ASCII twin | exact | code (A): binary refused today (`importDxf.ts`) |
| VC-XCH-104 | PRL3 | FR-XCH-103, FR-XCH-117, TR-XCH-102 | cli | `acs-dxf-ac1032-ascii` (169 entity records, 31 types) | records of MUST classes at L0 = 0; non-MUST L0 only for proxy / custom | exact | baseline M1 (A): 70 records of 22 types skipped |
| VC-XCH-105 | PRL3 | FR-XCH-104, TR-XCH-103 | cli | same | 6 top-level INSERTs → 6 instances of their component definitions; editing one definition changes every instance; `explode` gives the oracle's exploded census | exact | M3 (A): 6 INSERT; baseline M1: exploded |
| VC-XCH-106 | PRL3 | FR-XCH-105 | cli | same | 4 ATTRIB values and 5 ATTDEF tags / prompts / defaults equal to the oracle; attribute table lists 4 rows | exact | M3 (A); baseline: 0 (ATTRIB dropped, ATTDEF skipped) |
| VC-XCH-107 | PRL3 | FR-XCH-108 | cli | same + `nested-dimensions-dxf` | 11 dimensions with measurement = oracle measurement; 6 DIMSTYLE names kept; non-L3 types reported `XCH_DRW_ENTITY_EXPLODED` | 1e-9 rel. | M3 (A); baseline: 11 skipped |
| VC-XCH-108 | PRL3 | FR-XCH-109 | cli | same (8 HATCH) + `hatches-dxf` | pattern name, scale, angle equal; boundary area = oracle area | 1e-6 rel. | M3 (A); baseline: skipped |
| VC-XCH-109 | PRL3 | FR-XCH-110, TR-XCH-106 | cli | same (29 TEXT, 5 MTEXT) | plain text of every TEXT / MTEXT equals the oracle's; MTEXT runs keep height / font changes | exact | M3 (A); baseline: MTEXT codes stripped (L1) |
| VC-XCH-110 | PRL3 | FR-XCH-111, TR-XCH-106 | cli | same, no SHX folders configured | each STYLE whose font is unavailable listed once in `XCH_DRW_SHX_MISSING` / `XCH_DRW_FONT_SUBSTITUTED` with substitute | exact | target |
| VC-XCH-111 | PRL3 | FR-XCH-111 | review | P4: reviewer's own SHX fonts | glyphs match DWG TrueView; string width difference ≤ 1 % | 1 % | target (SHOULD, V1) |
| VC-XCH-112 | PRL3 | FR-XCH-112, FR-XCH-113 | cli | same (8 LTYPE, 19 LAYER) | linetype names and dash lengths equal; every layer property (on, frozen, locked, plot, colour incl. true colour, linetype, lineweight, transparency) equal | exact | M3 (A); baseline: name + ACI only |
| VC-XCH-113 | PRL3 | FR-XCH-107 | cli | same (4 LAYOUT incl. Model) | 3 sheets; paper size, plot scale and viewport count / scale / frozen layers per layout equal to the oracle | exact; scale 1e-9 rel. | M3 (A); baseline: VIEWPORT skipped, 0 sheets |
| VC-XCH-114 | PRL3 | FR-XCH-106 | cli | `plans/make_fixtures.py` host / child / missing / cycle | child resolved: 4 entities at (1000, 0); missing → `XCH_DRW_XREF_UNRESOLVED`; cycle → `XCH_DRW_XREF_CYCLE` in ≤ 5 s | exact | analytic (fixture) |
| VC-XCH-115 | PRL3 | FR-XCH-116, TR-XCH-104 | cli | `acs-dwg-ac1032`, move one LINE, save AC1032 | every other object (incl. 97 XRECORD, 81 DICTIONARY, 33 SCALE in the DXF twin) present with same handle and data | exact | M3 (A) counts; target (SHOULD) |
| VC-XCH-116 | PRL3 | FR-XCH-118, TR-XCH-105, TR-XCH-114 | cli | P1 over every DWG / DXF of the corpus | counts per type equal for types at ≥ L3; matched-handle values equal; curve deviation ≤ 1e-9 × extents diagonal | as stated | target; baseline (A, code): R12 writer rounds to 1e-6 units |
| VC-XCH-117 | PRL3 | FR-XCH-115, TR-XCH-101, TR-XCH-117 | cli | export of `acs-dxf-ac1032-ascii` to DWG AC1015 / AC1018 / AC1024 / AC1027 / AC1032 and DXF of the same + R12 | every file re-read by both oracles without error; `$ACADVER` equals the version asked | exact | [R14] (A) codes; baseline: R12 DXF only, no DWG |
| VC-XCH-118 | PRL3 | FR-XCH-115, FR-XCH-118 | review | P2: exported AC1032 files in DWG TrueView | no recovery prompt; layouts present; visual match accepted | record | target; [R15] (B) for the viewer |
| VC-XCH-119 | PRL3 | FR-XCH-117, TR-XCH-102 | unit | every corpus file through the mapping with a recorded DIM | `sum(levels[t]) == census[t]` for every type; every finding code is in TECHNICAL_SPEC §7 | exact | target |
| VC-XCH-120 | PRL3 | FR-XCH-119 | cli | `acs-dxf-ac1032-ascii` (`$INSUNITS 1`) into a mm document; `acs-dxf-ac1009-ascii` (no `$INSUNITS`) | lengths × 25.4 exactly; R12 file → `XCH_DRW_UNITS_ASSUMED` | 1e-12 rel. | M1 (A): `$INSUNITS 1`; R12 "mm (assumed)" in text only, no code |
| VC-XCH-121 | PRL2 | FR-XCH-120, TR-XCH-115 | fault | each corpus DWG / DXF truncated at 50 % + 1,000 byte-flip mutants | 0 app crashes; document unchanged; `XCH_DWG_CORRUPT` or `XCH_DRW_RECOVERED`; ≤ 30 s per file | exact | target |
| VC-XCH-122 | PRL3 | FR-XCH-121, TR-XCH-115 | perf | open `acs-dwg-ac1032` (1,081,979 bytes) | ≤ 2 s to first frame | 10 % | spec budget |
| VC-XCH-123 | PRL3 | FR-XCH-122, TR-XCH-107, TR-XCH-117 | cli | `llull import_step file=as1-oc-214` and `syn-face-colors` (quality corpus), native kernel on | every body exact (`brep` set); 18 placed parts; names include `bolt`, `nut`, `plate`, `rod`; ≥ 1 non-grey part colour; 6 face colours on the synthetic | exact | QUALITY_GATES (A): known issues #3, #14 on the mesh path |
| VC-XCH-124 | PRL3 | FR-XCH-123, TR-XCH-108 | cli | `red-cube-blue-cylinder` imported exact; `push_pull_face` +5 mm on a cube face; then `fillet_edge`, `chamfer_edge`, `shell_solid`, `boolean` | ΔV = A_face × 5 mm; each command succeeds, `check_model` clean | 1e-6 rel. | closed form (A) |
| VC-XCH-125 | PRL3 | FR-XCH-123, TR-XCH-108 | cli | `nist-ctc-02` imported; `recognize_features` then `adopt_features` | adopted hole steps replay to the same volume | 1e-6 rel. | target (SHOULD) |
| VC-XCH-126 | PRL3 | FR-XCH-124, TR-XCH-107 | cli | `as1-oc-214` and `syn-unicode-names` → export STEP → import exact | tree node count, names (exact Unicode), colours equal; per-part bbox equal | 1e-6 × diagonal | QUALITY_GATES (A): CadQuery double-encodes `Ø20 Welle` |
| VC-XCH-127 | PRL3 | FR-XCH-125 | cli | the IGES cases of aerospace 04 (`../../../aerospace/04-interop-ap242-jt-iges/validation/expected_results.json`) on the packaged build | all pass | as there | target (SHOULD) |
| VC-XCH-128 | PRL3 | FR-XCH-126 | review | P5 owner decision | decision record exists | record | target (COULD) |
| VC-XCH-129 | PRL3 | FR-XCH-127, TR-XCH-112 | cli | plant 08 `IFC4X3_ADD2_Infra-Plumbing.ifc`, `IFC4X3_ADD2_Building-Hvac.ifc`; IFC4 / IFC2x3 samples to pin | products per class = text census of `IfcProduct` subtypes in the DATA section; GlobalIds 100 % kept; property-set count equal | exact | target (SHOULD); [R36] files |
| VC-XCH-130 | PRL3 | FR-XCH-128, TR-XCH-109, TR-XCH-110 | cli | [`plans/sc-xch-pdf-scale.json`](plans/sc-xch-pdf-scale.json) | MediaBox 1190.551 × 841.890 pt; front-view edge 283.465 pt; 0 image XObjects | 0.01 pt | closed form (A): 420 · 72 / 25.4, 297 · 72 / 25.4, 100 · 72 / 25.4 |
| VC-XCH-131 | PRL3 | FR-XCH-128, TR-XCH-110 | cli | same | one OCG per layer with content, names equal to the layer names | exact | target |
| VC-XCH-132 | PRL3 | FR-XCH-128, TR-XCH-110 | cli | same | every font embedded (FontFile2 / FontFile3) and subset; extracted text contains the title-block strings | exact | target |
| VC-XCH-133 | PRL3 | FR-XCH-129, TR-XCH-110 | cli | same with `pdfa=2b` | veraPDF PDF/A-2b profile: 0 failed rules | exact | target (SHOULD); [R29] |
| VC-XCH-134 | PRL3 | FR-XCH-130, TR-XCH-111 | electron | [`plans/sc-xch-print-1to50.json`](plans/sc-xch-print-1to50.json) to "Microsoft Print to PDF" | 1000 mm edge prints 20.0 mm | 0.2 mm | closed form (A): 1000 / 50 |
| VC-XCH-135 | PRL3 | FR-XCH-114, TR-XCH-111 | cli | `xch_test.ctb` from `plans/make_fixtures.py`, `export_pdf plotStyle=…` | ACI 7 strokes 1.41732 pt; other colours unchanged | 0.01 pt | closed form (A): 0.50 · 72 / 25.4 |
| VC-XCH-136 | PRL3 | FR-XCH-131, TR-XCH-113 | cli | the PDF of VC-XCH-130 as underlay at 1:1, calibrated by two snapped points | snapped edge endpoints 100 mm apart | 0.01 mm | closed form (A) |
| VC-XCH-137 | PRL3 | FR-XCH-132, TR-XCH-118 | review | P3 licence inventory of the packaged app | no GPL / AGPL component; MPL / LGPL obligations met; counsel answers Q2, Q3 | record | target |
| VC-XCH-138 | PRL3 | FR-XCH-133, TR-XCH-119 | electron | packaged app, File menu | Open accepts the 5 formats as a document; Save As DWG / DXF; Export PDF; Print — each dispatches its registered command | exact | baseline (A, code): none of these in `desktop/src/menu.ts` |
| VC-XCH-139 | PRL3 | FR-XCH-134, TR-XCH-116 | cli | `export_drawing` (DWG, DXF) and `export_pdf` twice; `open_drawing` twice | byte-identical outputs; identical document JSON | exact | target |
| VC-XCH-140 | PRL3 | FR-XCH-134, TR-XCH-120 | unit | code registry | every §7 code emitted by ≥ 1 test; no aerospace 04 code redefined | exact | target |

Each FR maps to at least one VC: 101→101/102, 102→103, 103→102/104, 104→105, 105→106, 106→114, 107→113, 108→107,
109→108, 110→109, 111→110/111, 112→112, 113→112, 114→135, 115→117/118, 116→115, 117→104/119, 118→116/118, 119→120,
120→121, 121→122, 122→123, 123→124/125, 124→126, 125→127, 126→128, 127→129, 128→130/131/132, 129→133, 130→134, 131→136,
132→137, 133→138, 134→139/140. Every MUST FR has a gating case (grade A or target, MUST priority).

## Data and plans

| File | Runs today | Purpose |
| ---- | ---------- | ------- |
| [`data/corpus.json`](data/corpus.json) | yes (URLs + sha256 verified 2026-10-28) | 22 pinned DWG / DXF files (ACadSharp MIT, LibreDWG GPL test data — not copied) + reused quality / plant 08 files |
| [`plans/dxf_census.mjs`](plans/dxf_census.mjs) | yes (M3) | independent DXF census oracle |
| [`plans/make_fixtures.py`](plans/make_fixtures.py) | no (not run; ezdxf calls to check) | xref and CTB fixtures with analytic ground truth |
| [`plans/sc-xch-pdf-scale.json`](plans/sc-xch-pdf-scale.json) | no (`export_pdf` unbuilt) | PDF scale / vector / fonts / layers / PDF/A |
| [`plans/sc-xch-print-1to50.json`](plans/sc-xch-print-1to50.json) | no (`load_plot_style`, `print_sheet` unbuilt) | print to scale with a CTB |
| [`plans/procedures.md`](plans/procedures.md) | — | P1 round trip, P2 TrueView, P3 licence, P4 SHX, P5 Parasolid |

Integration with `quality/`: the files above become `quality/corpus.json` entries with `"gate": "drawing"` and a new
`server/tests/quality/drawing.gate.ts` (TECHNICAL_SPEC §9); today's failures are recorded as `knownIssues` at M0 so the gate
ratchets from the measured baseline.

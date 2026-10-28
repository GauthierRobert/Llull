# 07 VNV — Validation plan

Two halves: (1) **framework cases** that prove the record / design-basis / report / sign machinery (VC-VNV-101…119), and
(2) **worked-example cases** transcribed from published, freely available sources (VC-VNV-120…148), which become the regression
suite gating CI. Ids start at 101: the physics harness pack owns VC-VNV-01…22 ([`../../../physics/00-vv-harness/`](../../../physics/00-vv-harness/)).

Grades ([`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md)): **A** primary source read / transcribed from the downloaded
document, or ≥ 2 sources agree, or a cited closed form; **B** one secondary extract; **C** located, not confirmed; **target** = spec
budget. Only A, closed forms and targets gate. Level column: PRL of [`../../VALIDATION.md`](../../VALIDATION.md) (pack default PRL3).

## How a worked-example case is judged

1. `derived` = the published formula recomputed in double precision from the **published inputs** (in `data/*.json`). A test first
   checks `derived` against the printed value within the stated rounding (proves the transcription), then checks llull against
   `derived` within the case tolerance (proves llull). See FR-VNV-114.
2. Inputs that the source reads off a chart (HEC-22 IDF intensity, Mcr from tabulated C1 / C2) are given to llull as inputs; the
   case tests the clause it names, not the chart read.
3. A printed value that contradicts its own source is an **erratum**: recorded in the data file, llull follows the corrected value,
   and the case asserts it (VC-VNV-124, -125).
4. Units: sources in US customary are converted exactly to SI before calling llull; comparison in SI.

## Use cases

1. **UC-1 Steel member and connection checks** a Belgian structural engineer signs (EN 1993-1-1, -1-8, BE annex).
2. **UC-2 Storm drainage** of a site / road (Rational Method, gutter spread, channel and pipe capacity).
3. **UC-3 Road alignment** design checks (sight distance, radius, spiral).
4. **UC-4 FEA / thermal** results whose solver is already benchmarked by the physics packs, now carried into the report.
5. **UC-5 Report, review, sign** — the deliverable.

## Validation cases

| VC | Proves | Level | Driver | Input | Expected | Tolerance | Source / grade |
| -- | ------ | ----- | ------ | ----- | -------- | --------- | -------------- |
| VC-VNV-101 | FR-VNV-101, 116; TR-VNV-101 | PRL3 | unit | registry: every command with `engineeringCheck: true` | each has a `VnvRecord` with scope, clauses (standard + edition + clause), assumptions, limits, ≥ 1 case or status `unvalidated`; every `cases[].vc` exists in `expected_results.json` | exact | target; baseline A: 0 records |
| VC-VNV-102 | FR-VNV-102; TR-VNV-102 | PRL3 | unit | `check_steel_members` on the VC-VNV-121 column | every row has `clause.standard = "EN 1993-1-1"`, non-empty `edition`, `clause` (e.g. `6.3.1.2`), `annex.id` = design basis | exact | target; baseline A: clause only inside the row label |
| VC-VNV-103 | FR-VNV-103; TR-VNV-103 | PRL3 | unit | new document, a member, `check_steel_members` with no `set_design_basis` | refusal `VNV_DESIGN_BASIS_MISSING`, document unchanged | exact | target |
| VC-VNV-104 | FR-VNV-104; TR-VNV-104 | PRL3 | unit | `set_design_basis annex=EN-recommended`, then `set_ndp_override key=gammaM1 value=1.1 reason="client specification XYZ"` | row `ndp` lists γM1 = 1.1 with `overridden.reason`; Nb,Rd of VC-VNV-121 scales by 1/1.1 exactly; info `VNV_NDP_OVERRIDDEN`; override without reason rejected (invalid params) | 1e-9 rel | target |
| VC-VNV-105 | FR-VNV-105; TR-VNV-105 | PRL3 | unit | `annex=BE` (table grade B, `verified: false`) | every steel row and the report carry `VNV_NDP_UNVERIFIED` naming the key and its source [R10]; the warning cannot be filtered out | exact | target; [R10][R11] |
| VC-VNV-106 | FR-VNV-106, 108; TR-VNV-106, 108 | PRL3 | unit | `calculation_report` on the VC-VNV-122 beam | report item holds inputs (IPE 400, S355, L 6 m, MEd 114.3, Mcr 164.7), chain λ̄LT 1.678437, ΦLT, χLT 0.2841438, Mb,Rd 131.8385 kNm, utilisation 0.86697, clause 6.3.2.2 | 1e-6 rel | derived from W1 (A) |
| VC-VNV-107 | FR-VNV-107; TR-VNV-107 | PRL3 | unit | same document, report twice; then a document built in a different entity order | identical `reportSha256` and bytes; `documentHash` = `document_content_hash`; `software.version` / `commit` present; record and NDP table versions listed | exact | target |
| VC-VNV-108 | FR-VNV-109; TR-VNV-109 | PRL3 | electron | desktop "Export calculation report…" offline (network disabled) | HTML self-contained (no external URL), PDF written; first page has the §6 sentence | exact | target |
| VC-VNV-109 | FR-VNV-110; TR-VNV-110 | PRL3 | cli | PLM-managed doc; report; `record_signature target={kind:"calculation_report", ref:<sha>} meaning=review` with a registered test key (server host); then the same as an agent caller with `meaning=approval` | first: signature stored, `signedSha256 = reportSha256`; second: `PLM_HUMAN_GATE` | exact | target; existing PLM path A |
| VC-VNV-110 | FR-VNV-111; TR-VNV-111 | PRL3 | unit | signed report, then move one member 1 mm, `calculation_report_status` | `stale: true`, `VNV_REPORT_STALE`; signature listed as "signed for an earlier state"; a new report has a new hash | exact | target |
| VC-VNV-111 | FR-VNV-112; TR-VNV-112 | PRL3 | unit | members: a class-4 welded I (web 1500 × 6 mm, S355, compression), a tapered member, an angle in LTB; a drainage pipe forced into pressure flow on an open-channel-only loss model; alignment at 140 km/h | rows `refused` with `STL_SECTION_CLASS4`, `STL_TAPERED_MEMBER`, `STL_SECTION_UNSUPPORTED`, `DRN_PRESSURE_FLOW_UNSUPPORTED`, `ALN_SPEED_OUT_OF_TABLE`; other items still checked; report lists them | exact | target; baseline A: plain-text failure, whole command aborts |
| VC-VNV-112 | FR-VNV-113; TR-VNV-113, 115 | PRL3 | unit | `npm run check` with the suite; then a deliberate defect (αv forced to 0.6 for class 6.8) | suite green on main; the defect fails VC-VNV-125 and CI | exact | target (test-must-fail) |
| VC-VNV-113 | FR-VNV-114; TR-VNV-114 | PRL3 | unit | every `data/*.json` case | `derived` reproduces `published` within the stated rounding or an erratum is recorded; else the transcription test fails | per case | A |
| VC-VNV-114 | FR-VNV-115; TR-VNV-116 | PRL3 | unit | every engineering check result + the report | `reviewRequired: true`, non-empty `reviewReason`; HTML first page holds the fixed sentence | exact | target; AF-33 |
| VC-VNV-115 | FR-VNV-116 | PRL3 | unit | `vnv_record command=check_steel_members` after M3; `vnv_record command=check_crane_runways` | steel: `validated` for tension, flexural buckling, LTB groups, `unvalidated` for 6.3.3 interaction; crane runway: `unvalidated` + `VNV_UNVALIDATED_CHECK` in any report that uses it | exact | target |
| VC-VNV-116 | FR-VNV-117; TR-VNV-117 | PRL3 | unit | edit `steelDesign.ts` table without bumping the record version | contract test fails `VNV_RECORD_VERSION_STALE` | exact | target |
| VC-VNV-117 | FR-VNV-118; TR-VNV-118 | PRL3 | unit | generate `errata.md` | lists W1 §2.1.8 αv (verdict flips), W1 Ex. 5 fy / section typo and χ round-up, W1 Ex. 4b χ round-up, W2 Ex. 4.3 "89 m³/s" and area 43.36 / 43.3 | exact | A (transcription) |
| VC-VNV-118 | FR-VNV-120 | PRL3 | cli | `llull set_design_basis …`, `llull calculation_report … --save r.html`, `llull vnv_record …` on a file and `--app` | same data as the UI path; HTML written | exact | target |
| VC-VNV-119 | FR-VNV-119 | PRL3 | review | a practising Belgian structural engineer reviews the record template and three reports (steel portal + connections, site drainage, road alignment) | review recorded (who, date, findings); 0 open MUST findings | — | target |
| VC-VNV-120 | FR-VNV-113; TR-VNV-113 | PRL3 | unit | W1 Ex. 2 b: 2L50×50×5 and 2L60×60×6, S235, NEd 220 kN, 2 bolts d0 18, p1 100, β2 0.70 | Nu,Rd 157.248 / 235.0656 kN; Npl,Rd 225.6 / 324.77 kN; 2L50 fails, 2L60 passes | 0.1 % | W1 pp. 40–42 — A |
| VC-VNV-121 | FR-VNV-113, 102 | PRL3 | unit | W1 Ex. 3: HEB 340 S355, Lcr 4.335 m both axes, NEd 3326 kN | class 1 (c/t 20.25, 5.44); λ̄y 0.3872631, λ̄z 0.7534402; χz 0.6913813 (curve c); Nc,Rd 6066.95; Nb,Rd 4194.576 kN; published 4186.2 within 0.3 % | 0.1 % | W1 pp. 46–47 — A |
| VC-VNV-122 | FR-VNV-113, 108 | PRL3 | unit | W1 Ex. 4 a: IPE 400 S355, MEd 114.3, VEd 75.9, Mcr 164.7 (input) | Mc,Rd 463.985; Vpl,Rd 874.9714; λ̄LT 1.678437; χLT 0.2841438; Mb,Rd 131.8385 kNm (published 129.9 with χ rounded down) | 0.1 % | W1 pp. 57–58 — A |
| VC-VNV-123 | FR-VNV-113, 108, 114 | PRL3 | unit | W1 Ex. 4 b: 3 m segment, Mcr 1778.8 | λ̄LT 0.5107265; χLT 0.8794334; Mb,Rd 408.0439 kNm; llull must NOT return the published 412.9 (χ rounded up, +1.2 %) | 0.1 % | W1 p. 59 — A |
| VC-VNV-124 | FR-VNV-113, 114 | PRL3 | unit | W1 Ex. 5: IPE 450 S275, L 10 m, MEd 104.2, VEd 70.0, Mcr 133.4 | Vpl,Rd 807.3522; λ̄LT 1.873131; χLT 0.2351618; Mb,Rd 110.0675 kNm; utilisation 0.94669 (published 112.3 / 0.93, erratum) | 0.1 % | W1 pp. 59–61 — A |
| VC-VNV-125 | FR-VNV-113, 114, 118 | PRL3 | unit | W1 §2.1.8: 2L80×6 S355, 5 × M20 6.8 full thread, gusset 8 mm, e1 40, e2 35, p1 70, NEd 580 | Fv,Rd 117.6 kN (αv 0.5, Table 3.4); Fb,Rd end 98.90909, inner 132.2909; group 550.6182 kN; verdict FAIL, utilisation 1.0534; net section 589.7232 kN | 0.1 %; verdict exact | W1 pp. 95–97 + W1 §2.1 αv table — A (erratum: printed 141.1 / 595.0 / pass) |
| VC-VNV-126 | FR-VNV-113 | PRL3 | unit | W1 §2.2.6: 2L80×6 S235, NEd 400, e 21.7, a 4, βw 0.8 | Fw1 108.5, Fw2 291.5 kN; required lengths 65.25261 / 175.31 mm | 0.1 % | W1 p. 103 — A |
| VC-VNV-130 | FR-VNV-113 | PRL3 | unit | W2 Ex. 4.1 sub-areas and C | C existing 0.2353118, proposed 0.3151039 | 1e-6 rel | W2 pp. 25–26 — A |
| VC-VNV-131 | FR-VNV-113; TR-VNV-119 | PRL3 | unit | W2 Ex. 4.3: C 0.235 / 0.315, i 1.9 / 2.3 in/h (inputs), A 43.3 ac | Q 19.33345 / 31.37085 ft³/s (SI ×0.0283168) | 1e-6 rel | W2 p. 31 — A |
| VC-VNV-132 | FR-VNV-113 | PRL3 | unit | W2 Ex. 5.1: SL 0.010, Sx 0.020, n 0.016; Q 1.8 ft³/s; T 8.2 ft | T 9.029873 ft; Q 1.401752 ft³/s | 1e-6 rel | W2 p. 48 — A |
| VC-VNV-133 | FR-VNV-113 | PRL3 | unit | W2 Ex. 5.2 A: W 2 ft, a 2 in, SL 0.01, Sx 0.02, n 0.016, T 8.2 ft | Sw 0.1033333; Qs 0.6644678; Eo 0.7111353; Q 2.300273 ft³/s | 1e-6 rel | W2 pp. 49–50 — A |
| VC-VNV-134 | FR-VNV-113 | PRL3 | unit | W2 Ex. 6.1: trapezoid B 2.6 ft, z 3, d 1.6 ft, So 0.01, n 0.030 | A 11.84 ft²; R 0.9308697 ft; Q 55.91245 ft³/s; V 4.722335 ft/s | 1e-6 rel | W2 pp. 66–67 — A |
| VC-VNV-135 | FR-VNV-113 | PRL3 | unit | W2 Ex. 9.1: Q 17.6 ft³/s, So 0.015, n 0.013 / 0.017 | required D 1.691394 / 1.870399 ft → standard 21 in / 24 in; full flow (exact Manning) 19.40614 / 21.18745 ft³/s; published 19.3 / 21.1 within 1 % | 1e-6 rel (exact), 1 % (published) | W2 pp. 140–141 — A |
| VC-VNV-140 | FR-VNV-113 | PRL3 | unit | SSD at 30 / 50 / 70 mph, t 2.5 s, a 11.2 ft/s² | 196.6339 / 423.7054 / 727.5625 ft; design 200 / 425 / 730 ft | 0.1 ft; design exact | W3 + W4 — A |
| VC-VNV-141 | FR-VNV-113 | PRL3 | unit | SSD metric at 50 / 80 / 100 km/h | 63.42647 / 129.0118 / 184.2059 m; `alignment_report` K minima derived from these when sourced | 1e-6 rel | W4 — A (closed form) |
| VC-VNV-142 | FR-VNV-113, 105 | PRL3 | unit | Rmin at e 8 %, 50 mph | 758 ft (published); 757.5758 with assumed f 0.14; until f is sourced, row carries `ALN_TABLE_UNSOURCED` | 3 s.f. | W5 — B (non-gating) |
| VC-VNV-143 | FR-VNV-113 | PRL3 | unit | Barnett spiral length, C 0.6 | TBD — locate a free published example | — | C (non-gating) |
| VC-VNV-145 | FR-VNV-101, 106 | PRL3 | unit | NAFEMS LE1 (owner pack VC-FEA-30) | the FEA record cites VC-FEA-30 with target σyy(D) 92.7 MPa, 2 %; report appendix shows its last result | exact (citation) | W6 — A |
| VC-VNV-146 | FR-VNV-101, 106 | PRL3 | unit | NAFEMS LE10 (VC-FEA-31) | record cites −5.38 MPa, 3 % | exact (citation) | W6 — A |
| VC-VNV-147 | FR-VNV-101 | PRL3 | unit | NAFEMS T1 (VC-TMC-03) | record cites 50.0 MPa | exact (citation) | W7 — B here |
| VC-VNV-148 | FR-VNV-101 | PRL3 | unit | NAFEMS T3 (VC-THM-03) | record cites 36.6 °C | exact (citation) | owner pack — B here |

**Grade-A worked-example cases: 16** (VC-VNV-120…126 steel 7, 130…135 drainage 6, 140 alignment 1, 145…146 FEA 2), plus the
closed-form case 141. Non-gating: 142 (B), 143 (C), 147–148 (gated in their owner packs).

FR → VC: 101 → 101, 145–148; 102 → 102, 121; 103 → 103; 104 → 104; 105 → 105, 142; 106 → 106, 145, 146; 107 → 107; 108 → 106,
122, 123; 109 → 108; 110 → 109; 111 → 110; 112 → 111; 113 → 112, 120–143; 114 → 113, 123–125; 115 → 114; 116 → 101, 115;
117 → 116; 118 → 117, 125; 119 → 119; 120 → 118.

## Checks found with no V&V basis today

`check_steel_members` (all rows), `check_portal_frames` / `design_portal_frames` (incl. sway), `check_bracing`, `check_purlins` /
`design_purlins`, `check_crane_runways` (incl. fatigue), `check_foundations`, `design_footings`, `check_pipe_supports` (span table
echoed, not independently sourced), `pipe_hydraulics`, `alignment_report` design checks (radius, K, spiral), `set_superelevation`,
`check_drainage_network` / `size_drainage_pipes`. Cases above give steel, drainage and alignment a published basis at MVP; the rest
stay `unvalidated` (with `VNV_UNVALIDATED_CHECK`) until M6 transcribes cases for them.

## Data

| File | Content |
| ---- | ------- |
| [`data/steel_en1993_jrc.json`](data/steel_en1993_jrc.json) | VC-VNV-120…126: inputs, published, derived, errata (W1, sha256 pinned) |
| [`data/drainage_hec22.json`](data/drainage_hec22.json) | VC-VNV-130…135 (W2, sha256 pinned) |
| [`data/alignment_sight_distance.json`](data/alignment_sight_distance.json) | VC-VNV-140…143 (W3–W5) |
| [`data/fea_reference_pointers.json`](data/fea_reference_pointers.json) | VC-VNV-145…148: pointers to the owning packs, not re-transcribed |

The PDFs are not stored in the repository (JRC: rights reserved; HEC-22: large); URL + sha256 + size are in
[`sources.md`](sources.md). Derived values were computed with a scratch Node script on 2026-10-28; TR-VNV-114 makes the suite
recompute them, so no derived number is trusted on this file's word.

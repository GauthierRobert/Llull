# 07 VNV — Engineering V&V and calculation report — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`../../../.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).
Ids from 101 (the physics harness [`../../physics/00-vv-harness/`](../../physics/00-vv-harness/) owns FR/TR/VC-VNV-01…).

## 1. Current state (audit of main f1351cff, 2026-10-28)

### 1.1 Engineering checks and their evidence

| Command | Defined | Claims | Clause in result | Hard-coded NDPs / factors | Tests compare against |
| ------- | ------- | ------ | ---------------- | ------------------------- | --------------------- |
| `check_steel_members` | `packages/domain-aec/src/industrial/steelDesign/steelMembersCheck.ts:32` | EN 1993-1-1 §5.3.2, 6.2.x, 6.3.1, 6.3.2, 6.3.3 (Annex B); EN 1990 1.35G + 1.5Q | text inside row name (`steelMemberRows.ts:36`); `data.assumptions` (:180) | `GAMMA_M1 = 1.0`, `GAMMA_M2 = 1.25` (`steelDesign.ts:10-11`), γM0 implicit (:55), bolt fub 800 (:12), γG 1.35 / γQ 1.5 (`shared/loadFactors.ts`), φ0 0.005 (:76) | hand calc in test (`building/steelMembersCheck.test.ts:156`); section properties vs "catalogue values" (`sectionProperties.test.ts:6`) — **no published example** |
| `check_portal_frames`, `design_portal_frames` (sway, haunch) | `frames/frameCheckPortal.ts:14`, `frames/frameDesign.ts:24` | EN 1990 6.10, EN 1991-3, EN 1991-1-4, EN 1993-1-1 6.2/6.3, -1-8, EN 1993-6 7.3 | labels | ψ0 snow 0.5, wind 0.6, crane 1.35 literals (`frameCheckSolve.ts:39-88`) | χ curve values; Mcr IPE300 6 m = 90.5 kNm "catalogue It" with no source (`frameLoads.test.ts:84`); wL²/12; wind cpe tables typed in — **no published example** (only "SCI P397" in a comment, `frameCheckSolve.ts:159`) |
| `check_bracing` | `bracing/bracingCheckRun.ts:20` | EN 1993-1-1 5.3.3, EN 1991-1-4 | description | γM0 1 in text (:28), `bracingModel.ts:42-48` | statics hand formula — **none** |
| `check_purlins`, `design_purlins` | `purlins/purlinCheckRun.ts:20`, `purlinDesign.ts:55` | EN 1993-1-3 5.5 / 10.1, EN 1993-1-5 4.4, EN 1993-1-1 6.3.2.3 | description | combination factors (`purlinAnalysis.ts:152-178`), cold-formed χ 0.75 / 0.6 | hand ρ check — **none** |
| `check_crane_runways` (fatigue, LTB, local stress, buffer, test load) | `runway/runwayCheckRun.ts:30` | EN 1991-3, EN 1993-6 5.7.1 / 7.3 / 9.4.2, EN 1993-1-9 Tab 8.10 | yes, in row text (`runwayBeamCheck.ts:156`, asserted `runwayCheck.test.ts:172`) | γMf 1.15, γM0 1, detail 71, λ {S2 .315, S3 .397, S4 .5}, φ7 1.25, γbuffer 1, γtest 1.1, C1 1.13 (`runwayCheckModel.ts:40-80`) | hand leff 166.1 (`runwayCheck.test.ts:159-173`); fatigue only ordinal — **none** |
| `check_foundations`, `design_footings` | `foundations/foundationCheckRun.ts:28`, `footingDesignCommand.ts:33` | EN 1997 DA2, EN 1993-1-8 6.2.2(7) / 6.2.8, EN 1992-1-1 6.2.2 / 6.4.4 | row text (`foundationRows.ts:135`) | γR,h 1.1, μ 0.45 (`foundationModel.ts:68-70`), 0.9 on weights, fcd = fck/1.5, fyd = 0.87 fyk, C25/30, B500, cover 50 (`footingModel.ts:1-12`) | hand settlement — **none** |
| `check_pipe_supports` | `piping/pipeSupportCheck.ts:173` | MSS SP-69 / B31.1 Table 121.5 spans | `data.assumptions` (:60-66) | span table (`pipeSpans.ts`, comment "typical suggested values, not a quoted clause" :7) | the same literals re-typed in the test — echo, **not independent** |
| `pipe_hydraulics` | `piping/pipeHydraulics.ts:26` | Darcy / Colebrook | no | water ρ μ, roughness 0.045 | hand calc DN100 50 m³/h — **none** |
| `alignment_report` design checks | `civil/road/roadReportCommands.ts:43`, `roadChecks.ts:59` | "simple AASHTO-style tables" (`roadChecks.ts:2`); R = V²/(127(e+f)); Ls = V³/(46.656 C R), C = 0.6 | `checks.assumptions` | SPEED_TABLE f, Kcrest, Ksag (`roadChecks.ts:21-24`) — unsourced | formula echo `6400/(127·0.14)` (`roadCommands.test.ts:320`); clothoid vs Fresnel series (:625-634) — **no published example** |
| `set_superelevation` | `civil/road/roadSuperelevationCommand.ts:20` | none | — | user max rate | self-consistency |
| `check_drainage_network`, `size_drainage_pipes`, `drainage_schedule` | `civil/drainage/drainageAnalysisCommands.ts:96 / 261 / 208` | Manning, Rational Method, IDF i = a/(t+b)^c, HGL — **no manual cited** | no | n 0.013, vmin 0.6, vmax 3 (`drainageCriteria.ts:21`) | Manning hand calc 300 mm at 1 % = 0.0969 m³/s (`drainage.test.ts:33-35`), surcharged HGL hand calc (:466) — **none** |
| `check_grating`, `check_access`, `check_pipe_spec`, `check_piping`, `line_heat_loss` | plant | plant pack VCs | codes `STA_*`, `PSC_*` | — | plant packs' published tables (VC-STA-06 grating row) — the only AEC-side published reference |
| CAE: `hand_check`, `compute_margins`, `check_fatigue`, `check_damage_tolerance`, `check_thermal`, `thermal_stress_check`, `check_structural_dynamics`, `check_convergence`, `compare_to_expected` | `packages/domain-cae/src/**` | closed forms, ASTM E1049, NAFEMS T1/T2/T3/T4, LE11, NPARC | margins name each factor with source + `defaulted` (`marginMath.ts:35-43`) | — | physics / aerospace packs' VCs; LE1 / LE10 plans exist but are not yet in tests; FV32, Lee frame, R0020 not in tests |

### 1.2 Infrastructure to reuse

| Need | Exists | Where |
| ---- | ------ | ----- |
| Grade-aware judge (A → pass/fail, B → pass/warn, C → skip; rel / abs / exact; unit conversion) | `judgeCase`, codes `VNV_BENCHMARK_FAILED`, `VNV_BENCHMARK_UNCONFIRMED`, `VNV_EXPECTED_TBD` | `packages/domain-cae/src/vnv/judge.ts:97`, schema `vnv/expected.ts:13` |
| Benchmark runner + gate | `llull run_benchmarks`, `npm run quality:physics` (discovers `docs/physics/<pack>/validation/expected_results.json`) | `server/src/cli/benchmarks.ts:73,259-280`, `quality/physicsBenchmarks.mjs` |
| Document hash | `document_content_hash` command, `sha256Hex` | `packages/core/src/commands/persistence/releaseScope.ts:36`, `packages/core/src/lib/sha256.ts` |
| Signatures, human gate | `record_signature` (Ed25519, trusted key, meaning authorship / review / approval / release, `signedSha256`), `submit_for_review`, `record_approval`, `PLM_HUMAN_GATE` | `packages/plm/src/commands/signature.ts:25`, `review.ts:105-182`, `types.ts:18-36` (target kinds `release` / `iteration` / `change` only) |
| Check table | `checkTable`, `failureSummary` → CSV | `industrial/reports/checkReport.ts:7-37` |
| Results views | `analysis_report` (reviewRequired on thermal / explicit / dynamic) | `domain-cae/src/commands/analysisReport.ts:33` |
| Version | `0.1.0` in `package.json:3`; CLI `LLULL_VERSION ?? 'dev'` (`server/src/cli/plm.ts:254`); release manifest omits the tool version (`plm/src/manifest.ts:22`) | — |

Gaps: no record, no design basis, no NDP data, no structured clause, no report, no report signature, AEC refusals uncoded
(only `RTE_SUPPORT_ORPHAN`, `EQP_NOT_PARAMETRIC`), benchmark discovery limited to `docs/physics`.

## 2. Layer placement (L1–L10)

| Piece | Layer | Why |
| ----- | ----- | --- |
| `ClauseRef`, `VnvStatus`, `NdpValue` types; `designBasis` document slice | `packages/core/src/model` (types) + core commands `document/` | design basis is document data used by several plugins (L4, L8); core must not know a plugin (L10), so the slice is generic (standard-set id + annex id + overrides) |
| NDP tables (EN recommended, BE) | data modules in `packages/domain-aec/src/shared/ndp/` (`en1993.ts`, `en1990.ts`, `en1997.ts`); civil tables in `civil/road/designTables.ts` | domain rules live in the plugin (AF-30, L10) |
| V&V records | data modules beside each check (`<check>/vnvRecord.ts`) exporting a typed `VnvRecord`; one registry `shared/vnv/records.ts` | the record versions with the code that it describes |
| Check rows | existing check commands gain `clause: ClauseRef`, `ndp: NdpUse[]`, `intermediate: NamedValue[]` per row | smallest change; `CommandResult` contract unchanged (L8) |
| `calculation_report` | read-only command in `packages/domain-aec/src/shared/report/` composing checks through `ctx.registry` / `execute` (L10: composes other commands) — CAE items delegate to `analysis_report` data | one command, UI button + CLI tool (L1, L5) |
| HTML render | pure function in the same package (string in, string out; no DOM) | L2 |
| PDF | desktop host (`desktop/`: Electron `printToPDF` of the HTML), offline | side effect in a host (L2, L6) |
| Signature on a report | `packages/plm`: `record_signature.target.kind` gains `calculation_report` | the signature path stays single (L1) |
| Regression suite | `tests/unit/vnv/*.test.ts` reading `docs/readiness/07-engineering-vnv/validation/data/*.json`; harness discovery extended | tests in `npm run check` (W3) |

No law is broken. Open tension: none.

## 3. Data model

```ts
// packages/core/src/model (generic, plugin-agnostic)
interface ClauseRef { standard: string; edition: string; clause: string; item?: string; annex?: { id: string; edition: string | null } }
type VnvStatus = 'validated' | 'verified' | 'unvalidated';
interface NdpValue { key: string; value: number | string; unit: string; clause: ClauseRef; source: string; grade: 'A' | 'B' | 'C';
  verified: boolean; overridden?: { by: string; reason: string } }
interface DesignBasis { standardSet: string; annex: string; annexEdition: string | null; overrides: Record<string, { value: number | string; reason: string }> }
// doc.designBasis?: DesignBasis   (document data, replayed like any FeatureStep)

// packages/domain-aec/src/shared/vnv
interface VnvRecord {
  id: string; version: number; command: string; scope: string; members: string[];
  clauses: ClauseRef[]; ndpKeys: string[]; assumptions: string[];
  limits: Array<{ code: string; condition: string }>;           // each limit = one refusal code (§7)
  cases: Array<{ vc: string; source: string; grade: 'A' | 'B' | 'C'; clauses: string[] }>;
  errata: Array<{ source: string; page: string; note: string }>;
}
// status(record) = 'validated' if every clause group has >= 1 passing grade-A case; 'verified' if only closed forms; else 'unvalidated'

// report (returned in data, never stored as a separate truth)
interface CalculationReport {
  schema: 'llull.calc-report/1'; title: string; createdAt?: string;      // host-supplied time only
  software: { version: string; commit: string }; documentHash: string;
  designBasis: DesignBasis; ndpTable: { id: string; version: number; values: NdpValue[] };
  records: Array<{ id: string; version: number; status: VnvStatus }>;
  items: Array<{ entityId: string; label: string; inputs: NamedValue[];
    checks: Array<{ command: string; row: string; clause: ClauseRef; intermediate: NamedValue[]; utilisation: number;
      verdict: 'pass' | 'fail' | 'refused'; code?: string; warnings: string[] }> }>;
  reviewRequired: true; reviewReason: string; reportSha256: string;      // sha256 of canonical JSON without reportSha256
}
interface NamedValue { symbol: string; value: number | string; unit: string; formula?: string; clause?: string }
```

## 4. Technical requirements

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-VNV-101 | MUST | `VnvRecord` type, registry `listVnvRecords()`, read-only command `vnv_record { command }` returning the record + computed status. Contract test: every command tagged `annotations.engineeringCheck: true` has a record; every record's `cases[].vc` exists in this pack's `expected_results.json` |
| TR-VNV-102 | MUST | Check rows gain `clause: ClauseRef` (+ `intermediate`, `ndp`). Existing `name` text kept for the CSV. Snapshot of `toToolSchemas()` unchanged (data shape only) |
| TR-VNV-103 | MUST | Core command `set_design_basis { standardSet: 'eurocodes', annex: 'EN-recommended' \| 'BE', annexEdition? }` and `set_ndp_override { key, value, reason }` (reason min 10 chars). Checks read `doc.designBasis`; none ⇒ refusal `VNV_DESIGN_BASIS_MISSING` |
| TR-VNV-104 | MUST | NDP tables as typed data with `grade`, `verified`; resolver `ndp(doc, key)` returns `NdpValue` and is the ONLY way a check reads a factor (constants in §1.1 removed; lint: no numeric literal named `GAMMA_*` outside `shared/ndp`) |
| TR-VNV-105 | MUST | `unverified` propagation: any `NdpValue.verified === false` used in a row adds warning `VNV_NDP_UNVERIFIED` to the row, the check result and the report (AF-32) |
| TR-VNV-106 | MUST | `calculation_report { scope: { entityIds? , layer?, all? }, checks?: string[], format: 'json' \| 'html', title? }` read-only; runs each check through `execute` on the current doc (no mutation), assembles `CalculationReport`; `format: html` returns the rendered string in `data.html` (CLI `--save report.html`) |
| TR-VNV-107 | MUST | Canonical JSON (sorted keys, numbers as shortest round-trip `toString`, no time unless host-supplied `createdAt`) → `reportSha256 = sha256Hex(canonical)`. `software.commit` from the build (`LLULL_COMMIT` baked at build; `dev` builds add warning `VNV_UNRELEASED_BUILD`) |
| TR-VNV-108 | MUST | Unrounded values in data; HTML displays 4 significant figures and states it; factors (χ, Φ, λ̄) are never rounded before use (test: VC-VNV-122…124 match derived, not published) |
| TR-VNV-109 | SHOULD | Desktop menu "Export calculation report…" → HTML + PDF (`webContents.printToPDF`, offline); CLI `llull calculation_report … --save x.html`; CSV appendix from `checkTable` |
| TR-VNV-110 | MUST | `record_signature.target.kind` += `'calculation_report'`, `ref` = `reportSha256`; the signed bytes are the canonical report JSON; the PLM slice stores `{ reportSha256, documentHash, signatures[] }` in `plm.reports`. Agent ⇒ `PLM_HUMAN_GATE`; unknown report ⇒ `VNV_REPORT_UNKNOWN` |
| TR-VNV-111 | MUST | `calculation_report_status { reportSha256 }` compares the stored `documentHash` with the current `document_content_hash`: different ⇒ `stale: true`, code `VNV_REPORT_STALE`; the UI shows it on every signature |
| TR-VNV-112 | MUST | Out-of-scope refusals per record `limits[]` with the codes of §7, returned as `verdict: 'refused'` rows (the check does not abort other items); summary names count and codes |
| TR-VNV-113 | MUST | `tests/unit/vnv/<domain>.test.ts` load `validation/data/*.json`, convert units exactly, call the real commands through `execute` on a built document (plans in `validation/plans/` when geometry is needed), compare against `derived` with the case tolerance; grade A fails the test, B / C are `it.todo` / skipped with reason. Runs in `npm run check` |
| TR-VNV-114 | MUST | Data files carry `published`, `derived`, `errata`; a test asserts that `derived` reproduces `published` within the stated rounding (proves the transcription), and that llull matches `derived` (proves llull) |
| TR-VNV-115 | MUST | `run_benchmarks` discovery extended to `docs/readiness/*/validation/benchmark_cases.json` (generated from `data/*.json` by `validation/generate_benchmark_cases.mjs`, harness schema of `vnv/expected.ts`), so `npm run quality:physics` and the readiness gate read the same numbers |
| TR-VNV-116 | MUST | `reviewRequired: true` + `reviewReason` on every engineering check result and on the report; HTML first page carries the fixed sentence of §6 |
| TR-VNV-117 | SHOULD | `VnvRecord.version` bump enforced: a contract test hashes each check's source files + tables; a hash change without a version bump fails (`VNV_RECORD_VERSION_STALE`) |
| TR-VNV-118 | SHOULD | `docs/readiness/07-engineering-vnv/validation/errata.md` generated from records' `errata`; linked from the report's V&V appendix |
| TR-VNV-119 | MUST | Units: inputs converted with `@core/model/units`; HEC-22 CU constants replaced by SI forms (Ku 0.56 → 0.376 gutter, 1.486 → 1 Manning, KQ 0.46 → 0.312 pipe, as printed in HEC-22) |

## 5. Algorithms

1. **Report assembly.** For each item in scope, for each applicable check: `execute(doc, check, { entityIds:[id], detail: true })`
   (read-only checks; `detail` adds `intermediate`), collect rows; attach record id + version + status; gather the NDP values used.
   Sort items by entity id, rows by record clause order. Canonicalise, hash.
2. **Status.** `validated` iff for each clause group in `record.clauses` at least one `cases[]` with grade A passed in the last CI run
   (the passing set is baked at build into `vnvStatus.json` by the suite; the app never runs tests at runtime).
3. **Staleness.** stored `documentHash` ≠ current hash ⇒ stale. Signatures are kept, shown as "signed for an earlier state".
4. **Erratum handling.** A case's gate is `derived`; if `|published − derived| / derived > rounding tolerance` and no erratum is
   recorded, the transcription test fails (forces a human to record why).

## 6. Fixed report sentence

"Computed by llull <version> (<commit>). Not approved: these results need review and signature by a qualified engineer, who
remains responsible for the design. V&V status of each check and its limits are listed in appendix A."

## 7. Error and finding codes

| Code | Kind | When |
| ---- | ---- | ---- |
| `VNV_DESIGN_BASIS_MISSING` | refusal | Eurocode check, no `designBasis` |
| `VNV_NDP_UNKNOWN` | refusal | override of a key not in the table |
| `VNV_NDP_UNVERIFIED` | warning | an unverified NDP was used |
| `VNV_NDP_OVERRIDDEN` | info | a user override was used (value + reason shown) |
| `VNV_REPORT_STALE` | warning | report / signature older than the document |
| `VNV_REPORT_UNKNOWN` | refusal | signature on an unknown report hash |
| `VNV_UNRELEASED_BUILD` | warning | report from a `dev` build |
| `VNV_UNVALIDATED_CHECK` | warning | a check with status `unvalidated` contributed to the report |
| `VNV_RECORD_VERSION_STALE` | CI failure | code / table changed, record version not bumped |
| `STL_SECTION_CLASS4` | refusal row | class 4 cross-section (effective properties to EN 1993-1-5 not implemented) |
| `STL_TAPERED_MEMBER` | refusal row | non-prismatic member |
| `STL_SECTION_UNSUPPORTED` | refusal row | section family without a record (e.g. angles in LTB) |
| `STL_FIRE_UNSUPPORTED` | refusal row | fire design situation requested (EN 1993-1-2 not implemented) |
| `STL_BOLT_CLASS_UNKNOWN` | refusal row | bolt class not in the αv / fub table |
| `DRN_PRESSURE_FLOW_UNSUPPORTED` | refusal row | HGL above crown where a component's loss model is open-channel only |
| `DRN_IDF_UNSOURCED` | warning | IDF coefficients with no source given |
| `ALN_SPEED_OUT_OF_TABLE` | refusal row | design speed outside the sourced speed table |
| `ALN_TABLE_UNSOURCED` | warning | f / K values not graded A (today all) |
| existing | — | `PLM_HUMAN_GATE`, `VNV_BENCHMARK_FAILED`, `VNV_BENCHMARK_UNCONFIRMED`, `VNV_EXPECTED_TBD`, `FEA_*`, `PSC_*`, `STA_*` |

The exact limit list per check is part of its record; the codes above are the MVP set.

## 8. Per-check V&V plan (MVP)

| Check | Clause groups | Cases (this pack) | Today's status | MVP target |
| ----- | ------------- | ----------------- | -------------- | ---------- |
| `check_steel_members` tension | EN 1993-1-1 6.2.3, -1-8 3.10.3 | VC-VNV-120 | unvalidated | validated |
| … compression / flexural buckling | 6.2.4, 6.3.1, Table 5.2 | VC-VNV-121 | unvalidated | validated |
| … bending, shear, LTB general case | 6.2.5, 6.2.6, 6.3.2.2 | VC-VNV-122, 123, 124 | unvalidated | validated (Mcr as input; Mcr formula verified only) |
| … N + M interaction (6.3.3) | 6.3.3, Annex A/B | none yet (JRC Example 1.3.5.2 to transcribe, V1) | unvalidated | unvalidated (flagged) |
| bolts (inside frame / connection checks) | -1-8 Table 3.4, 3.10.3 | VC-VNV-125 | unvalidated | validated, erratum recorded |
| fillet welds | -1-8 4.5.3.3 | VC-VNV-126 | unvalidated | validated |
| `check_drainage_network`, `size_drainage_pipes` | Rational Method, Manning (channel, gutter, pipe full flow) | VC-VNV-130…135 | unvalidated | validated (HGL losses: V1, HEC-22 Example 9.2) |
| `alignment_report` sight distance / K | SSD closed form | VC-VNV-140, 141 | unvalidated | verified (closed form); K tables `ALN_TABLE_UNSOURCED` |
| … minimum radius | R = V²/(127(e+f)) | VC-VNV-142 (B) | unvalidated | verified; f unsourced |
| … spiral length | Barnett | VC-VNV-143 (C) | unvalidated | unvalidated |
| CAE (FEA, thermal) | per physics pack | VC-VNV-145…148 (pointers) | owned by physics / aerospace packs | records reference those VCs |
| all V1 checks (§1.1) | — | to be transcribed | unvalidated | `VNV_UNVALIDATED_CHECK` until done |

## 9. Tests

- Unit: records contract (TR-101), design basis + NDP (TR-103…105), report canonical hash determinism (run twice, equal bytes;
  reorder entity insertion, equal bytes), staleness, refusal codes per limit, `is pure` for the two new mutating commands.
- Worked-example suite: TR-113 / 114 over `validation/data/*.json`.
- Contract: `toToolSchemas()` snapshot gains `set_design_basis`, `set_ndp_override`, `calculation_report`,
  `calculation_report_status`, `vnv_record`.
- Server: CLI `calculation_report --save` writes HTML; `record_signature` with target `calculation_report` from a test key on the
  server host; agent path refused.
- Desktop (pack 06 harness): export PDF offline; stale badge after an edit.

## 10. Milestones and dependencies

| M | Content | Depends on | Size |
| - | ------- | ---------- | ---- |
| M1 | records type + registry + `vnv_record`; ClauseRef on steel / drainage / alignment rows; refusal codes | — | 1 w |
| M2 | design basis + NDP tables + propagation. Grades: EN-recommended values B (quoted by W1 and vendors, EN text not read); BE values B ([R10], edition unconfirmed) — both `verified: false` until the owner supplies the texts | M1 | 1 w |
| M3 | worked-example suite VC-VNV-120…143 in `npm run check`; fix VC-VNV-125 behaviour (αv by class) | M1 | 1 w |
| M4 | `calculation_report` JSON + HTML, canonical hash, status | M1, M2 | 1.5 w |
| M5 | report signature + staleness (plm) ; desktop PDF | M4, pack 06 E2E harness | 1 w |
| M6 | V1 records for the remaining checks (transcribe JRC 1.3.5.2 beam-column, §2.2.7 header plate, §2.3 column bases; HEC-22 Example 9.2 HGL) | M3 | 2 w |
| M7 | qualified-engineer review (VC-VNV-119) | M5 | field |

Cross-pack: pack 04 DSF (document hash stability across save / load), pack 06 E2E (desktop export + sign), pack 09 COM (report
localisation, release commit id), pack 01 PIL (pilot engineers sign real reports).

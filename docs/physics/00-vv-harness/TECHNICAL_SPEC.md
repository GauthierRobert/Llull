# PHY-00: Physics V&V harness — technical specification

Gap id **VNV** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

Today's repository (verified by reading the code) plus what the aerospace packs add before this gap starts.

| Area | What exists | Path | Limit for V&V |
| ---- | ----------- | ---- | ------------- |
| Real-file quality gates | `npm run quality` = fetch pinned STEP corpus + synthetic STEP + import gate + display gate; `quality:drawings` | `package.json` scripts, `quality/corpus.json`, `quality/fetchCorpus.mjs`, `docs/QUALITY_GATES.md` | CAD data only; no analysis benchmarks |
| Production gate | Three drivers (`scripted`, `ui`, `agent`) grade one scenario with shared criteria; ratchet of known issues | `docs/PRODUCTION_GATE.md`, `npm run production:{scripted,agent,ui}` | Process-plant and civil scenarios; nothing physical |
| Plans | `build_project` runs `PlanAction { command, params?, as? }` lists with loops and `=expr`; `StepReport { index, path?, command, ok, summary, affected }` | `packages/core/src/commands/project/{types,buildProject,run,validate}.ts` | AF-14 adds `data?`/`error?`/`aliases` (shared prerequisite, owned by AGENT_FIRST) |
| Parameters and replay | `set_parameter` re-evaluates parameters and regenerates dependent feature steps whose params contain `=expr` leaves | `packages/core/src/commands/parametric/parameters.ts`, `commands/history/{regenerate,dependents}.ts` | Used here only to mark studies stale |
| Query pattern | `annotations: { readOnly: true }`, same document back, `data` | `packages/core/src/commands/inspect/measureSolid.ts` (`mass_properties`), `inspect/checkModel.ts` (`check_model`) | — |
| CLI | `llull run plan.json [--validate]`, `--json`, `--save PATH`, `--dry-run`, `--progress`, `--timeout SEC` | `server/src/cli/usage.ts`, `server/src/cli/main.ts` | No benchmark runner |
| 05 FEA (aerospace, built first) | `AnalysisCase` with `MeshControls.globalSize`, `MeshSummary`, `ResultsSummary`, probes; transports `fea_mesh`, `fea_solve`; validated `record_fe_mesh` / `record_fea_results`; `FeArtifactStore`; staleness by `analysisInputHash` (TR-FEA-06); `validation/fea_analytic_expected.json` | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3–§5 | One mesh per case; no refinement study; expected-results file has its own field names (`tolerance_rel`) |
| Seeded MC | `lib/prng.ts` (xoshiro128**, SplitMix32 seed) from 03 GDT | `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md` §5.7 | Not used here (PHY-18 uses it) |

A `grep -ri "richardson\|convergence index\|manufactured"` over `packages/`, `server/src` and `tests/` finds nothing: no
V&V capability exists today.

## 2. Target architecture

```
server/ (host)                                    src/app  installDefaultPlugins() + physicsPlugins (vnv)
  cli: run_benchmarks ✱ (reads docs/**/validation/expected_results.json, runs harness recipes)
  feaRoutes: run_convergence_study ✱ (loops 05 fea_mesh/fea_solve per level, artifact store)
        │ dispatch record_convergence_study                        │
        ▼                                                          ▼
packages/domain-physics/src  (@phys)  ── CadPlugin "vnv", toolset "analysis"   (README §5.1 decision pending)
   vnv/commands/: check_convergence, compare_to_expected, check_verification,
                  record_convergence_study (validated), accept_verification_exception (human gate)
   vnv/expected.ts      zod schema of expected_results.json (README §6.3) + harness recipe
   vnv/judge.ts         pure verdict rules (grade → verdict)
        ▼ (public core API only, L10 + dependency-cruiser rule; 05 types read from core model/analysis.ts)
packages/core/src
   lib/convergence.ts   pure GCI arithmetic (observed order, Richardson, GCI, classification)  [lib, pure]
   lib/quantity.ts      (08 MAT) unit parse/convert, reused by the judge
```

**Placement under the dependency rule** (aligned with PHY-03 TECHNICAL_SPEC §2.1): `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids `packages/domain-physics` importing 05's `@cae`. The shared analysis data types (`AnalysisCase`, `FeaTarget`, `ResultsSummary`, mesh/result artifact shapes) live in core `model/analysis.ts` (05 TR-FEA-02), and this pack's additions go there too; behaviour that 05 must dispatch (staleness fields, check items) is registered through the core extension port proposed by PHY-03 (`CadPlugin.analysisExtensions`, `AnalysisTypeExtension`). **Proposal A (preferred):** `@phys` + core port, no package imports another package. **Proposal B (fallback):** the discipline lives inside the 05 FEA package (`packages/domain-cae/src/<discipline>/`). Pending README §5.1; everything below is written for A, under B only paths change.

**Laws respected**

- **L1/L5.** Every capability is a registry command or a host transport that applies its result through a registry
  command (`record_convergence_study`), like 05's `fea_solve` → `record_fea_results`.
- **L2.** `lib/convergence.ts` is a pure leaf; `@phys` imports only core's public API. The 05 types it reads
  (`AnalysisCase`, `ResultsSummary`, artifact shapes) are core types (`model/analysis.ts`, 05 TR-FEA-02); no package
  imports another package (rule `plugins-and-kernels-depend-on-core-only`). File and process access lives in `server/`.
- **L3/L4.** Studies live in the 05 `analysis` slice (`AnalysisCase.studies`); commands spread it.
- **L6.** The server forwards and loops; it holds no V&V arithmetic (the judge and GCI are pure functions).
- **L8.** `record_convergence_study` is a mutating step (replayable); study validity is computed from hashes, never
  stored as a flag.
- **L9.** No kernel use beyond what 05 transports already do.
- **L10.** New plugin package `packages/domain-physics` (`@phys`), discipline `vnv` (proposal, README §5.1).

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-VNV-01 | MUST | `packages/core/src/lib/convergence.ts`: pure functions `observedOrder`, `richardson`, `gci`, `classify`, `requiredSpacing`, `representativeSpacing`, `leastSquaresOrder` (V1). No allocation per call beyond the result; IEEE double; unit-tested against `validation/expected_results.json`. |
| TR-VNV-02 | MUST | Representative spacing: when a sample gives `elements` (count) and the study gives `measure` (length, area or volume of the domain) and `dimension`, h = (measure / elements)^(1/dimension) [R2][R9]. Otherwise `h` is required. |
| TR-VNV-03 | MUST | Observed order: constant ratio closed form; general ratios by fixed-point iteration p_{k+1} = ½ p_k + ½ \|ln\|e32/e21\| + q(p_k)\| / ln r21, q(p) = ln((r21^p − s)/(r32^p − s)), start p0 = \|ln\|e32/e21\|\| / ln r21, stop when \|Δp\| < 1e-14 or 10 000 iterations (`VNV_ORDER_NOT_CONVERGED`). Matches gcat [R9] (relaxation 0.5) to its tolerance. |
| TR-VNV-04 | MUST | Classification by R = e32/e21 (e21 = f2 − f1, e32 = f3 − f2, index 1 = finest): R < 0 oscillatory; 0 < \|R\| < 1 divergent; e21 = 0 or e32 = 0 converged_exactly; else monotone. Only monotone yields p. |
| TR-VNV-05 | MUST | With more than three samples, the GCI uses the three finest; every consecutive triplet is also reported (`triplets[]`), as the `convergence` package does [R8]. |
| TR-VNV-06 | MUST | Code-verification corpus: each solver pack that can manufacture a solution ships an MMS case in its `expected_results.json` with `formalOrder` and an observed-order case (abs tolerance 0.01 between the two finest levels). PHY-00 ships the 1D Poisson P1 reference (`validation/mms_poisson_1d.csv`). |
| TR-VNV-07 | MUST | `expected_results.json` schema (README §6.3, with the tolerated variations of §6.2) is validated by zod (`looseObject`) in `@phys/vnv/expected.ts`; the 05 FEA file (`tolerance_rel` / `tolerance_abs`, `sources`) is read through an adapter (§6) rather than rewritten. |
| TR-VNV-08 | MUST | Harness recipe per case (optional `harness` field, §6.3): plan path, CLI calls, and a JSON pointer to the measured value; cases without a recipe are run by the owning pack's test suite and reported by id. |
| TR-VNV-09 | MUST | `run_convergence_study` writes one 05 mesh + result artifact per level into `FeArtifactStore` (content-addressed, so re-runs hit the cache, AF-40), then dispatches `record_convergence_study` with level hashes; the record command validates them against the store exactly as 05 TR-FEA-33. |
| TR-VNV-10 | MUST | Determinism: same plan, levels and toolchain ⇒ identical `ConvergenceStudy` (values to the bit, order of levels fixed finest-first). |
| TR-VNV-11 | MUST | Agent-first result contract (AF-10/11/31–35): every `data` carries units, `safetyFactor { value, source, defaulted }`, `provenance`, `codes[]`, `unverified`, `reviewRequired` where relevant. |
| TR-VNV-12 | MUST | `accept_verification_exception` verifies a human-held signature through the 09 PLM signing port (as 05 TR-FEA-91). |
| TR-VNV-13 | SHOULD | `npm run quality:physics` (root script) → `npm --prefix server run quality:physics` → `run_benchmarks` over all packs; report JSON + Markdown in `.cache/quality-physics/reports/`. |

## 3. Data model

```ts
// packages/core/src/lib/convergence.ts (pure)
export interface ConvergenceSample { readonly h: number; readonly value: number }
export type ConvergenceStatus = 'monotone' | 'oscillatory' | 'divergent' | 'converged_exactly' | 'two_level';
export interface TripletReport {
  readonly levels: readonly [number, number, number];        // indices into the finest-first sample list
  readonly r21: number; readonly r32: number;
  readonly status: ConvergenceStatus; readonly ratio: number; // e32 / e21
  readonly p?: number; readonly extrapolated?: number;
  readonly ea21?: number; readonly eext21?: number;           // fractions
  readonly gci21Fine?: number; readonly gci21Coarse?: number; readonly gci32Fine?: number;
  readonly asymptoticRatio?: number;
}
export function observedOrder(s: readonly ConvergenceSample[]): { p: number; iterations: number } | { status: ConvergenceStatus };
export function gciTriplet(s: readonly [ConvergenceSample, ConvergenceSample, ConvergenceSample], fs: number): TripletReport;
export function requiredSpacing(gciTarget: number, gci21: number, p: number, h1: number): number;

// packages/core/src/model/analysis.ts additions (data types in core, like 05 TR-FEA-02; README §6.2 adjusted by PHY-03 §2.1)
export interface NamedValue { readonly value: number; readonly source: string; readonly defaulted: boolean }
export type StudyQuantity =
  | { readonly kind: 'probe'; readonly probe: string; readonly component: string }     // 05 add_result_probe name
  | { readonly kind: 'field_max'; readonly field: 'von_mises' | 'u_mag'; readonly loadCase: string }
  | { readonly kind: 'frequency'; readonly mode: number }
  | { readonly kind: 'buckling_factor'; readonly mode: number };
export interface StudyLevel {
  readonly index: number;                 // 0 = finest
  readonly globalSize: number;            // analysis length unit
  readonly elements: number; readonly h: number;   // representative spacing (TR-VNV-02)
  readonly value: number;
  readonly meshHash: string; readonly resultsHash: string; readonly inputHash: string;  // 05 TR-FEA-06
  readonly solver: string; readonly solverVersion: string; readonly mesher: string; readonly mesherVersion: string;
}
export interface ConvergenceStudy {
  readonly id: string;                    // `cs-<step>.<k>` (L8)
  readonly analysisId: string;
  readonly quantity: StudyQuantity; readonly unit: string;
  readonly refinement: 'h' | 'time_step' | 'order';            // V1: time_step, order
  readonly ratio: number; readonly levels: readonly StudyLevel[];
  readonly formalOrder?: NamedValue;      // from element type table §5.4, or caller
  readonly safetyFactor: NamedValue;      // 1.25 (>= 3 levels) / 3 (two levels), §5.2
  readonly report: TripletReport; readonly triplets: readonly TripletReport[];
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly exception?: { readonly code: string; readonly justification: string; readonly signer: string; readonly signedAt: string };
}
// 05 AnalysisCase gains (optional, absent until the first study):
//   studies?: Record<string, ConvergenceStudy>; studyOrder?: string[];

// packages/domain-physics/src/vnv/expected.ts — README §6.3, plus optional harness recipe
export type JsonValue = number | string | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue };
export interface ExpectedCase {           // zod: z.looseObject — extra per-case keys (inputs, derivation, note, crossCheck…) kept, ignored
  readonly id: string; readonly quantity: string;
  readonly value: JsonValue;              // number | 'TBD' | code / label string | boolean | list | record | null (contract case, see `expected`)
  readonly unit: string;                  // physical unit, or a non-physical tag: '-', '1', 'code', 'bool', 'ids', 'count', 'columns'
  readonly tolerance: { readonly rel?: number | null; readonly abs?: number | null; readonly exact?: boolean };
  readonly source: string; readonly grade: string;   // normalised: leading 'A' | 'B' | 'C' | 'TBD' (e.g. "A (given the table)" -> A, note kept)
  readonly proves: readonly string[];
  readonly expected?: JsonValue;          // behaviour contract when value is null (codes, flags, named defaults)
  readonly harness?: { readonly plan?: string; readonly calls: readonly string[]; readonly pointer: string; readonly kernel?: 'occt' | 'manifold' };
}
export interface ExpectedResultsFile {    // z.looseObject: extra top-level keys (constants, units, units_note, workedExample…) allowed
  readonly pack: string; readonly generatedBy: string; readonly cases: readonly ExpectedCase[];
}
export type Verdict = 'pass' | 'fail' | 'warn' | 'skip' | 'error';
export interface BenchmarkRow {
  readonly pack: string; readonly caseId: string; readonly verdict: Verdict; readonly code?: string;
  readonly expected: ExpectedCase; readonly measured?: { readonly value: number; readonly unit: string };
  readonly relError?: number; readonly absError?: number; readonly durationMs: number;
  readonly toolchain: Record<string, string>;      // llull, kernel, ccx, mesher (Netgen) versions
}
```

Document version: the `studies` map rides the 05 `analysis` slice inside the aerospace v3 envelope (01 KRN §3.1); no
new migration (README §6.2).

## 4. Commands

Plugin `vnv`, toolset `analysis`. ✱ = host transport (not a registry command; it runs processes or reads files and
applies results through a registry command).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `check_convergence` | query (`readOnly`) | `{ quantity: string, unit: string, samples: [{ h?: number (length unit), elements?: integer, value: number }] (2–12), measure?: number (domain length/area/volume in unit^dimension), dimension?: 1\|2\|3, formalOrder?: number, orderTolerance?: number (default 0.5, named), assumedOrder?: number (required for 2 samples), safetyFactor?: number, gciTarget?: number (fraction) }` → `data { status, codes[], p?, extrapolated?, ea21?, eext21?, gci21: { fine, coarse }, gci32Fine?, asymptoticRatio?, requiredSpacing?, triplets[], safetyFactor: NamedValue, formalOrder?, provenance, unit }` | @affects nothing · @invariant same doc back; non-monotone ⇒ no `extrapolated`; Fs named (AF-31) · @failure < 2 samples, duplicate or non-positive h, non-finite value, 2 samples without `assumedOrder` → `VNV_SAMPLES_INVALID` (no data) |
| `compare_to_expected` | query | `{ expected: ExpectedCase, measured: { value, unit } \| null }` → `data { verdict, code?, relError?, absError?, convertedValue }` | @invariant grade A ⇒ pass/fail, B ⇒ pass/warn, C/TBD ⇒ skip · @failure malformed case → `VNV_EXPECTED_INVALID` |
| `check_verification` | query | `{ analysisId, gciTarget?: number (fraction, no default), quantities?: StudyQuantity[] }` → `data { status: 'pass'\|'warn'\|'fail', items: [{ code, severity, ids[], message, remediation }], studies: [{ id, state: 'current'\|'stale'\|'missing', gci, status }], reviewRequired, unverified }` | read-only readiness check (AF-20); codes §7.1 |
| `record_convergence_study` | mutating (validated) | `{ analysisId, study: Omit<ConvergenceStudy, 'id' \| 'report' \| 'triplets'> }` | @affects `analysis.cases[a].studies` · @invariant every level's `meshHash`/`resultsHash` exists in the artifact store, value equals the value re-extracted from the artifact, `report` is recomputed by `lib/convergence` (never taken from params) · @failure `VNV_ARTIFACT_NOT_FOUND`, `VNV_SUMMARY_MISMATCH`, analysis missing → no-op |
| `delete_convergence_study` | mutating | `{ analysisId, studyId }` | @affects `studies` · @failure unknown id → no-op |
| `accept_verification_exception` | mutating, **human gate** | `{ analysisId, studyId, code, justification, signature }` | @invariant signature verified by the 09 signing port; records signer and the study's level hashes · @failure agent caller / no valid signature → `VNV_HUMAN_GATE`, doc unchanged |
| ✱ `run_convergence_study` | transport | `{ analysisId, quantity: StudyQuantity, levels?: integer (3, max 6), ratio?: number (2, named), finest?: number (globalSize of the finest level; default = case's own), timeoutS? }` | per level: clone the case's mesh controls in memory with `globalSize × ratio^k`, run 05 mesh + solve, extract, store artifacts; then dispatch `record_convergence_study`. Case mesh controls untouched |
| ✱ `run_benchmarks` | transport (host / CI) | `{ packs?: string[], grades?: ('A'\|'B'\|'C')[], caseIds?: string[], save?: path }` | discovers files, runs harness recipes through the CLI in-process, judges with `compare_to_expected`, writes report; exit 1 on any A-grade `fail`/`error` |

Every command description states units, refusals and the next command (AF-02), e.g. `check_convergence`: "…returns
the observed order, the Richardson-extrapolated value and the Grid Convergence Index (fraction) of the finest sample;
classify first: oscillatory or divergent samples get a code and no extrapolation; next: refine further or call
`check_verification`."

## 5. Kernel / algorithms

### 5.1 GCI arithmetic (TR-VNV-01, 03, 04)

Samples sorted finest-first (h1 < h2 < h3). With r21 = h2/h1, r32 = h3/h2, e21 = f2 − f1, e32 = f3 − f2 [R2][R9]:

```
R = e32 / e21                      classify (TR-VNV-04); stop unless monotone
s = sign(R) (= +1 when monotone)
p0 = |ln |R|| / ln r21
iterate p = ½ p + ½ |ln |R| + ln((r21^p − s)/(r32^p − s))| / ln r21      (constant r: q = 0 ⇒ p = ln R / ln r)
f_ext  = (r21^p f1 − f2) / (r21^p − 1)
e_a21  = |(f1 − f2)/f1|      e_ext21 = |(f_ext − f1)/f_ext|
GCI21_fine   = Fs e_a21 / (r21^p − 1)       GCI21_coarse = GCI21_fine · r21^p
GCI32_fine   = Fs e_a32 / (r32^p − 1),  e_a32 = |(f2 − f3)/f2|
asymptotic ratio AR = r21^p GCI21_fine / GCI32_fine       (≈ 1 in the asymptotic range)
required spacing h* = h1 / (GCI21_fine / GCI*)^(1/p)        [R8: corrected form of the NPARC tutorial]
```

A zero f1 (relative error undefined) switches to absolute GCI (`gciAbs` in the quantity unit) with `VNV_RELATIVE_UNDEFINED`.

### 5.2 Named defaults (AF-31)

| Default | Value | Source | When |
| ------- | ----- | ------ | ---- |
| `safetyFactor` (≥ 3 levels) | 1.25 | Roache 1994 [R1] as used in Celik et al. 2008 [R2] and gcat [R9] | always named, `defaulted: true` unless given |
| `safetyFactor` (2 levels) | 3 | Roache's general recommendation as reported in [R10] (search extract) | `VNV_TWO_LEVEL_ONLY` always raised |
| `orderTolerance` | 0.5 | llull choice (no source); reported as `defaulted` | with `formalOrder` |
| asymptotic band | [0.95, 1.05] | llull choice | `VNV_NOT_ASYMPTOTIC` |
| minimum ratio | 1.3 (warn below; refuse below 1.1) | Celik 2008 recommends r > 1.3 (secondary literature; to confirm, §11) | `VNV_RATIO_TOO_SMALL` |
| `ratio` of `run_convergence_study` | 2 | llull choice (NPARC example uses grid doubling [R7]) | — |
| `gciTarget` | **none** | — | unset ⇒ `VNV_GCI_TARGET_UNSET` warning; the owner or company rule decides |

### 5.3 Judge (FR-VNV-10)

```
grade = normalise(expected.grade)                                  ('A (given the table)' -> 'A'; unknown -> VNV_EXPECTED_INVALID)
if grade in {C, TBD} or value == 'TBD' or tolerance has only null bounds  -> skip (VNV_EXPECTED_TBD)
if value is null: judge `expected` (contract) with exact deep equality on the listed fields; no `expected` -> VNV_EXPECTED_INVALID
if measured missing                                                -> error (VNV_RESULT_MISSING)
if unit is physical: convert measured to expected.unit (lib/quantity); dimension mismatch -> error (VNV_UNIT_MISMATCH)
compare(value, measured) recursively:
   number leaf  : exact ? m == v : (|m − v| <= abs) or (|m − v| <= rel · |v|)    (abs: 0 means exact; either bound passes)
   string/bool  : equality (codes, labels, ids)
   list         : same length, element-wise (order significant)
   record       : same key set, key-wise
grade A: ok ? pass : fail (VNV_BENCHMARK_FAILED)
grade B: ok ? pass : warn (VNV_BENCHMARK_UNCONFIRMED)
```

The leaf-wise rule applies one tolerance to every numeric leaf of a list or record (e.g. 07 FAT rainflow tables,
10 RBD state vectors, 14 ENV curves).

Fixtures RF-01…RF-08 in `validation/runner_fixtures.json` pin every branch.

### 5.4 Formal orders by 05 element type (for `formalOrder` defaults)

A-priori rates for smooth solutions in the asymptotic range (standard finite-element theory; the table is held as
data with its source string `"a priori FE error estimates (textbook)"` and is reviewer-confirmable, open question 3):

| 05 element | Displacement (L2) | Stress / strain (energy) |
| ---------- | ----------------- | ------------------------ |
| C3D4, CPS3, S3 (linear) | 2 | 1 |
| C3D10, CPS6, S6 (quadratic) | 3 | 2 |

Point values (probes) and maxima can converge more slowly or not at all near singularities; that is what the
classification and `VNV_ORDER_MISMATCH` catch. Frequencies of a conforming discretisation converge at twice the
energy rate (textbook), recorded likewise as a reviewer-confirmable default.

### 5.5 Convergence study transport (FR-VNV-07, TR-VNV-09)

```
levels k = 0..L-1, finest first: size_k = finest × ratio^k        (cap: element count ≤ 2e6, else VNV_LEVEL_TOO_LARGE)
for k from coarsest to finest:                                     (coarse first: fail fast, cheap)
    controls_k = { ...case.mesh, globalSize: size_k, refinements scaled by ratio^k }
    mesh_k   = 05 mesh op (llull-mesh: Netgen, 1 thread) -> FeArtifactStore (cache by content hash)
    result_k = 05 solve (CalculiX)                    -> FeArtifactStore
    value_k  = extract(quantity, result_k)            (probe interpolation identical to 05 analysis_report)
    h_k      = (measure / elements_k)^(1/dimension)   measure = analysed volume (3D) or area (2D) from 05 MeshSummary
dispatch record_convergence_study { levels }          (record recomputes the report; TR-VNV-09)
```

Progress lines per level (AF-40); cancel and timeout kill the child process (05 §5.9). A failed level aborts with
`VNV_LEVEL_FAILED` and the 05 code.

### 5.6 Benchmark runner (FR-VNV-11)

1. Discover `docs/physics/*/validation/expected_results.json` and the aerospace files listed in
   `quality/physics-benchmarks.json` (initially 05 FEA `fea_analytic_expected.json` through the adapter, §6.1).
2. For each case with a `harness`: run `llull run <plan> --doc <tmp> --kernel <k> --json`, then the listed calls,
   read the JSON pointer, judge (§5.3). Without a harness: report `skip` with `VNV_NO_HARNESS` unless the owning
   pack's unit test reported the case id (a Vitest reporter writes `{caseId, measured}` lines to
   `.cache/quality-physics/unit-measurements.jsonl`).
3. Report rows sorted by pack then case id; Markdown summary like `quality/drawings`. Exit 1 on any A-grade `fail`
   or `error`.

### 5.7 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Order iteration stop | \|Δp\| < 1e-14 (max 10 000 iterations) |
| GCI arithmetic vs generator | 1e-9 relative (VC-VNV-01…03) |
| Cross-check vs gcat published numbers | 1e-5 relative (gcat stops at \|Δp\| < 1e-5) |
| MMS observed order | ±0.01 of formal |
| Benchmarks | per case, from `expected_results.json` |

## 6. Interop & persistence

| Item | Format | Notes |
| ---- | ------ | ----- |
| Expected results | `expected_results.json` (README §6.3) | zod-validated; `harness` optional |
| 05 FEA legacy file | `fea_analytic_expected.json` | adapter §6.1 |
| Benchmark report | JSON (`BenchmarkRow[]` + toolchain) and Markdown | `.cache/quality-physics/reports/`, never committed |
| Study | `analysis.cases[a].studies` in the `.llull` document | level artifacts in the 05 artifact store (not in the document) |

### 6.1 Adapter for the 05 file

`tolerance_rel` → `tolerance.rel`, `tolerance_abs` → `tolerance.abs`, `sources[]` → `source` (joined), grade
inferred: `A` when derived by the generator (`derivation` present), else `B`; `proves` from the README VC table
(hand-maintained map in `quality/physics-benchmarks.json`). Proposal to 05: emit the §6.3 fields natively when its
generator is next touched (no rewrite here, specs only).

### 6.2 Compatibility with the packs written so far (survey 2026-10-15)

All `docs/physics/*/validation/expected_results.json` files present on 2026-10-15 (01–20 except 16) were read. They
share the required keys `id, quantity, value, unit, tolerance, source, grade, proves`. Variations the zod schema and
judge must accept (and do, per §3 and §5.3):

| Variation | Packs (examples) | Handling |
| --------- | ---------------- | -------- |
| `value` is a list or record of numbers | 01, 02, 04, 07, 08, 09, 10, 12, 13, 14, 20 | leaf-wise tolerance |
| `value` is a code / label string, list of ids, boolean | 01, 02, 06, 12, 13, 14 | exact equality |
| `value: null` + `expected` contract object/list | 03, 04, 15 | contract judging |
| `value` is a record `{exit, code}` | 09, 10, 20 | exact equality (exit code + `data.code`) |
| `tolerance: { rel: null }` or `{ abs: 0 }` on TBD/C cases | 05, 09, 20 | skip (TBD/C) / exact |
| `tolerance: { abs: 0 }` on A cases | 07, 09, 10, 20 | exact |
| grade `"A (given the table)"` | 02 | normalised to A, suffix shown in the report |
| extra top-level keys (`constants`, `units`, `units_note`, `workedExample`, `toleranceMm`, …) | 01, 02, 05, 12, 13, 14, 15 | ignored by the runner |
| extra per-case keys (`inputs`, `derivation`, `crossCheck`, `cross_check`, `note`, …) | all | kept in the report, not judged |

No pack needs a schema change. Proposal (not a requirement): new packs prefer `{ exit, code }` records or
`expected` contracts over bare code strings, so the runner can also assert the exit code.

### 6.3 Harness recipe example

```json
{ "id": "VC-FEA-10.a", "harness": { "plan": "plans/fea_cantilever_static_beamp.plan.json",
  "calls": ["fea_mesh analysisId=$an", "fea_solve analysisId=$an", "analysis_report analysisId=$an"],
  "pointer": "/data/probes/tip/value", "kernel": "occt" } }
```

`$an` resolves from the AF-14 `aliases` map of the plan report.

## 7. CLI / MCP / UI surfaces

- **CLI.** Registry commands run as `llull <command>`; ✱ transports run like the exchange tools (in-process for `--doc`,
  REST for `--app`). `llull guide` gains a V&V section: what GCI means, the minimal study, end every analysis job with
  `check_verification` (AF-03).
- **MCP.** Toolset `analysis` gains `check_convergence`, `compare_to_expected`, `check_verification`,
  `record_convergence_study`, `delete_convergence_study`, `accept_verification_exception`, and the
  `run_convergence_study` transport where configured. `run_benchmarks` is host-only.
- **UI.** `src/ui/panels/analysis/VerificationPanel.tsx` (levels table, plot, codes), benchmark report viewer,
  exception dialog (human gate). Review only.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `VNV_SAMPLES_INVALID` | error | < 2 samples, duplicate or non-positive h, non-finite value, 2 samples without `assumedOrder` | `samples[i]` | supply ≥ 3 distinct positive spacings with finite values |
| `VNV_RATIO_TOO_SMALL` | warning (error below 1.1) | consecutive ratio < 1.3 | sample indices | refine by a larger ratio (≥ 1.3) |
| `VNV_OSCILLATORY` | warning | e32/e21 < 0 | triplet | refine further or study a smoother quantity; no extrapolation reported |
| `VNV_DIVERGENT` | warning | \|e32/e21\| < 1 | triplet | check singularities (05 `FEA_POINT_LOAD_SINGULAR`) or mesh quality |
| `VNV_ORDER_MISMATCH` | warning | \|p − formal\| > orderTolerance | study id | levels likely not asymptotic: add a finer level |
| `VNV_NOT_ASYMPTOTIC` | warning | AR ∉ [0.95, 1.05] | study id | add a finer level |
| `VNV_ORDER_NOT_CONVERGED` | error | order iteration did not converge | triplet | use a constant ratio |
| `VNV_TWO_LEVEL_ONLY` | warning | two samples (Fs = 3) | study id | add a third level |
| `VNV_RELATIVE_UNDEFINED` | warning | f1 = 0 | study id | absolute GCI reported |
| `VNV_GCI_ABOVE_TARGET` | fail | GCI21 > `gciTarget` | study id | refine (see `requiredSpacing`) |
| `VNV_GCI_TARGET_UNSET` | warning | no `gciTarget` | analysis id | ask the owner / company rule for a target |
| `VNV_NO_CONVERGENCE_STUDY` | warning | a governing quantity has no study | analysis id, quantity | `run_convergence_study` |
| `VNV_STUDY_STALE` | error | a level `inputHash` ≠ current minus mesh controls | study id | re-run the study |
| `VNV_INPUT_UNVERIFIED` | warning (not suppressible) | a level result carries `unverified` | study id, reasons | fix the 08 material provenance |
| `VNV_LEVEL_FAILED` | error | a level failed to mesh or solve | level index, 05 code | read the 05 code; coarsen or fix the set-up |
| `VNV_LEVEL_TOO_LARGE` | error | a level exceeds the element cap | level index | fewer levels or a coarser finest size |
| `VNV_TOOL_MISSING` | error | `llull-mesh` (Netgen) or CalculiX absent | tool | install hint (05 `FEA_TOOL_MISSING`) |
| `VNV_ARTIFACT_NOT_FOUND` | error | record: a level hash not in the store | hash | run the transport; never hand-write studies |
| `VNV_SUMMARY_MISMATCH` | error | record: value ≠ re-extracted value | level index | same |
| `VNV_EXPECTED_INVALID` | error | case does not match the schema | path | fix the pack file |
| `VNV_EXPECTED_TBD` | info | expected value TBD / grade C | case id | — |
| `VNV_NO_HARNESS` | info | case has no harness and no unit measurement | case id | add a harness recipe |
| `VNV_RESULT_MISSING` | error | measured value absent | case id | check the harness pointer |
| `VNV_UNIT_MISMATCH` | error | unit dimension differs | case id | fix the extraction unit |
| `VNV_BENCHMARK_FAILED` | fail | A-grade case outside tolerance | case id | regression: bisect toolchain or code change |
| `VNV_BENCHMARK_UNCONFIRMED` | warning | B-grade case outside tolerance | case id | confirm the source value |
| `VNV_HUMAN_GATE` | error | exception accepted by an agent or without signature | study id | hand over to the qualified reviewer |

### 7.2 Agent-first compliance

| AF | Where satisfied |
| -- | --------------- |
| AF-01/02/03/04/05 | registry commands, descriptions with units, `llull guide` V&V section, `unit` param, plans in `validation/plans/` |
| AF-10/12/13 | unit-bearing `data`; reports via `--save`; TR-VNV-10 determinism |
| AF-11 | §7.1 |
| AF-14 | harness uses plan `aliases` |
| AF-20 | `check_verification` |
| AF-21/22 | numbers first; plot and `render_view` optional |
| AF-23 | `run_benchmarks`, `quality:physics`, production scenario |
| AF-30/31 | §5.2 named defaults with sources |
| AF-32/33/34 | `unverified` propagation, `reviewRequired`, `accept_verification_exception` |
| AF-35/36 | `provenance`, plain-language summary |
| AF-40/41/42 | progress/timeout/cache; `VNV_TOOL_MISSING`; `--dry-run` on record |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| `check_convergence` | < 1 ms for ≤ 12 samples |
| `run_benchmarks` (MVP corpus, desktop, cached artifacts) | ≤ 10 min; uncached TBD — measure |
| Convergence study, 3 levels, 05 bracket finest 20k nodes | ≤ 3 × 05 single-run budget (coarser levels are cheaper) |
| Report size | ≤ 1 MB JSON per run |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit core (`tests/unit/lib/convergence.test.ts`) | arithmetic vs generator values, classification, iteration, required spacing, representative spacing | 01–09 |
| Unit plugin (`tests/unit/physics/vnv/*.test.ts`) | every command happy + failure + `is pure`; judge fixtures; record validation with a fake artifact port; human gate; unverified propagation | 12, 14, 15, 16 |
| Contract | `toToolSchemas()` snapshot gains the commands; toolset membership | — |
| Golden | `validation/plans/*.plan.json` once commands exist | 01, 13 |
| Integration (`server/tests`, needs llull-mesh + ccx) | `run_convergence_study` on beamp and LE10; staleness | 10, 11, 13 |
| Quality gate | `npm run quality:physics` over every pack | 07, all packs |
| Production gate | agent scenario `physics-benchmarks` (V1) | 17 |

Coverage 90/85/90/90 extends to `packages/domain-physics/src/**`.

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `lib/convergence.ts`, `check_convergence`, `compare_to_expected`, expected-results schema + adapter, unit tests (VC 01–09, 12) | none (pure) | 1 w |
| M2 | `run_benchmarks` host transport, `quality:physics`, Vitest measurement reporter, Markdown report | M1, AF-14 | 1.5 w |
| M3 | `run_convergence_study`, `record_convergence_study`, `check_verification`, staleness, human gate (VC 10, 11, 13–16) | 05 FEA M3, 09 PLM signing port | 2 w |
| M4 (V1) | time-step and order refinement, least squares, production scenario, UI panel | PHY-03 / PHY-09 transports | 2 w |

## 11. Open questions / decisions needed

1. **Package** (README §5.1): `packages/domain-physics` with discipline `vnv`, or put the pure judge and GCI in core
   only and the transport in `server/`? This spec proposes the plugin plus a core `lib`.
2. **Originals not read**: Roache 1994, Celik et al. 2008, ASME V&V 10/20 and the NPARC page were not reachable from
   this session. Formulas were verified through two open implementations that agree with each other and with the
   generator. A human with access should confirm Fs = 3 for two grids, the r > 1.3 recommendation and the V&V 20
   validation-uncertainty formula before the defaults are frozen.
3. **Formal-order table** (§5.4) is textbook knowledge with no fetched citation here; a reviewer should confirm or
   replace it with a cited reference.
4. **GCI target**: should llull ship a company-configurable default, or always require the owner to set one (current
   proposal: no default, warning)?
5. Should B-grade benchmark warnings block a release for the packs that are B-only (e.g. PHY-17)?
6. Should `run_benchmarks` also run the aerospace packs' `expected_results.json` files that do not yet follow §6.3
   (03 GDT, 08 MAT), through adapters, or only after they migrate?

## 12. References

- [R1] Roache 1994, JFE 116(3) 405–413 — see FUNCTIONAL_SPEC [R1] (record via search)
- [R2] Celik et al. 2008, JFE 130(7) 078001 — https://doi.org/10.1115/1.2960953 (formulas via [R9])
- [R3] ASME V&V 10-2019 (R2025) — https://www.asme.org/codes-standards/find-codes-standards/standard-for-verification-and-validation-in-computational-solid-mechanics (catalogue, search)
- [R4] ASME V&V 20-2009 (R2016) — https://webstore.ansi.org/standards/asme/asme202009 (catalogue, search)
- [R5] Salari & Knupp, SAND2000-1444 — https://www.osti.gov/biblio/759450 (record, search)
- [R7] NPARC "Examining Spatial (Grid) Convergence" — https://www.grc.nasa.gov/WWW/wind/valid/tutorial/spatconv.html (blocked; via [R8])
- [R8] `convergence` 0.6.7, GPL-3.0 — https://pypi.org/project/convergence/0.6.7/ (sdist read; values quoted, no code copied)
- [R9] `gcat`, MIT — https://github.com/gabrielbdsantos/gcat (commit 0b4f6fd839762bca6ad756b89c900296738f2b4e, read)
- [R10] arXiv 2103.14559 — https://arxiv.org/abs/2103.14559 (search extract)
- llull: `.claude/rules/architecture.md`, `.claude/context/command-layer.md`, `docs/QUALITY_GATES.md`, `docs/PRODUCTION_GATE.md`, `packages/core/src/commands/project/types.ts`, 05 FEA TECHNICAL_SPEC.

## 13. Implementation status (2026-10-16)

**Built: M1 + M2.** `npm run quality:physics` judges 26 VC-VNV cases (VC-VNV-01…09, 12, 18, measured by `tests/unit/physics/`):
all pass; VC-VNV-19 (two-level study) and VC-VNV-20 (gate exit code) are unit / server tests. The 7 skipped cases are TBD (10, 11) or
wait for M3 (13–17).

| Item | Where |
| ---- | ----- |
| GCI arithmetic (TR-VNV-01…05) | `packages/core/src/lib/convergence.ts` |
| Unit grammar used by the judge | `packages/core/src/lib/quantity.ts` (minimal version of 08 TR-MAT-01; 08 MAT owns it once built) |
| `check_convergence`, `compare_to_expected`, schema + 05 adapter, judge | `packages/core/src/commands/vnv/` (toolset `analysis`) |
| `run_benchmarks` host transport (FR-VNV-11) | `server/src/cli/benchmarks.ts`, `llull run_benchmarks` |
| `npm run quality:physics` (FR-VNV-12, TR-VNV-13) | `quality/physicsBenchmarks.mjs`, `quality/physics-benchmarks.json` (05 FEA legacy file via the §6.1 adapter) |

**Deviations from this spec (recorded, not silent):**

- **Placement.** README §5.1 / §8.3 is undecided and `packages/domain-physics` does not exist, so the two pure commands live in a core
  feature catalog (`commands/vnv/`) — the answer to open question 1 "pure judge and GCI in core, transport in `server/`". Moving them to
  a plugin later is a file move plus registration.
- **Unit measurements.** Instead of a Vitest reporter, the packs' unit tests judge through `tests/unit/physics/benchmarkCases.ts`, which
  appends `{ pack, caseId, measured }` lines when `LLULL_PHYSICS_MEASUREMENTS` is set; `quality:physics` sets it.
- **Refusals** carry the code in the registry's `error { code, ids, paths, remediation }` (exit 1 on the CLI), not in `data.code`.
  `compare_to_expected` verdict errors (`VNV_UNIT_MISMATCH`, `VNV_RESULT_MISSING`) are valid results (exit 0) with `data.code`,
  `data.path`, `data.remediation`. `check_convergence` reports `data.codes[]` plus `data.findings[]` (severity, message, remediation).
- **Harness recipes** run in-process without a kernel; a `$alias` in a call needs AF-14 `aliases`, not built yet, and reports
  `VNV_HARNESS_UNSUPPORTED`. No pack ships a harness recipe yet. The report's toolchain holds the Node version only.
- **A non-finite sample** can only reach the command from TypeScript (JSON has no NaN): NaN gives `VNV_SAMPLES_INVALID`, ±∞ the
  schema-level `CMD_INVALID_PARAMS`.

**Not built (blocked on dependencies that do not exist yet):** M3 — `run_convergence_study`, `record_convergence_study`,
`delete_convergence_study`, `check_verification`, `accept_verification_exception` need the 05 FEA analysis slice, `FeArtifactStore`
and solver transports, and the 09 PLM signing port. VC-VNV-10, 11, 13–17 stay open with them. M4 (V1) not started, including
FR-VNV-19 / VC-VNV-22 (least-squares order).

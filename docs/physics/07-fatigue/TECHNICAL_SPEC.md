# PHY-07: Fatigue (crack initiation) — technical specification

Gap id **FAT** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

`[Rn]` ≡ register id `Sn`. Placement follows the physics README §6.2 and is a **proposal** pending README §5.1.

## 1. Current state in llull

| Area | What exists | Path | Limit for fatigue |
| ---- | ----------- | ---- | ----------------- |
| Material | `Material { name, density, color, metalness, roughness, finish? }` | `packages/core/src/model/types.ts` (line 639) | No fatigue data. 08 MAT adds `MaterialRecord` / `PropertyValue` (scalars + temperature tables); PHY-02 adds `materialModels` (`model/materialModel.ts`) |
| Existing fatigue code | EN 1993-1-9 crane-runway fatigue: `ΔσE2 = λ φfat Δσ` vs detail category / γMf; constants `FATIGUE_PHI = 1.05`, `FATIGUE_CATEGORY = 71` | `packages/domain-aec/src/industrial/runway/runwayBeamCheck.ts`, `runwayCheckModel.ts`, `runwayCheckRun.ts` | Steel-building nominal-stress check with fixed categories; no S-N model, no counting, no FE input. Not reused (different domain and data) |
| FE results | (aerospace 05, not yet built) analysis cases, FRD import, results summary + content-addressed artifacts, `ctx.feaArtifacts` read-only port, margins, staleness hashes | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3, §4.1, §5.8 | Static field only; V2 "fatigue hooks (stress spectra export)" replaced by this pack |
| Motion | Kinematic joints and `motion_study` (no forces) | `packages/core/src/commands/motion/` | No load histories (PHY-10 later) |
| Plan reports | `StepReport { index, path?, command, ok, summary, affected }` | `packages/core/src/commands/project/types.ts` | AF-14 adds `error?`, `data?`, `aliases` (shared prerequisite) |
| MCP toolsets | `TOOLSET_NAMES = core, 2d, 3d, measure, parametric, assembly, exchange, building, civil` | `packages/mcp/src/toolsets.ts` | Needs `durability` (this pack + PHY-08) after 05 adds `analysis` |
| Solver | CalculiX (bundled by 05) has no S-N / ε-N fatigue procedure; `*HCF` exists only inside `*CRACK PROPAGATION` (PHY-08) | CalculiX manual §"Crack propagation" [R19] | Fatigue is post-processing in TypeScript |

A `grep -ril "rainflow\|miner\|basquin\|coffin" packages/` hits only `building/elements/wallLayers.ts` ("mineral wool"); the only `fatigue` hits are the runway files above.

## 2. Target architecture

> **Placement erratum (coordinator, 2026-10-15).** `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids `packages/domain-physics` importing `@cae` (or any other package). Wherever this spec says `@phys` imports or extends `@cae`, read: the plugin registers its analysis type, deck fragments and result readers through the **core analysis extension port** proposed in [`../03-thermal-analysis/TECHNICAL_SPEC.md`](../03-thermal-analysis/TECHNICAL_SPEC.md) §2; fallback: the discipline lives inside the 05 FEA package. Decision pending in [`../README.md`](../README.md) §5.


```
src/ui (fatigue table, hot-spot glyphs, disposition dialog)        server/ (transport: export_stress_spectrum file write)
        │ dispatch                                                         │
src/app installDefaultPlugins() + fatiguePlugin (after caePlugin)
        ▼
packages/domain-physics/src/fatigue   (@phys/fatigue) — CadPlugin "fatigue", toolset "durability"
   commands/  define_load_history, update_load_history, delete_load_history, create_fatigue_case, update_fatigue_case,
              delete_fatigue_case, set_fatigue_factors, count_cycles, fatigue_life, compute_fatigue, check_fatigue,
              dispose_fatigue_result (human gate)
   counting/  rainflow.ts (3-point, 4-point, repeating), reversals.ts, binning.ts
   life/      stressLife.ts, strainLife.ts (Newton), meanStress.ts, notch.ts (Kf, Neuber, Masing), miner.ts
   fe/        hotspots.ts (reads 05 artifacts via ctx.feaArtifacts), superposition.ts, stressMeasure.ts
        ▼ public core API + @cae public API (05 AnalysisModel types, FeaMaterialView)
packages/core/src
   model/materialModel.ts   (PHY-02) MaterialModel union — fatigue variants listed in §3.1, owned by PHY-02
   model/durability.ts      (new, data types only, like model/building.ts) DurabilityModel shared by PHY-07 + PHY-08
   model/types.ts           CadDocument.durability?: DurabilityModel
```

**Laws respected.** L1: every change is a command; `compute_fatigue` is a query. L2: `@phys` imports core public API
and `@cae` public API only; file writes live in `server/`. L3: pure commands, `is pure` tests. L4: `durability` slice is the
only fatigue state; FE fields stay in the 05 artifact store. L5: zod schemas, toolset view `durability`. L6: the server
only writes the spectrum file. L8: commands record `FeatureStep`s; ids `lh-<step>.<k>` (history), `fc-<step>.<k>` (case);
results are recomputed, never stored, except dispositions. L9: no kernel need (hot spots come from FE nodes). L10:
domain capability lives in the plugin; core gets data types only.

**Technical requirements**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-FAT-01 | MUST | Workspace `packages/domain-physics` (alias `@phys/*` in `tsconfig.base.json`), plugin `fatigue` with `toolset: 'durability'`, `document.validate/restore/derivedEntityIds` for the `durability` slice. `TOOLSET_NAMES` gains `'durability'`. |
| TR-FAT-02 | MUST | `CadDocument.durability?: DurabilityModel` absent until the first durability command; types in `model/durability.ts`; rides the aerospace v3 envelope as an optional field (no migration). |
| TR-FAT-03 | MUST | **No fatigue material storage in this pack.** Curves are PHY-02 `MaterialModel` variants (§3.1) on the 08 record; `@phys/fatigue/curves.ts` builds a read-only `FatigueCurveView` (converted to the case unit system, with basis, provenance, `unverified`). PHY-02 must include the variants of §3.1. |
| TR-FAT-10 | MUST | Stress-life: Basquin `σa = σ'f (2N)^b`, power law `N = N_D (S/S_D)^-k` (+ k2 beyond the knee or endurance cut-off), table with log-log interpolation in N and linear interpolation between R tables; no extrapolation without flag (§5.2). |
| TR-FAT-11 | MUST | Strain-life: Newton on x = log10(2N) for CMB, Morrow and SWT forms; start x0 = 3; stop at \|Δx\| < 1e-14 or 200 iterations → `FAT_SOLVER_NO_CONVERGENCE`; the residual is re-checked to 1e-12 relative (§5.3). |
| TR-FAT-12 | MUST | Notch: Kf = 1 + q(Kt − 1); q Peterson / Neuber / explicit; Neuber σ·ε = (Kf·S)²/E on cyclic RO by bracketed bisection + Newton; Masing branches Δε = Δσ/E + 2(Δσ/2K')^(1/n'); hysteresis memory per rainflow cycle (§5.4). |
| TR-FAT-13 | MUST | Mean stress: Goodman, Gerber, Soderberg, Morrow (stress form), SWT, Walker(γ); compressive-mean rule `no_benefit` (named default) or `formula` (§5.5). |
| TR-FAT-14 | MUST | Miner damage with explicit `damageLimit` (default 1, `defaulted: true`, source "Palmgren-Miner rule"); endurance cut-off only if the curve declares one. |
| TR-FAT-15 | MUST | FE coupling: local history σ(t) = Σ_k s_k(t)·σ_k(node) over mapped 05 load cases (linear superposition); stress measure `signed_von_mises` \| `max_principal` \| `component`; proportionality check (principal direction rotation > 15° over the history → `FAT_NONPROPORTIONAL` warning); singular zones from 05 excluded and listed. |
| TR-FAT-16 | MUST | Margin `N_pred / (SF × N_required) − 1`; status FAIL < 0 ≤ MARGINAL < `marginalBand` (no default band; unset → warning `FAT_MARGINAL_BAND_UNSET`) ≤ PASS. |
| TR-FAT-20 | MUST | Rainflow three-point and repeating-history per ASTM E1049 §5.4.4 / §5.4.5 [R1]; output identical to [R2] / [R3] on their published cases (VC-FAT-01, 03, 04). |
| TR-FAT-21 | MUST | Four-point rainflow; full cycles + residue; residue as half cycles reproduces the three-point totals (VC-FAT-02). |
| TR-FAT-30 | MUST | Agent-first result contract (AF-10/11/31–36): factors named with `source`/`defaulted`; `unverified` = OR over curve, profile, 05 inputs; `reviewRequired: true` on every row; dispositions only through `dispose_fatigue_result` + 09 signature port. |
| TR-FAT-31 | MUST | Staleness: `fatigueInputHash = sha256(canonical{05 resultsHash, case, histories, curve model ids + values hash, factors})`; dispositions bind to it; any change → `stale`. |
| TR-FAT-40 | SHOULD | `export_stress_spectrum` transport: CSV / JSON writer pure in `@phys`, file write in `server/` (AF-12). |

## 3. Data model

### 3.1 Material-model variants PHY-02 must include (core `model/materialModel.ts`, owned by PHY-02)

```ts
// Proposed members of PHY-02's `MaterialModel` union. Each sits in MaterialRecord.materialModels[] with the 08
// Provenance / Basis / licence semantics (private libraries never serialised). Names are the contract with PHY-02.
interface FatigueTestConditions {
  readonly stressRatio?: number;                 // R of the coupon tests (−1, 0.1 …); absent if mean-stress family
  readonly specimenKt?: number;                  // 1 = smooth
  readonly surface?: string; readonly environment?: string;
  readonly temperature?: Quantity;               // 08 unit grammar
  readonly testedLifeRange?: { readonly minCycles: number; readonly maxCycles: number };
  readonly probability: 'mean' | 'P90' | 'P95' | 'P99' | 'design' | 'unspecified';
  readonly control: 'load' | 'strain';
}
type FatigueMaterialModel =
  | { kind: 'sn_basquin'; sigmaF: Quantity; b: number; enduranceAmplitude?: Quantity; conditions: FatigueTestConditions }
  | { kind: 'sn_power_law'; k: number; nD: number; sD: Quantity; k2?: number | 'cutoff'; conditions: FatigueTestConditions }
  | { kind: 'sn_table'; families: ReadonlyArray<{ stressRatio?: number; meanStress?: Quantity;
        points: ReadonlyArray<readonly [cycles: number, amplitude: number]>; amplitudeUnit: string; runoutCycles?: number }>;
      measure: 'amplitude' | 'max'; conditions: FatigueTestConditions }
  | { kind: 'sn_equivalent_stress'; a1: number; a2: number; a3: number; a4: number; unit: string;   // MMPDS-style fit (form to verify, OQ-FAT-05)
      conditions: FatigueTestConditions }
  | { kind: 'en_coffin_manson'; sigmaF: Quantity; b: number; epsF: number; c: number; E: Quantity; conditions: FatigueTestConditions }
  | { kind: 'cyclic_ramberg_osgood'; Kprime: Quantity; nPrime: number; E: Quantity }   // may alias PHY-02 ramberg_osgood with `cyclic: true`
  | { kind: 'haigh_table'; lifeCycles: number; points: ReadonlyArray<readonly [mean: number, amplitude: number]>; unit: string };
```

### 3.2 Durability slice (core `model/durability.ts`, data types only; PHY-08 adds members)

```ts
export interface LoadHistory {
  readonly id: string; name: string;
  kind: 'stress' | 'load_factor' | 'strain';            // load_factor scales a 05 load case (dimensionless)
  unit: string;                                          // 'MPa' | 'ksi' | '-' (load factor) | 'm/m'
  data:
    | { form: 'series'; values: readonly number[] }      // reversals or samples; peak-valley extracted on use
    | { form: 'blocks'; rows: readonly { max: number; min: number; cycles: number }[] }
    | { form: 'matrix'; binWidth: number; from: readonly number[]; to: readonly number[]; counts: readonly number[][] };
  repeats: 'once' | 'repeating';                         // E1049 5.4.5 applies to 'repeating'
  source: { citation: string; fileSha256?: string };     // user spectrum provenance (TWIST/FALSTAFF never shipped)
}
export interface FatigueFactors {
  scatter?: { value: number; source: string };           // no default (FR-FAT-09)
  profile?: 'none' | 'nasa_std_5019';                    // profile values carry sourceStatus
  damageLimit: number;                                   // default 1, named
  marginalBand?: number;
  modifiers: { name: 'surface' | 'size' | 'reliability' | 'environment' | 'other'; value: number; justification: string }[];
  compressiveMean: 'no_benefit' | 'formula';             // default 'no_benefit', named
}
export interface FatigueCase {
  readonly id: string; name: string;
  method: 'stress_life' | 'strain_life';
  analysisId?: string;                                   // 05 case; absent = history-only (stress given directly)
  mapping: { loadCase?: string; historyId: string; scale: number }[];
  measure: 'signed_von_mises' | 'max_principal' | { component: 'sxx' | 'syy' | 'szz' | 'sxy' | 'syz' | 'szx' };
  locations: { mode: 'hotspots'; count: number } | { mode: 'targets'; targets: FeaTargetRef[] };
  material: { recordId: string; modelId: string; cyclicModelId?: string };
  meanStress: 'none' | 'goodman' | 'gerber' | 'soderberg' | 'morrow' | 'swt' | { walker: number };
  notch?: { kt: number; q: number | { model: 'peterson'; a: Quantity; r: Quantity; source: string }
                              | { model: 'neuber'; rhoPrime: Quantity; r: Quantity; source: string }; feIncludesKt: boolean };
  counting: { method: 'rainflow_3pt' | 'rainflow_4pt' | 'rainflow_repeating'; residue: 'half_cycles' | 'repeat'; gate?: number };
  requiredLife: { value: number; unit: 'cycles' | 'blocks' | 'flights' | 'hours'; blocksPerUnit?: number };
  factors: FatigueFactors;
  dispositions: Record<string, { rowKey: string; inputHash: string; decision: 'accepted' | 'rejected' | 'redesign';
                                 justification: string; signatureId: string }>;
}
export interface DurabilityModel {
  histories: Record<string, LoadHistory>; historyOrder: string[];
  fatigueCases: Record<string, FatigueCase>; fatigueCaseOrder: string[];
  // PHY-08 adds: cracks, crackGrowthCases, inspections
}
```

`FeaTargetRef` is the 05 `FeaTarget` (point-based, re-resolved on replay). Licensed curve values never enter the
slice: the case references `recordId` + `modelId` only.

## 4. Commands

Plugin `fatigue`, toolset `durability`. All pure `defineCommand`, snake_case. ✱ = transport (not a registry command).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `define_load_history` | mutating | `{ name, kind, unit, data, repeats?='once', source }` | @affects durability.histories · @invariant unit dimension matches kind · @failure < 2 values / NaN / unit mismatch → `FAT_HISTORY_INVALID` |
| `update_load_history` / `delete_load_history` | mutating | `{ historyId, …}` / `{ historyId }` | @failure history used by a case (delete) → `FAT_HISTORY_IN_USE` |
| `create_fatigue_case` | mutating | `{ name, method, analysisId?, mapping, measure?='signed_von_mises', locations?, material, meanStress, notch?, counting?, requiredLife, factors? }` | @affects durability.fatigueCases · @invariant referenced 05 load cases and histories exist · @failure missing model → `FAT_CURVE_MISSING`; R ≠ −1 curve with `meanStress: none` and non-zero means → `FAT_MEAN_MODEL_REQUIRED` |
| `update_fatigue_case` / `delete_fatigue_case` | mutating | `{ caseId, … }` | dispositions cleared on any input change (hash mismatch) |
| `set_fatigue_factors` | mutating | `{ caseId, scatter?: {value, source}, profile?, damageLimit?, marginalBand?, modifiers?, compressiveMean? }` | @invariant scatter ≥ 1; modifier needs justification · @failure → `FAT_FACTOR_INVALID` |
| `count_cycles` | query | `{ history: number[] \| historyId, method?='rainflow_3pt', residue?='half_cycles', binSize?, gate? }` → `data { reversals[], cycles[{from,to,range,mean,count}], totals[[range,count]], residue[] }` | read-only; units echo the history |
| `fatigue_life` | query | `{ method, material \| inline model, amplitude?/mean? \| strainAmplitude? \| nominal + notch, meanStress?, units }` → `data { reversals, cycles, localStressMaxMPa?, localStrainMax?, equivalentAmplitudeMPa?, transitionReversals?, extrapolated, provenance, unverified, reviewRequired }` | quick check, no FE |
| `compute_fatigue` | query | `{ caseId, hotspots?, loadCaseFilter? }` → `data` §5.7 | @invariant every factor named; every row `reviewRequired` · @failure `FAT_RESULTS_STALE`, `FAT_RESULTS_MISSING`, `FAT_SCATTER_FACTOR_UNSET`, `FAT_CURVE_UNAVAILABLE` |
| `check_fatigue` | query | `{ caseId }` → `{ status, items[{code, severity, ids, message, remediation}], reviewRequired: true }` | readiness check (AF-20) |
| `dispose_fatigue_result` | mutating, **human gate** | `{ caseId, rowKey, decision, justification, signature }` | @affects case.dispositions · @invariant signature verified by the 09 `ctx.signatures` port, bound to `fatigueInputHash` · @failure agent caller / no valid human signature → `FAT_HUMAN_GATE`, doc unchanged |
| ✱ `export_stress_spectrum` | transport | `{ caseId, hotspot, format: 'csv' \| 'json', content: 'history' \| 'rainflow_matrix', path }` | refuses stale results; writes only with `--save` |

## 5. Algorithms

### 5.1 Reversals and rainflow (TR-FAT-20/21)

- Peak-valley extraction keeps the first and last point, collapses plateaus, and applies an optional hysteresis gate
  (drop reversal pairs with range < gate, as a pre-filter; default none).
- **Three-point (E1049 §5.4.4)**: push reversal; while ≥ 3 points: X = |p₃ − p₂|, Y = |p₂ − p₁|; if X < Y read next; if
  Y contains the start point count Y as ½ and drop the first point; else count Y as 1 and drop its two points. Residue
  counted as half cycles.
- **Four-point**: inner range |s₃ − s₂| closes when ≤ |s₂ − s₁| and ≤ |s₄ − s₃|; full cycles only; residue returned;
  `residue: half_cycles` counts the residue with the three-point rule (gives E1049 totals, VC-FAT-02), `repeat` closes it
  by appending the residue to itself (standard closing for repeated blocks).
- **Repeating history (§5.4.5)**: rotate the reversals to start at the largest |value| (ties → first), append the start,
  count with the three-point rule; all counts are full cycles (VC-FAT-03).
- Cycles carry from / to / range / mean; aggregation sorts by range; binning uses right-closed bins of `binSize`.

Validation: E1049 Fig. 6 history `[-2, 1, -3, 5, -1, 3, -4, 4, -2]` → `[[3, 0.5], [4, 1.5], [6, 0.5], [8, 1], [9, 0.5]]`,
quoted identically by [R2] and [R3] and reproduced by the generator.

### 5.2 Stress-life (TR-FAT-10)

`2N = (σar / σ'f)^(1/b)`; power law `N = N_D (S/S_D)^-k`, beyond the knee `k2` or infinite (cut-off) if declared;
`sn_table`: log10 N linear in log10 S between points; between R families linear in R; outside the points →
`extrapolated: true` + `FAT_CURVE_EXTRAPOLATED` (no clamping). Amplitude ≥ Ftu (08 record, explicit basis) →
`FAT_STATIC_FAILURE`. Modifiers divide the curve stress (σ'f / Π modifiers) — never the applied stress — and are
listed in `factors.modifiers`.

### 5.3 Strain-life (TR-FAT-11)

CMB `εa = σ'f/E (2N)^b + ε'f (2N)^c`; Morrow `(σ'f − σm)/E`; SWT `σmax εa = σ'f²/E (2N)^(2b) + σ'f ε'f (2N)^(b+c)` [R6],
[R7]. Newton on x = log10 2N: f(x) as above, f'(x) = ln10 · Σ(coeff · exponent · 10^(x·exponent)). Transition life
2Nt = (ε'f E / σ'f)^(1/(b−c)). Test set (VC-FAT-12): εa = 0.0075 → 2N = 4414.932.

### 5.4 Notch and local stress-strain (TR-FAT-12)

Kf = 1 + q (Kt − 1); Peterson q = 1/(1 + a/r); Neuber q = 1/(1 + √(ρ'/r)) [R5], [R9]. Neuber's rule on the cyclic curve:
solve σ·(σ/E + (σ/K')^(1/n')) = (Kf S)²/E by bisection on [0, Kf S] (monotone) then 3 Newton steps. Each rainflow cycle
uses the Masing branch with Δσ·Δε = (Kf ΔS)²/E. When the stress comes from FE (`feIncludesKt: true`, default), Kt is
already in the stress: q·(Kt−1) is applied only if `notch.kt` is given for a feature the mesh does not resolve.
Reference (VC-FAT-21/22): Kt 2.41, q 0.9857, S = 375 MPa, E 210 GPa, K' 1060 MPa, n' 0.14 → σmax = 506.729 MPa,
SWT life 2919.91 cycles, identical to [R5] Example 1.

### 5.5 Mean stress (TR-FAT-13)

σar = σa/(1 − σm/Su) (Goodman), σa/(1 − (σm/Su)²) (Gerber), σa/(1 − σm/Sy) (Soderberg), σa/(1 − σm/σ'f) (Morrow),
√(σmax σa) (SWT), σmax^(1−γ) σa^γ (Walker; γ = 0.5 equals SWT) [R6], [R7], [R10]. Su / Sy come from the 08 record
(explicit basis) and are named in `provenance`. σm < 0 with `compressiveMean: no_benefit` → σar = σa for Goodman,
Gerber, Soderberg, Morrow. σmax ≤ 0 (SWT/Walker) → zero damage with item `FAT_SWT_NONPOSITIVE` (info).

### 5.6 FE hot spots (TR-FAT-15)

1. Read the 05 results artifact via `ctx.feaArtifacts` (read-only; absent → `FAT_RESULTS_MISSING`); require the results
   `inputHash` to match the current 05 hash (else `FAT_RESULTS_STALE`).
2. For each mapped load case k take the nodal tensor σ_k; build σ(t) = Σ s_k(t) σ_k per node (same time base; histories
   of different lengths are refused with `FAT_HISTORY_MISMATCH`).
3. Scalar measure per time step: signed von Mises (sign of the principal with the largest magnitude) or max principal or a
   component; proportionality check from the principal directions (TR-FAT-15).
4. Candidate hot spots: the `count` nodes with the largest scalar range, one per part and at least 2 element lengths apart
   (05 mesh size); 05 singular zones excluded and listed `singular: true`.
5. Count, correct, accumulate damage, compute life and margin per hot spot.

### 5.7 `compute_fatigue` data shape

```json
{
  "caseId": "fc-7.1", "method": "stress_life", "resultsHash": "…", "fatigueInputHash": "…", "minMargin": 26.0067,
  "factors": {
    "scatter": { "value": 3, "source": "case input", "defaulted": false },
    "damageLimit": { "value": 1, "source": "Palmgren-Miner rule", "defaulted": true },
    "compressiveMean": { "value": "no_benefit", "source": "llull conservative rule", "defaulted": true },
    "modifiers": []
  },
  "rows": [{
    "rowKey": "h1", "part": "plate-3.1", "atMm": [0, 10, 0], "measure": "signed_von_mises",
    "rangesMPa": [[300, 0.5], [400, 1.5], [600, 0.5], [800, 1.0], [900, 0.5]], "damagePerBlock": 1.23426e-5, "lifeBlocks": 81019.98,
    "requiredLife": { "value": 1000, "unit": "blocks" }, "margin": 26.0067, "status": "PASS", "extrapolated": false,
    "curve": { "recordId": "mat_test", "modelId": "sn1", "kind": "sn_basquin", "basis": "company", "provenance": "…" },
    "meanStress": "none", "provenance": { "method": "rainflow E1049 + Basquin + Miner", "standard": ["ASTM E1049"] },
    "unverified": false, "unverifiedReasons": [], "singular": false,
    "reviewRequired": true, "reviewReason": "fatigue life supports a certification decision", "disposition": "none"
  }],
  "reviewRequired": true,
  "summary": "1 hot spot, min life 81 020 blocks, margin 26.0 with scatter factor 3 (case input). Computed by llull, not approved — needs a qualified engineer."
}
```

### 5.8 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Newton (ε-N, SWT) | \|Δ log10 2N\| < 1e-14, residual 1e-12 rel |
| Neuber solve | bisection to 1e-12 rel, then Newton |
| Rainflow | exact on input values (no rounding unless `binSize`) |
| Superposition | double precision; tensor components in the 05 unit system |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| Load history CSV `time,value` or `max,min,cycles` (+ unit header) | in | pure parser in `@phys`, called by `define_load_history` (plan carries values) or a host import transport |
| Spectrum export CSV / JSON | out | ✱ `export_stress_spectrum` |
| 05 results | in | 05 artifact store (read-only port) |
| Licensed curves (MMPDS, NIMS, company) | in | 08 private libraries (`register_material_library`), never serialised |
| Document | persist | `durability` slice; dispositions stored with `fatigueInputHash` |

Plugin `validate`: ids unique, histories finite with ≥ 2 values, mappings reference existing histories / 05 load cases,
factors ≥ 1 (scatter) and > 0 (modifiers), dispositions well formed.

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands as `llull <command> …`; `llull guide` gains a fatigue section: units (MPa or ksi, reversals vs
  cycles), the factor rules (no default scatter factor), the minimal history-only and FE plans, end with `check_fatigue`
  (AF-03).
- **MCP**: toolset `durability`; prompt `fatigue_quick_check` (history → `count_cycles` → `fatigue_life` → `check_fatigue`).
- **UI**: review only (`src/ui/panels/durability/*`): fatigue table, hot-spot glyphs, curve / Haigh / rainflow matrix plots
  from the same data (AF-21), disposition dialog (signature, 09).

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `FAT_HISTORY_INVALID` | error | < 2 values, non-finite, unit/kind mismatch | history id, param path | fix the values or the unit |
| `FAT_HISTORY_EMPTY` | error | no reversal after gating | history id | lower `gate` |
| `FAT_HISTORY_MISMATCH` | error | mapped histories of different lengths | case id | resample to one time base |
| `FAT_HISTORY_IN_USE` | error | deleting a history used by a case | history, case ids | delete or remap the case first |
| `FAT_CURVE_MISSING` | error | record has no model of the needed kind | record id | add an S-N / ε-N model (PHY-02 commands) |
| `FAT_CURVE_UNAVAILABLE` | error | private licensed model unresolved or redacted | record, library id | `register_material_library` on this machine |
| `FAT_CURVE_UNVERIFIED` | warning (not suppressible) | curve basis typical / unstated / legacy | record, model id | use a verified, sourced curve |
| `FAT_CURVE_EXTRAPOLATED` | warning | life or stress outside the tested range | row key | use a curve covering the range |
| `FAT_MEAN_MODEL_REQUIRED` | error | non-zero means with a single-R curve and `meanStress: none` | case id | choose a mean-stress model |
| `FAT_STATIC_FAILURE` | fail | amplitude or max stress ≥ Ftu | row key | static redesign (05 margins) first |
| `FAT_SOLVER_NO_CONVERGENCE` | error | Newton / Neuber not converged | row key | check model parameters |
| `FAT_NONPROPORTIONAL` | warning | principal directions rotate > 15° | row key | treat as indicative; critical plane (V2) |
| `FAT_SWT_NONPOSITIVE` | info | σmax ≤ 0 under SWT/Walker | row key | — |
| `FAT_RESULTS_MISSING` | error | no 05 results artifact | analysis id | `fea_solve` |
| `FAT_RESULTS_STALE` | error | 05 results or fatigue inputs changed | case id | re-solve 05, re-run |
| `FAT_SCATTER_FACTOR_UNSET` | error | no scatter factor and no confirmed profile | case id | `set_fatigue_factors scatter=…` with a source (ask the owner) |
| `FAT_PROFILE_UNCONFIRMED` | warning | profile value not verified by a human | profile | confirm the clause, then update the profile table |
| `FAT_FACTOR_INVALID` | error | scatter < 1, modifier ≤ 0 or without justification | param path | correct |
| `FAT_MARGINAL_BAND_UNSET` | warning | no marginal band | case id | company rule or owner choice |
| `FAT_LIFE_SHORT` | fail | margin < 0 | row key | redesign; reviewer disposition only |
| `FAT_LIFE_MARGINAL` | warning | 0 ≤ margin < band | row key | same |
| `FAT_DISPOSITION_PENDING` | warning | FAIL / MARGINAL row without disposition | row keys | reviewer in the desktop app |
| `FAT_HUMAN_GATE` | error | `dispose_fatigue_result` by an agent / without valid signature | row key | hand over to the qualified reviewer |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03 | registry commands (§4), descriptions with units and next command, guide section (§7) |
| AF-04/10 | `{value, unit}` or unit-suffixed fields everywhere (§5.7) |
| AF-05 | plans in `validation/plans/` |
| AF-11 | §7.1 |
| AF-13 | deterministic counting and Newton (§5.8) |
| AF-20 | `check_fatigue` |
| AF-21 | curve samples, rainflow matrix, damage per bin in `data` (FR-FAT-18) |
| AF-30 | compressive-mean rule, damage limit, proportionality threshold held as data with sources |
| AF-31 | FR-FAT-09, §5.7 `factors` |
| AF-32 | FR-FAT-12 |
| AF-33 | FR-FAT-10 |
| AF-34/34a | `dispose_fatigue_result` + 09 signature port |
| AF-35 | `provenance` per row |
| AF-42 | `--dry-run` on mutating commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| `count_cycles` | ≥ 1e6 reversals/s in TS (single pass, stack) |
| `compute_fatigue` on 50k nodes × 3 load cases × 10k-point history | ≤ 10 s (hot-spot pre-selection by scalar range; full counting only on the top 1 % of nodes) — TBD measure |
| Memory | streaming over nodes; no full time × node matrix |
| Robustness | every refusal is a no-op with code; NaN anywhere → `FAT_HISTORY_INVALID` |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/fatigue/*`) | counting (3pt, 4pt, repeating, gate, binning), Basquin, power law, CMB/Morrow/SWT Newton, Neuber, Masing, mean-stress models, Miner; each command happy + failure + `is pure` | 01–04, 10–14, 20–24, 30, 40, 41 |
| Contract | `toToolSchemas()` snapshot gains `durability`; toolset invariant; plugin validate/restore | — |
| Golden | `validation/plans/*.plan.json` once commands exist | 01, 40, 42 |
| Integration (needs 05 + ccx) | plate-with-hole spectrum: hot spot at the hole edge, local history = VC-FAT-42 within 5 % (FE Kt) | 42 |
| Agent-first | codes, named factors, human gate, unverified propagation, stale | 50, 60 |

Coverage 90/85/90/90 extends to `packages/domain-physics/src/**`.

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `durability` slice, load histories, `count_cycles` (3pt/4pt/repeating), `fatigue_life` stress-life + mean stress, VC-01…04, 10, 11, 30 | PHY-00 harness; PHY-02 fatigue variants (§3.1) | 2 w |
| M2 | strain-life, Neuber/Masing, notch q models, Miner, history-only `compute_fatigue`, factors, margins, `check_fatigue`, human gate, VC-12…14, 20…24, 40, 41, 50, 60 | M1; 09 signature port | 2 w |
| M3 | FE coupling (05 artifacts, superposition, hot spots, proportionality), staleness, spectrum export, plans, VC-42 | M2; aerospace 05 M3 | 2 w |
| M4 (V1) | modifiers, MMPDS-style fits, Haigh tables, CSV spectrum import, nonlinear damage options | M3 | 2 w |
| M5 (V1) | PHY-09 stress PSD → spectral fatigue (COULD) | PHY-09 | 1–2 w |
| V2 | critical-plane multiaxial, welded joints, FKM-style sets | — | — |

## 11. Open questions / decisions needed

1. **OQ-FAT-01 Scatter factors.** AC 25.571-1D [R13] and CS 25.571 [R14] values were not read (fetch blocked). Should
   llull keep "no default" permanently, or ship a profile table once a human confirms the values?
2. **OQ-FAT-02 NASA-STD-5019 life factor 4** comes from secondary sources only [R21]: confirm the clause before the
   `nasa_std_5019` profile loses `sourceStatus: "unconfirmed"`.
3. **OQ-FAT-03 Stress measure default** for FE: signed von Mises vs max principal (aluminium airframe practice tends to
   max principal); company rule?
4. **OQ-FAT-04 Peterson / Neuber constants**: sources disagree on the Peterson a(Su) correlation (e.g. [R5] omits the
   exponent found in other textbooks); llull ships none — confirm.
5. **OQ-FAT-05 MMPDS equivalent-stress fit form** (`sn_equivalent_stress`): verify the published form against MMPDS
   (licensed) before PHY-02 freezes the field names.
6. **OQ-FAT-06 Package**: confirm `packages/domain-physics` with toolset `durability` (README §5.1).
7. **OQ-FAT-07 Standard spectra**: can a licence for TWIST / FALSTAFF sequence files (ESDU 97018 [R16]) be obtained for
   validation, or do we stay with E1049 and synthetic histories?

## 12. References

See [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 ([R1]–[R22]) and [`validation/sources.md`](validation/sources.md)
for access method and grade. Repository paths: `packages/core/src/model/types.ts`,
`packages/core/src/plugins/plugin.ts`, `packages/mcp/src/toolsets.ts`, `packages/core/src/commands/project/types.ts`,
`packages/domain-aec/src/industrial/runway/*`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`,
`docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`, `docs/aerospace/09-plm-configuration-traceability/TECHNICAL_SPEC.md`.

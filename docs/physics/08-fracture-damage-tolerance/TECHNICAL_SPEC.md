# PHY-08: Fracture mechanics & damage tolerance — technical specification

Gap id **FRC** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

`[Rn]` ≡ register id `Sn`. Placement follows physics README §6.2 (proposal pending README §5.1).

## 1. Current state in llull

| Area | What exists | Path | Limit for fracture |
| ---- | ----------- | ---- | ------------------ |
| Fracture / crack code | None: `grep -ril "crack\|stress.intensity\|paris" packages/` finds only two unrelated civil earthworks files (`packages/domain-aec/src/civil/earthworks/earthworks{Math,Commands}.ts`) | — | Everything is new |
| Material | `Material { name, density, color, metalness, roughness, finish? }`; 08 MAT adds records; PHY-02 adds `materialModels` | `packages/core/src/model/types.ts` (line 639) | No toughness or da/dN data |
| FE | (aerospace 05) static linear analysis, Netgen meshing (`llull-mesh`), CalculiX, FRD reader, artifact store, `ctx.feaArtifacts`, idealizations `solid` / `plane_stress` / `shell` | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3 | No crack seam, no plane strain, no singular elements, no J / K extraction |
| CalculiX | `*CRACK PROPAGATION` (separate deck, S3-shell crack triangulation, K from uncracked stresses with shape factors F = 2/π, 2/π(1.04 + 1.1 s²), 1.12(1 − 0.02 s²), Richard K_eq, Paris-type law with threshold, critical and R corrections, 8 `*USER MATERIAL` constants); `*HCF`; plane-strain elements CPE6/CPE8 | CalculiX manual [R9] (commit fd588701) | No contour / J / interaction integral keyword in the manual: K from FE must be llull post-processing |
| Fatigue | (PHY-07) load histories, rainflow, `durability` slice | `docs/physics/07-fatigue/TECHNICAL_SPEC.md` §3.2 | Growth reuses histories and counting |
| Signatures | (09 PLM) `ctx.caller`, `ctx.signatures`, `record_signature` | `docs/aerospace/09-plm-configuration-traceability/TECHNICAL_SPEC.md` TR-PLM-07/16 | Used by the acceptance gate |

## 2. Target architecture

> **Placement erratum (coordinator, 2026-10-15).** `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids `packages/domain-physics` importing `@cae` (or any other package). Wherever this spec says `@phys` imports or extends `@cae`, read: the plugin registers its analysis type, deck fragments and result readers through the **core analysis extension port** proposed in [`../03-thermal-analysis/TECHNICAL_SPEC.md`](../03-thermal-analysis/TECHNICAL_SPEC.md) §2; fallback: the discipline lives inside the 05 FEA package. Decision pending in [`../README.md`](../README.md) §5.


```
src/ui (DT table, crack glyphs, acceptance dialog)        server/ (transports: export_crack_growth file write; V1 ccx crack deck run)
        ▼ dispatch
src/app installDefaultPlugins() + fracturePlugin (after caePlugin, fatiguePlugin)
        ▼
packages/domain-physics/src/fracture   (@phys/fracture) — CadPlugin "fracture", toolset "durability"
   commands/  define_crack, update_crack, delete_crack, create_crack_growth_case, update_crack_growth_case,
              delete_crack_growth_case, set_damage_tolerance_factors, stress_intensity, crack_growth_rate,
              compute_crack_growth, compute_residual_strength, compute_inspection_interval, compute_k_from_fe (V1),
              check_damage_tolerance, dispose_damage_tolerance_result (human gate)
   ksolutions/ centerThrough.ts, edgeThrough.ts, newmanRaju.ts (surface, corner, at hole — V1), registry.ts (validity ranges)
   growth/     laws.ts (paris, walker, forman, nasgro, table), closure.ts, integrate.ts (cycle-by-cycle, block, adaptive)
   residual/   residualStrength.ts, critical.ts
   fe/         interactionIntegral.ts (2D domain form, V1 3D), cracktip.ts (q-function rings), seam.ts (05 mesh extension)
   ccx/        crackPropagationDeck.ts (V1 hand-off writer / reader)
        ▼ core public API + @cae + @phys/fatigue public API (histories, counting)
packages/core/src/model/materialModel.ts  (PHY-02) — growth / toughness variants §3.1
packages/core/src/model/durability.ts     (PHY-07) — PHY-08 adds cracks, crackGrowthCases
```

**Laws.** L1 every change a command, results are queries; L2 `@phys` uses public APIs only, processes in `server/`;
L3 pure; L4 `durability` slice only, FE fields in the 05 artifact store; L5 zod + toolset `durability`; L6 server spawns
only (V1 ccx crack run); L8 ids `cr-<step>.<k>` (crack), `cg-<step>.<k>` (growth case), results recomputed; L9 no kernel
for handbook cracks; V1 crack seam is a 05 mesh-time operation in `llull-mesh` (shape boundary unchanged); L10 plugin.

**Technical requirements**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-FRC-01 | MUST | Plugin `fracture` in `packages/domain-physics`, toolset `durability` (shared with PHY-07); document extension validates the PHY-08 members of `durability`. |
| TR-FRC-02 | MUST | Growth / toughness data are PHY-02 `MaterialModel` variants (§3.1); `@phys/fracture/models.ts` builds a read-only view converted to SI-mm or US units with basis, provenance, `unverified`. No material storage here. |
| TR-FRC-10 | MUST | Through-crack K: centre `β = √sec(πa/W)` valid for 2a/W ≤ 0.7 (llull limit, stated as a llull choice, OQ-FRC-05); edge Tada (any a/b < 1 per [R2]) and polynomial (a/b ≤ 0.6). |
| TR-FRC-11 | MUST | Newman-Raju surface crack (tension) per §5.2, limits 0 < a/t < 1, 0.2 ≤ a/c ≤ 2, c/b < 0.5; results `unverified` with reason `K_SOLUTION_UNCONFIRMED` until OQ-FRC-01 closes. |
| TR-FRC-20 | MUST (V1) | Interaction integral, 2D domain form, linear elastic isotropic, plane stress / strain, ≥ 3 rings; K from I with E' (§5.4); J = (K_I² + K_II²)/E' reported. |
| TR-FRC-21 | SHOULD (V1) | CalculiX crack hand-off: map llull Paris-type model to the 8 constants ((da/dN)_ref, ΔK_ref, m, ε, ΔK_th, δ, K_c, w) with C = (da/dN)_ref / ΔK_ref^m [R9]; read back `KEQ`, `DADN`. |
| TR-FRC-30 | MUST | Constant-amplitude integration with closed-form Paris check (§5.5). |
| TR-FRC-31 | MUST | Spectrum integration: cycle-by-cycle on the PHY-07 counted (or sequential) cycles; block mode with adaptive Δa/a ≤ 1 % and RK4 in ln a; agreement with VC-FRC-05/07 ≤ 0.1 %. |
| TR-FRC-32 | MUST | Laws §5.3 with explicit conventions (Walker γ form, NASGRO f source). Rate outside the model's ΔK / R data → `FRC_RATE_EXTRAPOLATED` warning, never silent. |
| TR-FRC-40 | MUST | Residual strength and critical size §5.6. |
| TR-FRC-41 | MUST | Threshold / interval §5.7; factors explicit. |
| TR-FRC-50 | MUST | Agent-first result contract identical in shape to PHY-07 §5.7 (`factors`, `reviewRequired`, `unverified`, `provenance`, `disposition`); dispositions through the 09 signature port, bound to `dtInputHash`. |

## 3. Data model

### 3.1 Material-model variants PHY-02 must include (`model/materialModel.ts`)

```ts
interface CrackGrowthConditions {
  readonly stressRatio?: number | 'per_curve'; readonly environment?: string; readonly temperature?: Quantity;
  readonly orientation?: 'L-T' | 'T-L' | 'L-S' | 'T-S' | 'S-L' | 'S-T' | 'isotropic';
  readonly thickness?: Quantity; readonly testStandard?: string;            // e.g. "ASTM E647-23b" as given by the source
  readonly dKRange?: { readonly min: number; readonly max: number; readonly unit: string };  // data coverage
}
type CrackGrowthMaterialModel =
  | { kind: 'da_dn_paris'; C: number; m: number; units: 'm/cycle|MPa*m^0.5' | 'in/cycle|ksi*in^0.5'; dKth?: number; conditions: CrackGrowthConditions }
  | { kind: 'da_dn_walker'; C: number; m: number; gamma: number; gammaNegativeR?: number;
      convention: 'dK_over_(1-R)^(1-gamma)'; units: string; conditions: CrackGrowthConditions }
  | { kind: 'da_dn_forman'; C: number; n: number; Kc: number; units: string; conditions: CrackGrowthConditions }
  | { kind: 'da_dn_nasgro'; C: number; n: number; p: number; q: number;
      threshold: { dK0: number; Cth_pos?: number; Cth_neg?: number; a0?: number } | { dKth: number };
      toughness: { Kc: number } | { KIc: number; Ak: number; Bk: number; t0?: number };
      closure: { kind: 'newman'; alpha: number; smaxOverSigma0: number } | { kind: 'table'; points: ReadonlyArray<readonly [R: number, f: number]> } | { kind: 'none' };
      units: string; conditions: CrackGrowthConditions }
  | { kind: 'da_dn_table'; families: ReadonlyArray<{ stressRatio: number; points: ReadonlyArray<readonly [dK: number, dadN: number]> }>;
      interpolation: 'log_log'; units: string; conditions: CrackGrowthConditions }
  | { kind: 'fracture_toughness'; KIc?: Quantity; Kc?: ReadonlyArray<{ thickness: Quantity; value: Quantity }>;
      state: 'plane_strain' | 'plane_stress' | 'thickness_table'; orientation?: CrackGrowthConditions['orientation'];
      testStandard?: string };
```

The NASGRO-specific field names (`dK0`, `Cth_pos`, `Ak`, `Bk`, `alpha`, `smaxOverSigma0`) are proposals: the exact
threshold and toughness sub-models of the NASGRO equation must be confirmed against a primary NASGRO document before
PHY-02 freezes them (OQ-FRC-02).

### 3.2 Durability slice additions (`model/durability.ts`, PHY-07 owns the file, PHY-08 adds members)

```ts
export type CrackGeometry =
  | { kind: 'center_through'; a: Quantity; W: Quantity; t: Quantity }                  // a = half-length, W = full width
  | { kind: 'edge_through'; a: Quantity; b: Quantity; t: Quantity; form: 'tada' | 'polynomial' }
  | { kind: 'surface_semi_elliptical'; a: Quantity; c: Quantity; t: Quantity; b: Quantity }   // b = half-width (Newman-Raju)
  | { kind: 'corner_quarter_elliptical'; a: Quantity; c: Quantity; t: Quantity; b: Quantity }   // V1
  | { kind: 'through_at_hole'; a: Quantity; r: Quantity; W: Quantity; t: Quantity; sides: 1 | 2 } // V1
  | { kind: 'fe_seam'; analysisId: string; entityId: string; front: readonly Vec3[]; planeNormal: Vec3 };  // V1
export interface Crack {
  readonly id: string; name: string; geometry: CrackGeometry;
  location?: FeaTargetRef;                       // where it sits on the part (glyph, 05 stress pick-up)
  referenceStress: { source: 'history' } | { source: 'fe'; analysisId: string; loadCase: string; measure: 'normal_to_crack' };
}
export interface CrackGrowthCase {
  readonly id: string; name: string; crackId: string;
  material: { recordId: string; growthModelId: string; toughnessModelId: string; FtyBasis?: string };
  histories: { historyId: string; scale: number }[];                // PHY-07 histories (stress in MPa or load factors x reference)
  sequence: 'cycle_by_cycle' | 'rainflow_blocks';
  integration: { maxDaOverA: number };                              // default 0.01, named
  retardation: 'none';                                              // MVP named default
  growth: { aInitial: Quantity; aDetectable?: Quantity; aTarget?: Quantity; cInitial?: Quantity };
  residualStrengthStress?: Quantity;                                // stress for a_crit (explicit)
  factors: { scatterThreshold?: { value: number; source: string }; scatterInterval?: { value: number; source: string };
             profile?: 'none' | 'nasa_std_5019'; marginalBand?: number };
  dispositions: Record<string, { item: 'threshold' | 'interval' | 'life'; inputHash: string; decision: 'accepted' | 'rejected';
                                 justification: string; signatureId: string }>;
}
// DurabilityModel gains: cracks, crackOrder, crackGrowthCases, crackGrowthCaseOrder
```

V1 adds the 05 idealization member `{ kind: 'plane_strain'; thickness; sourceFacesNear }` (CalculiX CPE6/CPE8, deck keyword
`*SOLID SECTION` with thickness) as a PHY-08 contribution to 05's `Idealization` union, and a mesh control
`crackSeams: { crackId }[]`.

## 4. Commands

Plugin `fracture`, toolset `durability`.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `define_crack` / `update_crack` / `delete_crack` | mutating | `{ name, geometry, location?, referenceStress? }` | @affects durability.cracks · @invariant dims > 0, a < t for part-through, a < W/2 (centre) · @failure → `FRC_CRACK_INVALID`; delete in use → `FRC_CRACK_IN_USE` |
| `create_crack_growth_case` / `update_…` / `delete_…` | mutating | `{ name, crackId, material, histories, sequence?, integration?, growth, residualStrengthStress?, factors? }` | @invariant models exist and units consistent · @failure `FRC_MODEL_MISSING`, `FRC_UNITS_MISMATCH` |
| `set_damage_tolerance_factors` | mutating | `{ caseId, scatterThreshold?, scatterInterval?, profile?, marginalBand? }` | @invariant factors ≥ 1 with source · @failure `FRC_FACTOR_INVALID` |
| `stress_intensity` | query | `{ crackId \| geometry, stress: {value, unit}, phiDeg? }` → `data { KMPaSqrtM, beta, validity: {inRange, limits, accuracy, source}, unverified, provenance }` | read-only |
| `crack_growth_rate` | query | `{ material, growthModelId, dK: {value, unit}, R }` → `data { dadNMPerCycle, extrapolated, convention }` | read-only |
| `compute_crack_growth` | query | `{ caseId, samples?=200 }` → `data { lifeCycles, stopReason: 'fracture'\|'net_section_yield'\|'target'\|'geometry_limit'\|'runout', aFinalM, curve: [{N, aM, KmaxMPaSqrtM}] (bounded), factors, reviewRequired, unverified }` | @failure `FRC_INITIAL_CRITICAL`, `FRC_RESULTS_STALE` |
| `compute_residual_strength` | query | `{ crackId \| caseId, sizes?[] , stress? }` → `data { curve: [{aM, sigmaKMPa, sigmaNetYieldMPa, residualMPa, governing}], aCriticalM?, governing }` | read-only |
| `compute_inspection_interval` | query | `{ caseId }` → `data { thresholdCycles?, intervalCycles?, inUnit, aCriticalM, factors, reviewRequired, disposition }` | @failure `FRC_SCATTER_FACTOR_UNSET`, `FRC_DETECTABLE_SIZE_UNSET` |
| `compute_k_from_fe` (V1) | query | `{ analysisId, crackId, method: 'interaction_integral'\|'j_integral', rings?=4 }` → `data { front: [{s, KI, KII, KIII, J}], ringSpreadPct, state }` | reads `ctx.feaArtifacts` · @failure `FRC_NO_CRACK_SEAM`, `FRC_CONTOUR_SPREAD`, `FRC_RESULTS_STALE` |
| `check_damage_tolerance` | query | `{ caseId }` → pass / warn / fail items | AF-20 |
| `dispose_damage_tolerance_result` | mutating, **human gate** | `{ caseId, item, decision, justification, signature }` | @invariant 09 signature verified, bound to `dtInputHash` · @failure `FRC_HUMAN_GATE` |
| ✱ `export_crack_growth` | transport | `{ caseId, format: 'csv'\|'json', content: 'a_N'\|'K_a'\|'residual', path }` | writes with `--save` only |
| ✱ `fea_crack_propagation` (V1) | transport | `{ analysisId, crackId }` | writes the ccx crack deck (TR-FRC-21), runs ccx, returns `KEQ`/`DADN` summary (review-only cross-check) |

## 5. Algorithms

### 5.1 Through cracks (TR-FRC-10)

K = β σ √(πa). Centre: β = √sec(πa/W) [R1]; edge (width b): Tada
β = √((2b/πa) tan(πa/2b)) · [0.752 + 2.02(a/b) + 0.37(1 − sin(πa/2b))³] / cos(πa/2b) (0.5 % any a/b), polynomial
β = 1.122 − 0.231(a/b) + 10.55(a/b)² − 21.71(a/b)³ + 30.382(a/b)⁴ (0.5 % for a/b ≤ 0.6) [R2]. Both edge forms
differ by < 1 % over 0.1 ≤ a/b ≤ 0.6 (generator assertion). Reference: VC-FRC-01, 02.

### 5.2 Newman-Raju surface crack (TR-FRC-11) — transcription to be confirmed (OQ-FRC-01)

K = S √(πa/Q) F(a/c, a/t, c/b, φ), Q = 1 + 1.464 (a/c)^1.65 (a/c ≤ 1) [R5]; F = [M1 + M2 (a/t)² + M3 (a/t)⁴] g f_φ f_w with
M1 = 1.13 − 0.09 a/c, M2 = −0.54 + 0.89/(0.2 + a/c), M3 = 0.5 − 1/(0.65 + a/c) + 14 (1 − a/c)^24,
g = 1 + [0.1 + 0.35 (a/t)²](1 − sin φ)², f_φ = [(a/c)² cos²φ + sin²φ]^¼, f_w = [sec(πc/(2b) √(a/t))]^½. Q, M1 and the
M2 denominator appear in search extracts of [R5] and FITNET; M3, g, f_φ, f_w are from the implementer's knowledge and
must be checked against TM-83200 before use as a gate (VC-FRC-04 is grade C). a/c > 1 branch: V1, same check.

### 5.3 Growth laws (TR-FRC-32)

| Law | da/dN | Notes |
| --- | ----- | ----- |
| Paris | C ΔK^m | [R6]; CalculiX writes the same law as (da/dN)_ref (ΔK/ΔK_ref)^m [R9] |
| Walker | C [ΔK / (1 − R)^(1−γ)]^m | convention stored; py-fatigue writes its intercept with a different exponent grouping (OQ-FRC-04) |
| Forman | C ΔK^n / [(1 − R) K_c − ΔK] | infinite at K_max = K_c |
| NASGRO | C [((1 − f)/(1 − R)) ΔK]^n (1 − ΔK_th/ΔK)^p / (1 − K_max/K_crit)^q | [R7]; f = Newman function, table or R; ΔK ≤ ΔK_th → 0; K_max ≥ K_crit → fracture |
| Table | log-log interpolation in ΔK, linear in R between families | outside the table → `FRC_RATE_EXTRAPOLATED` |

Newman closure f (as commonly quoted with the NASGRO equation, grade C): A0 = (0.825 − 0.34α + 0.05α²)
[cos(π S_max/(2σ0))]^(1/α), A1 = (0.415 − 0.071α) S_max/σ0, A3 = 2A0 + A1 − 1, A2 = 1 − A0 − A1 − A3;
f = max(R, A0 + A1R + A2R² + A3R³) for R ≥ 0, f = A0 + A1R for −2 ≤ R < 0.

### 5.4 Interaction integral (TR-FRC-20, V1)

For a 2D crack tip with local axes (x₁ along the crack), domain form over rings of elements around the tip with a smooth
weight q (1 at the tip, 0 on the outer ring):
I^(1,2) = ∫_A [σ_ij ∂u_i^aux/∂x₁ + σ_ij^aux ∂u_i/∂x₁ − σ_ik ε_ik^aux δ_1j] ∂q/∂x_j dA, with Williams auxiliary fields
for pure mode I and II; K_I = (E'/2) I^(1,I), K_II = (E'/2) I^(1,II), E' = E (plane stress) or E/(1 − ν²) (plane strain);
J = (K_I² + K_II²)/E' [R10]. Evaluated at Gauss points of the 05 artifact (element stresses and displacement gradients
re-computed from nodal displacements in `@phys`, not from averaged FRD stresses). Ring spread = (max − min)/mean over
rings 2…n; > 5 % → `FRC_CONTOUR_SPREAD`. The crack seam (duplicate nodes on the crack faces) is made at mesh time in
`llull-mesh` by fragmenting the face with the crack line (OCCT) and duplicating its nodes (Netgen has no crack plugin, OQ-FRC-06); ring refinement uses the 05 `refinements` mechanism (size ≈ a/50 at the tip).

### 5.5 Integration (TR-FRC-30/31)

- Constant amplitude: closed form for Paris, β = 1: N = (a0^(1−m/2) − af^(1−m/2)) / (C (m/2 − 1)(Δσ√π)^m) (m ≠ 2;
  m = 2: N = ln(af/a0)/(C π Δσ²)). Reference 776 634.44 cycles (VC-FRC-05).
- General: adaptive RK4 in u = ln a, dN/du = a / (da/dN); step limited by Δa/a ≤ `maxDaOverA`; cycle-by-cycle summation
  for spectra (a_{n+1} = a_n + da/dN(ΔK_n, R_n)); K_max checked every cycle against K_c and σ_net against Fty.
- Spectra: PHY-07 `sequence: cycle_by_cycle` uses the reversal sequence (pairs of consecutive reversals as half
  cycles); `rainflow_blocks` uses rainflow cycles per block and applies them in the counted order (no retardation).
- Runout cap 1e8 cycles → `FRC_RUNOUT`.

### 5.6 Residual strength and critical size (TR-FRC-40)

σ_K(a) = K_c / (β(a) √(πa)); σ_ny(a) = Fty (1 − 2a/W) (centre crack; edge: Fty (1 − a/b)); residual = min; critical size
at stress σ: root of β(a) σ √(πa) − K_c = 0 by bisection in (0, a_geom); net-section size a_ny = W/2 (1 − σ/Fty). Fty from
the 08 record with explicit basis. Reference VC-FRC-10…12.

### 5.7 Threshold and interval (TR-FRC-41)

threshold = N(a_initial → a_crit(σ_rs)) / SF_threshold; interval = N(a_detectable → a_crit) / SF_interval; both reported
in cycles and in the history unit; unset factor → `FRC_SCATTER_FACTOR_UNSET`; profile `nasa_std_5019` → life factor 4
`sourceStatus: "unconfirmed"` (results `unverified`). Reference VC-FRC-13/14.

### 5.8 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Root finding (critical size) | bisection to 1e-12 m |
| RK4 in ln a | ≤ 0.1 % vs closed form (VC-FRC-05) |
| Cycle-by-cycle | exact summation in double |
| Interaction integral ring spread | ≤ 5 % |

## 6. Interop & persistence

| Format | Direction | Notes |
| ------ | --------- | ----- |
| a-N / K-a / residual CSV, JSON | out | ✱ `export_crack_growth` |
| CalculiX crack deck (V1) | out / in | `*CRACK PROPAGATION`, `*USER MATERIAL, CONSTANTS=8`, S3 crack triangulation; `KEQ`, `DADN` read back from FRD [R9] |
| NASGRO / AFGROW | none | no file-format claims; tabular export only |
| Licensed models | in | 08 private libraries |
| Document | persist | `durability.cracks`, `durability.crackGrowthCases`, dispositions with `dtInputHash` |

## 7. CLI / MCP / UI surfaces

CLI: `llull <command>`; `llull guide` fracture section (units MPa·√m vs ksi·√in, the factor rules, minimal handbook plan,
end with `check_damage_tolerance`). MCP: toolset `durability`, prompt `damage_tolerance_quick_check`. UI: review only.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `FRC_CRACK_INVALID` | error | non-positive dims, a ≥ t, a ≥ W/2 | crack id, param path | correct the geometry |
| `FRC_CRACK_IN_USE` | error | deleting a crack used by a case | crack, case ids | delete the case first |
| `FRC_K_SOLUTION_OUT_OF_RANGE` | error | ratio outside the solution's validity | crack id, ratio, limits | use FE K (V1) or another geometry |
| `FRC_K_SOLUTION_UNCONFIRMED` | warning | Newman-Raju before OQ-FRC-01 closes | crack id | treat as indicative |
| `FRC_MODEL_MISSING` | error | no growth / toughness model | record id | add a model (PHY-02) |
| `FRC_MODEL_UNAVAILABLE` | error | private model unresolved / redacted | library id | register the library locally |
| `FRC_DATA_UNVERIFIED` | warning (not suppressible) | typical / unstated data, unconfirmed profile | model ids | use verified data |
| `FRC_RATE_EXTRAPOLATED` | warning | ΔK or R outside model data | case id, ΔK | extend data or accept as indicative |
| `FRC_UNITS_MISMATCH` | error | model units incompatible with case | param path | fix units |
| `FRC_INITIAL_CRITICAL` | fail | K_max ≥ K_c at a_initial | case id | smaller flaw or redesign |
| `FRC_RUNOUT` | info | no stop within 1e8 cycles | case id | — |
| `FRC_SCATTER_FACTOR_UNSET` | error | threshold / interval factor missing | case id | `set_damage_tolerance_factors` with a source |
| `FRC_DETECTABLE_SIZE_UNSET` | error | interval requested without a_detectable | case id | give the NDE detectable size with source |
| `FRC_FACTOR_INVALID` | error | factor < 1 or no source | param path | correct |
| `FRC_NO_CRACK_SEAM` | error | FE K without a seamed mesh | analysis id | add `crackSeams`, re-mesh |
| `FRC_CONTOUR_SPREAD` | error | ring spread > 5 % | crack id, spread | refine the tip mesh |
| `FRC_RESULTS_MISSING` / `FRC_RESULTS_STALE` | error | 05 results absent / inputs changed | ids | re-solve / re-run |
| `FRC_MARGINAL_BAND_UNSET` | warning | no band | case id | owner / company rule |
| `FRC_DISPOSITION_PENDING` | warning | interval / threshold not accepted | case id | reviewer acceptance |
| `FRC_HUMAN_GATE` | error | agent or no valid signature on acceptance | case id | qualified reviewer in the desktop app |

### 7.2 Agent-first compliance

AF-01/02/03 (registry, descriptions, guide), AF-04/10 (units, unit-suffixed fields), AF-05 (plans), AF-11 (§7.1),
AF-13 (deterministic integration), AF-20 (`check_damage_tolerance`), AF-21 (curves as data), AF-30 (validity ranges,
integration limits held as data), AF-31 (FR-FRC-09), AF-32 (FR-FRC-13), AF-33 (FR-FRC-11), AF-34/34a
(`dispose_damage_tolerance_result` + 09), AF-35 (`provenance`: solution id, law, convention, inputs), AF-40 (V1 FE
transport progress), AF-42 (`--dry-run`).

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Constant-amplitude growth | ≤ 50 ms (adaptive) |
| Cycle-by-cycle spectrum growth, 1e6 cycles | ≤ 2 s in TS |
| Interaction integral, 4 rings, 2D | ≤ 0.5 s per tip |
| Output | curves down-sampled to `samples` points (AF-12) |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/fracture/*`) | K library, validity, laws, closure, integration vs closed form, residual strength, interval, CalculiX constant mapping; every command happy + failure + `is pure` | 01, 02, 04–16 |
| Integration (05 + ccx, V1) | NAFEMS 2.1 interaction integral; centre-crack plate vs secant | 03, 17 |
| Golden | `validation/plans/*` once commands exist | 05, 10 |
| Agent-first | codes, factors, gate, unverified, stale | 20 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | durability additions, cracks, through-crack K, `stress_intensity`, laws, `crack_growth_rate`, constant-amplitude integration, VC-01, 02, 05–09 | PHY-07 M1, PHY-02 variants §3.1 | 2 w |
| M2 | spectrum integration (PHY-07 histories), residual strength, intervals, factors, gate, `check_damage_tolerance`, export, VC-10…14, 20 | M1, 09 signatures | 2 w |
| M3 | Newman-Raju (after OQ-FRC-01), corner / hole cracks (V1 prep), CalculiX constant mapping (VC-15, 16) | M2 | 1.5 w |
| M4 (V1) | crack seam in 05 meshing, plane strain idealization, interaction integral 2D, VC-03, 17 | aerospace 05 M3 | 3 w |
| M5 (V1) | 3D front interaction integral, ccx `*CRACK PROPAGATION` cross-check transport, retardation options | M4 | 3 w |

## 11. Open questions / decisions needed

1. **OQ-FRC-01** Newman-Raju equations: a human must check §5.2 against NASA TM-83200 / EFM 15 (1981) (NTRS blocked from
   this session) before VC-FRC-04 becomes a gate.
2. **OQ-FRC-02** NASGRO equation sub-models (threshold ΔK_th(R) form with ΔK0, Cth; toughness K_c(t) with Ak, Bk; closure
   coefficients): confirm from a primary NASGRO document; licence status of the NASGRO materials database for private use.
3. **OQ-FRC-03** Scatter factors for threshold and interval (AC 25.571-1D, CS 25.571 AMC, NASA-STD-5019): no default until
   confirmed by a human.
4. **OQ-FRC-04** Walker convention (γ and the exponent grouping) to store per model; confirm with the data source.
5. **OQ-FRC-05** Centre-crack secant validity limit: llull proposes 2a/W ≤ 0.7; find a source for the accuracy statement.
6. **OQ-FRC-06** Crack seam: Netgen (NG1) has no crack-seam node duplication, so llull implements it in
   `llull-mesh` or in `@phys` after meshing.
7. **OQ-FRC-07** NAFEMS R0020 original values (paid): obtain the publication to confirm the 3.0 target and test 2.2.
8. **OQ-FRC-08** AFGROW (commercial, LexTech) / NASGRO cross-runs as acceptance evidence: who runs them and with which
   licence?

## 12. References

[R1]–[R19] in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md).
Repository paths: `packages/core/src/model/types.ts`, `packages/core/src/plugins/plugin.ts`, `packages/mcp/src/toolsets.ts`,
`docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`, `docs/physics/07-fatigue/TECHNICAL_SPEC.md`,
`docs/aerospace/09-plm-configuration-traceability/TECHNICAL_SPEC.md`.

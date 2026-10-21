# PHY-01 — Property models — Technical spec

Gap id **PROP** · Status: specification (no implementation) · Written 2026-10-15
Functional: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

This pack **owns** `packages/core/src/model/propertyModel.ts`. Every other physics pack consumes the types and the
evaluator defined here and must not define material data of its own (README §6.2).

---

## 1. Current state in llull

Verified in the repository on 2026-10-15:

| Area | File(s) | Today | Limit |
| ---- | ------- | ----- | ----- |
| Material | `packages/core/src/model/types.ts` (`interface Material { name; density; color; metalness; roughness; finish? }`, `CadDocument.materials: Record<string, Material>`) | One scalar density plus PBR fields | No property other than density, no variable dependence |
| Material commands | `packages/core/src/commands/document/materials.ts` (`create_material`, `assign_material`) | Density "in (mass-unit) per (document-length-unit)³" (param description) | No units, no laws |
| Mass | `packages/core/src/commands/inspect/measureSolid.ts` (`mass_properties`) | `mass = volume × density`, result `unit: 'g'` always | Only consumer of material data today |
| Units | `packages/core/src/model/units.ts` (document length units) | No quantity grammar in core yet | 08 adds `lib/quantity.ts` (TR-MAT-01) |
| Query pattern | `annotations: { readOnly: true }`, same doc back, `data` (`.claude/context/command-layer.md`) | Used by `mass_properties`, `measure_distance` | Pattern reused |

After the aerospace packs (baseline, README §1): 08 MAT adds `model/material.ts` (`MaterialRecord`, `PropertyValue`,
`Provenance`, `Basis`, `TemperatureDependence` with linear interpolation and refusal outside the table, private
libraries, `check_materials`, `MAT_*` codes); 05 FEA reads a `FeaMaterialView` (E, ν, G, ρ, allowables) at room
temperature only. Neither has fitted laws, multi-variable models, a range distinction (data vs equation), or a
fitting command.

## 2. Target architecture

### 2.1 Layer placement (proposal, pending README §5 decision 1)

| Concern | Layer | Why |
| ------- | ----- | --- |
| Types `PropertyModel`, `PropertyForm`, `ValidRange`, `FitRecord`, `PropertyEvaluation` | `packages/core/src/model/propertyModel.ts` (new) | Core document data hanging off the 08 record (`MaterialRecord.propertyModels?`); plugins may read model types (L10) |
| Property catalogue (name → dimension, canonical unit, owner pack) | `packages/core/src/model/propertyCatalog.ts` (new) | Open/closed: packs add rows here, not `switch`es |
| Evaluator, resolver, tabulator (pure) | `packages/core/src/model/propertyModelEval.ts` (new) | Pure functions over model types; usable by core commands and by `@phys` / `@cae` through the public `model` API |
| Least squares (QR, scaling) | `packages/core/src/lib/leastSquares.ts` (new, pure leaf) | Reused by PHY-02 fits |
| Commands | `packages/core/src/commands/document/propertyModels.ts` + `propertyQueries.ts` + `fitPropertyModel.ts`, registered in `document/catalog.ts` | Generic material capability (like 08's material commands) |
| Toolset | `materials` (created by 08) | One toolset per command (`toolsets.ts` invariant) |
| Persistence | `commands/persistence/guards.ts` validator for `propertyModels` inside `validateMaterialRecord` (08) | Optional field: no schema-version bump (05 TR-FEA-02 precedent); library files gain `schemaVersion: 2` |

Laws: L1 (every change is a command), L2 (no I/O; data files reach the document through 08's
`import_material_library` / `register_material_library` transport), L3 (pure, `is pure` tests), L4 (models live
only in the record), L5 (zod schemas → MCP), L8 (`define_property_model` is a recorded step; queries are not),
L9 (no kernel), L10 (plugins read models via the evaluator, never redefine them).

### 2.2 Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-PROP-01 | MUST | Types of §3.1 with zod schemas; `MaterialRecord.propertyModels?: readonly PropertyModel[]`; id unique per record; one `preferred` per (property, direction, basis, condition key) | FR-PROP-01 |
| TR-PROP-02 | MUST | Variable values arrive as `{ value, unit }`; converted to the model's variable unit with the 08 grammar (affine for absolute temperature); the echoed `at` shows both | FR-PROP-11 |
| TR-PROP-03 | MUST | Forms evaluated exactly as §5.1 (formulas are normative); results finite or refused (`PROP_NONFINITE`) | FR-PROP-02, 03 |
| TR-PROP-04 | MUST | Range guard §5.3 before evaluation; no extrapolation path exists in code | FR-PROP-04 |
| TR-PROP-05 | SHOULD | Analytic derivatives for every form except `step` tables (`PROP_DERIVATIVE_UNAVAILABLE`); CTE from thermal strain §5.1 | FR-PROP-07 |
| TR-PROP-06 | MUST | Table and piecewise rules §5.2 (strictly increasing, declared mode, left segment at breakpoints, discontinuity measure) | FR-PROP-05, 06 |
| TR-PROP-07 | MUST | Adapter: 08 `PropertyValue` + `TemperatureDependence` → transient `PropertyModel` (`table1d` linear or `ratioOf`), same result shape | FR-PROP-12 |
| TR-PROP-08 | SHOULD | `fit_property_model` §5.4: scaled basis, Householder QR, deterministic; returns model + `FitRecord` | FR-PROP-09 |
| TR-PROP-09 | MUST | `coefficientsSha256` = sha256 of the canonical JSON (sorted keys, shortest round-trip numbers) of `form`; conflict rule §5.6 | FR-PROP-08 |
| TR-PROP-10 | SHOULD | Uncertainty kinds and band computation §5.5 | FR-PROP-10 |
| TR-PROP-11 | MUST | `unverified` rules §5.7; reasons propagate through `PropertyEvaluation` into every consumer result | FR-PROP-13, 23 |
| TR-PROP-12 | MUST | Error and check codes §7.1, `data.code` + ids/path + remediation | FR-PROP-14, 15 |
| TR-PROP-13 | SHOULD | `sample_property`: bounded sampling, Gauss-Legendre integral, solver-table algorithm §5.8 | FR-PROP-18 |
| TR-PROP-14 | MUST | Named defaults table §5.9 reported in `data.defaults[]` | FR-PROP-16 |
| TR-PROP-15 | MUST | Private-library models follow 08 TR-MAT-31 (stub + hash when unresolved; evaluation returns `available: false`, `MAT_LIBRARY_UNRESOLVED`) | FR-PROP-19 |
| TR-PROP-16 | MUST | Consumer API §3.3 is the only way physics packs read material properties | FR-PROP-17 |

## 3. Data model

### 3.1 Core types (`packages/core/src/model/propertyModel.ts`)

```ts
import type { Basis, GrainDirection, Provenance } from './material';          // 08 MAT
import type { PropertyName } from './propertyCatalog';

/** Independent variables. A pack that needs a new one adds it HERE (and lists it in its TECHNICAL_SPEC §3). */
export type PropertyVariable =
  | 'T'                        // absolute temperature
  | 'strainRate'               // equivalent strain rate
  | 'time'                     // time under load / since start
  | 'exposureTime'             // time at temperature before test (MMPDS-style families)
  | 'pressure'
  | 'equivalentPlasticStrain'; // used by PHY-02 hardening curves expressed as property models

export interface VariableSpec {
  readonly variable: PropertyVariable;
  readonly unit: string;                                   // unit the coefficients assume: 'K', '1/s', 'h', 'MPa', '1'
  readonly axis?: 'linear' | 'log10';                      // table2d axes only (default linear)
}

export interface ValidRange {
  readonly variable: PropertyVariable;
  readonly unit: string;
  readonly data: readonly [min: number, max: number];      // range of the underlying measurements
  readonly equation?: readonly [min: number, max: number]; // range the source allows for the fit; ⊇ data; absent = data
}

export type Interpolation = 'linear' | 'loglinear' | 'loglog' | 'step';

export type PropertyForm =
  | { readonly kind: 'constant'; readonly value: number }
  | { readonly kind: 'table1d'; readonly variable: PropertyVariable;
      readonly points: ReadonlyArray<readonly [x: number, y: number]>; readonly interpolation: Interpolation }
  | { readonly kind: 'table2d'; readonly x: VariableSpec; readonly y: VariableSpec;
      readonly xs: readonly number[]; readonly ys: readonly number[];
      readonly values: ReadonlyArray<readonly number[]>;  // values[i][j] at (xs[i], ys[j])
      readonly interpolation: 'bilinear' }
  | { readonly kind: 'polynomial'; readonly variable: PropertyVariable; readonly coefficients: readonly number[];
      readonly origin?: number }                          // y = Σ c_k (x − origin)^k
  | { readonly kind: 'log10Polynomial'; readonly variable: PropertyVariable; readonly coefficients: readonly number[] }
                                                          // log10 y = Σ c_k (log10 x)^k   (NIST, up to 9 coefficients a…i)
  | { readonly kind: 'nistRational'; readonly coefficients: readonly [number, number, number, number, number, number, number, number, number] }
                                                          // log10 y = (a + c√T + eT + gT^1.5 + iT²)/(1 + b√T + dT + fT^1.5 + hT²)
  | { readonly kind: 'arrhenius'; readonly preFactor: number; readonly activationEnergyJPerMol: number;
      readonly temperatureExponent?: number }             // y = A · T^m · exp(−Q/(R·T)), T in K
  | { readonly kind: 'powerLaw'; readonly variable: PropertyVariable; readonly coefficient: number;
      readonly exponent: number; readonly reference: number }   // y = c · (x / x_ref)^n
  | { readonly kind: 'piecewise'; readonly variable: PropertyVariable;
      readonly segments: ReadonlyArray<{ readonly upTo: number; readonly form: PropertyForm }> }
                                                          // segment k covers (upTo_{k−1}, upTo_k]; the first starts at the range minimum
  | { readonly kind: 'product'; readonly factors: readonly PropertyForm[] }   // separable f(T)·g(ε̇)…  (V1)
  | { readonly kind: 'rateFactor'; readonly law: 'johnsonCook'; readonly C: number; readonly referenceRate: number }
  | { readonly kind: 'rateFactor'; readonly law: 'cowperSymonds'; readonly D: number; readonly q: number }
  | { readonly kind: 'ratioOf'; readonly baseModelId: string; readonly ratio: PropertyForm };  // e.g. % of RT (08 percentOfRT)

/** Orientation labels beyond 08 GrainDirection: material axes and laminate/fabric directions. */
export type PropertyDirection = GrainDirection | '1' | '2' | '3' | 'normal' | 'warp' | 'fill';

export interface PropertyCondition {
  readonly temper?: string; readonly productForm?: string;
  readonly rrr?: number;                                   // residual resistivity ratio (copper, aluminium)
  readonly environment?: string;                           // free label, e.g. 'dry', 'wet 85 %RH'
  readonly note?: string;
}

export interface PropertyUncertainty {
  readonly kind: 'fitErrorVsData' | 'measurement' | 'statistical';
  readonly relative?: number;                              // e.g. 0.005 for NIST "0.5 %"
  readonly absolute?: { readonly value: number; readonly unit: string };
  readonly coverage?: number;                              // statistical only, e.g. 0.95
  readonly provenance: Provenance;
}

export interface FitRecord {
  readonly method: 'linear_least_squares' | 'levenberg_marquardt' | 'interpolating';
  readonly objective: 'absolute' | 'relative' | 'log10';
  readonly points: number;
  readonly datasetSha256: string;                          // canonical JSON of the (x, y, weight) rows
  readonly dataProvenance?: Provenance;                    // absent ⇒ unverified (TR-PROP-11)
  readonly residual: { readonly rms: number; readonly maxAbs: number; readonly maxRel: number;
                       readonly unit: string; readonly rSquared?: number };
  readonly conditionNumber?: number;
  readonly fittedRange: readonly ValidRange[];
  readonly tool: string;                                   // "llull <version> fit_property_model"
}

export interface PropertyModel {
  readonly id: string;                                     // unique in the record, e.g. "k.nist"
  readonly property: PropertyName;
  readonly unit: string;                                   // output unit of `form` as written, e.g. 'W/(m*K)', '1e-5'
  readonly variables: readonly VariableSpec[];             // every variable the form reads, with units
  readonly form: PropertyForm;
  readonly validity: readonly ValidRange[];                // REQUIRED, one per variable (no open-ended model)
  readonly basis: Basis;                                   // 08: A | B | S | typical | supplier_unstated | company | unspecified
  readonly direction?: PropertyDirection;
  readonly condition?: PropertyCondition;
  readonly uncertainty?: PropertyUncertainty;
  readonly provenance: Provenance;                         // 08: sourceId, locator, accessed, note
  readonly coefficientsSha256: string;                     // TR-PROP-09
  readonly fit?: FitRecord;
  readonly reviewedBy?: { readonly signatureId: string };  // set only through the 09 human gate (FR-PROP-23)
  readonly preferred?: true;
}

// 08 MaterialRecord gains (optional, no migration):  readonly propertyModels?: readonly PropertyModel[];
```

`thermalStrain` models use `unit: '1e-5'` for NIST "(L − L293)/L293 × 10⁵" data: the 08 unit grammar must accept
dimensionless scale units (`1`, `%`, `ppm`, `1e-5`) — an addition to TR-MAT-01 (OQ-PROP-05).

### 3.2 Property catalogue (`model/propertyCatalog.ts`)

```ts
export interface PropertyCatalogEntry {
  readonly name: string; readonly dimension: string;      // dimension vector string of the 08 grammar, e.g. 'M L T^-3 Θ^-1'
  readonly canonicalUnit: string; readonly positive: boolean; readonly ownerPack: string; readonly description: string;
}
export const PROPERTY_CATALOG = [ /* 08 names: density, E, Ec, G, nu, Ftu, Fty, Fcy, Fsu, Fbru, Fbry, elongation, cte, k, cp
   PHY-01 adds: thermalStrain (dimensionless, positive: false), thermalDiffusivity (L² T⁻¹, positive)
   Other packs append their own rows (their TECHNICAL_SPEC §3 lists them). */ ] as const;
export type PropertyName = (typeof PROPERTY_CATALOG)[number]['name'];
```

`positive: true` drives the check `PROP_NONPOSITIVE_IN_RANGE` (k, cp, E, density must be > 0 everywhere in range).

### 3.3 Consumer API (`model/propertyModelEval.ts`) — the contract other packs use

```ts
export type VariableValues = Partial<Record<PropertyVariable, { readonly value: number; readonly unit: string }>>;
export type RangeStatus = 'in_data_range' | 'in_equation_range_only';

export interface PropertyEvaluationOk {
  readonly available: true;
  readonly value: number; readonly unit: string;           // in `outputUnit` if requested, else model unit
  readonly property: PropertyName; readonly materialId: string; readonly modelId: string;
  readonly at: Record<string, { readonly value: number; readonly unit: string; readonly requested: { value: number; unit: string } }>;
  readonly rangeStatus: RangeStatus;
  readonly derivative?: { readonly withRespectTo: PropertyVariable; readonly value: number; readonly unit: string };
  readonly band?: { readonly low: number; readonly high: number; readonly kind: PropertyUncertainty['kind'] };
  readonly basis: Basis; readonly provenance: Provenance; readonly method: string;   // e.g. "log10Polynomial(9) NIST"
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean; readonly warnings: readonly { code: string; message: string }[];
}
export interface PropertyEvaluationRefused {
  readonly available: false; readonly code: string; readonly reason: string; readonly remediation: string;
  readonly validity?: readonly ValidRange[];
  readonly candidates?: readonly { modelId: string; property: string; direction?: string; basis: Basis; validity: readonly ValidRange[] }[];
}
export type PropertyEvaluation = PropertyEvaluationOk | PropertyEvaluationRefused;

export interface PropertyQuery {
  readonly property: PropertyName; readonly direction?: PropertyDirection; readonly basis?: Basis;
  readonly condition?: Partial<PropertyCondition>; readonly modelId?: string;
}
export function resolvePropertyModel(record: MaterialRecord, query: PropertyQuery): PropertyModel | PropertyEvaluationRefused;
export function evaluatePropertyModel(record: MaterialRecord, model: PropertyModel, at: VariableValues,
  options?: { derivative?: PropertyVariable; outputUnit?: string; band?: boolean; forCertification?: boolean }): PropertyEvaluation;
/** Piecewise-linear table for solvers that interpolate linearly (CalculiX). §5.8. */
export function tabulatePropertyModel(model: PropertyModel, variable: PropertyVariable,
  range: readonly [number, number], relTol: number): { points: readonly (readonly [number, number])[]; maxRelError: number };
```

Rules for consumers (normative): PHY-03 builds `*CONDUCTIVITY` / `*SPECIFIC HEAT` tables, PHY-04 `*EXPANSION`, PHY-05
`*ELASTIC` temperature tables, all through `tabulatePropertyModel`, and writes `maxRelError` plus the model ids
and `coefficientsSha256` into the deck header comment. Every consumer result ORs `unverified` and concatenates
`unverifiedReasons` of every evaluation it used (AF-32).

### 3.4 Document version

`propertyModels` is an optional field of the 08 `MaterialRecord`, so the v3 envelope (01 KRN) needs no migration.
08 `MaterialLibrary` files that contain property or material models use `schemaVersion: 2`; readers accept 1 and 2.
`validateMaterialRecord` (08) adds: form well-formed (coefficient count ≤ 9 for `log10Polynomial`, exactly 9 for
`nistRational`), tables strictly increasing, every variable of the form listed in `variables` and `validity`,
`equation ⊇ data`, units parse with the right dimension, unique ids, single preferred per key.

## 4. Commands

All pure, zod `params`, `snake_case`, toolset `materials`, registered in `commands/document/catalog.ts`. Query commands:
`annotations: { readOnly: true }`, same document back, `affected: []`, result in `data`.

| Command | Kind | Params sketch | Tags |
| ------- | ---- | ------------- | ---- |
| `define_property_model` | mutating | `{ material, model: { id, property, unit, variables[], form, validity[], basis, direction?, condition?, uncertainty?, source: { citation, locator?, url?, accessed? }, fit?, preferred? }, replace?: boolean }` | `@affects materialRecords[material].propertyModels` · `@invariant one preferred per key; coefficientsSha256 recomputed, never taken from params; validity required for every variable` · `@failure unknown material → MAT_RECORD_NOT_FOUND; malformed form → PROP_FORM_INVALID; table not increasing → PROP_TABLE_NOT_MONOTONIC; unit dimension wrong → MAT_UNIT_DIMENSION; duplicate id without replace → PROP_MODEL_EXISTS; all no-op` |
| `delete_property_model` | mutating | `{ material, modelId }` | `@affects materialRecords[material].propertyModels` · `@invariant other models untouched` · `@failure unknown id → PROP_MODEL_NOT_FOUND; referenced by a ratioOf model → PROP_MODEL_IN_USE (lists ids)` |
| `evaluate_property` | query | `{ material, property, at: { T?: {value, unit}, strainRate?: …, … }, direction?, basis?, condition?, modelId?, derivative?: variable, outputUnit?, band?: boolean, allowConstant?: boolean, forCertification?: boolean }` | `@invariant never extrapolates; never substitutes a basis; an RT scalar is used for a T-dependent query only with allowConstant:true and is then reported as a named default` · `@failure PROP_OUT_OF_RANGE, PROP_VARIABLE_MISSING, PROP_NO_MODEL_FOR_PROPERTY (with candidates), PROP_CONSTANT_ONLY, PROP_DERIVATIVE_UNAVAILABLE, MAT_LIBRARY_UNRESOLVED` → `data` = `PropertyEvaluation` |
| `sample_property` | query | `{ material, property \| modelId, variable, from: {value, unit}, to: {value, unit}, count?: ≤1000 (default 101), spacing?: 'linear'\|'log', integrate?: boolean, solverTable?: { relTol?: number }, fixed?: VariableValues }` | `@invariant from/to must lie inside the equation range; same rules as evaluate_property` · `@failure PROP_OUT_OF_RANGE, PROP_SAMPLE_TOO_LARGE` → `data { points[], unit, integral?, solverTable?: { points, maxRelError }, defaults[] }` |
| `fit_property_model` | query | `{ data: { variable, variableUnit, valueUnit, rows: [x, y, weight?][] (≤ 10 000) }, form: 'polynomial'\|'log10Polynomial'\|'arrhenius'\|'powerLaw'\|'table1d', degree?, objective?: 'absolute'\|'relative'\|'log10', property, id, basis, dataSource?: {citation, locator?, url?}, maxRelResidual?: number }` | `@invariant does not touch the document; returns a model that define_property_model accepts unchanged; validity = data range of the rows (no equation range is invented)` · `@failure PROP_FIT_INSUFFICIENT_DATA (rows ≤ parameters), PROP_FIT_DATA_INVALID (non-finite, y ≤ 0 for log forms, duplicate x), PROP_FIT_ILL_CONDITIONED (cond > 1e12 after scaling)` → `data { model, fit: FitRecord, warnings[] (PROP_FIT_POOR), defaults[] }` |
| `check_property_models` | query | `{ material?: string[], usedBy?: 'analyses'\|'all', discontinuityTol?: number }` | readiness check (AF-20): `data { status, items: [{ code, severity, ids[], message, remediation }] }` over unverified models in use, missing equation range, conflicts, discontinuities, non-positive values in range, poor fits, unreviewed fits used `forCertification` |

There is no separate import command: models travel inside 08 libraries (`import_material_library`), and
private-library models resolve through 08 `resolve_material_libraries` (session command).

**Describe text (AF-02), `evaluate_property`:** "Evaluate a material property (k, cp, E, cte, thermalStrain …) at an
operating point. Give every variable the model needs with its unit, e.g. at.T = {value: 77, unit: 'K'} or
{value: -196, unit: 'degC'}. Returns value + unit, range status, basis, source and `unverified`. Refuses outside the
model's valid range (PROP_OUT_OF_RANGE) and never extrapolates. Use sample_property for tables, integrals and
solver tables; use check_property_models before handing a result to the owner."

## 5. Algorithms

### 5.1 Forms (normative formulas)

| Form | Value | Derivative d y / d x |
| ---- | ----- | -------------------- |
| `constant` | `c` | 0 |
| `polynomial` | `Σ c_k (x − x0)^k` (Horner) | `Σ k c_k (x − x0)^(k−1)` |
| `log10Polynomial` | `u = log10 x`, `y = 10^(Σ c_k u^k)` | `y · (Σ k c_k u^(k−1)) / x` |
| `nistRational` | `y = 10^(N/D)`, `N = a + c√T + eT + gT^1.5 + iT²`, `D = 1 + b√T + dT + fT^1.5 + hT²` | `y · ln 10 · (N′D − ND′)/D²` |
| `arrhenius` | `A T^m exp(−Q/(R T))`, `R = N_A k_B = 8.31446261815324 J/(mol·K)` (exact) | `y (m/T + Q/(R T²))` |
| `powerLaw` | `c (x/x_ref)^n` | `n y / x` |
| `rateFactor` J-C | `1 + C ln(ε̇/ε̇0)` for ε̇ ≥ ε̇0, else 1 (llull rule, named) | `C/ε̇` |
| `rateFactor` C-S | `1 + (ε̇/D)^(1/q)` | `(1/q)(ε̇/D)^(1/q)/ε̇` |
| `product` | `Π f_i` | product rule |
| `ratioOf` | `base(x) · ratio(x)` (08 percentOfRT: ratio in %, divided by 100) | product rule |

Thermal strain → CTE (FR-PROP-07): with `s(T)` the dimensionless strain `(L − L_ref)/L_ref`,
instantaneous `α(T) = s′(T)/(1 + s(T))`; secant `ᾱ(T_ref→T) = (s(T) − s(T_ref)) / ((T − T_ref)(1 + s(T_ref)))`.
For NIST data `L_ref = L(293 K)`. These are llull derivations, reported as such in `method`.

### 5.2 Tables and piecewise

- **P1.** `points` strictly increasing in x (else `PROP_TABLE_NOT_MONOTONIC`); ≥ 2 points; `loglog` and `loglinear`
  need y > 0; `loglog` needs x > 0.
- Interpolation between bracketing points `(x0, y0)`, `(x1, y1)`, `t = (x − x0)/(x1 − x0)`:
  `linear` y0 + t(y1 − y0); `loglinear` exp(ln y0 + t (ln y1 − ln y0)); `loglog` same with `t` computed on ln x;
  `step` y0 (value of the left point, last point at x = x_max).
- **P2.** Piecewise: segment k covers `(upTo_{k−1}, upTo_k]`, the first starts at the validity minimum; at a shared
  breakpoint the **left** segment applies. Discontinuity measure at each breakpoint
  `|f_right(b) − f_left(b)| / max(|f_left(b)|, tiny)`; above the named tolerance (default 1e-3) the check reports
  `PROP_DISCONTINUITY` (warning).
- `table2d` bilinear on (x or log10 x, y or log10 y) per the axis flags; both axes strictly increasing.

### 5.3 Range guard

For each variable `v` of the model: convert the requested value to the model unit, then

```
if v < equation.min − ε or v > equation.max + ε      → refuse PROP_OUT_OF_RANGE (validity in data)
elif v < data.min − ε or v > data.max + ε            → evaluate; rangeStatus 'in_equation_range_only';
                                                       warning PROP_OUTSIDE_DATA_RANGE; unverified reason 'outside data range'
else                                                 → 'in_data_range'
ε = 1e-12 · max(1, |bound|)   (absorbs unit-conversion rounding only)
```

A model with no `equation` range has `equation = data`. A missing variable gives `PROP_VARIABLE_MISSING` (the
model's variable list is returned). Evaluation of a `product` checks every factor's ranges.

### 5.4 Fitting (`fit_property_model`, V1)

1. Validate rows (finite, weights > 0, unique x, y > 0 for log forms). Rows ≤ parameters → `PROP_FIT_INSUFFICIENT_DATA`.
2. Linearise: `polynomial` (y vs x), `log10Polynomial` (log10 y vs log10 x), `arrhenius` with fixed m
   (ln y − m ln T vs [1, −1/(R T)]), `powerLaw` (ln y vs ln x). Objective `log10`/`relative` weight the residual as
   stated; default objective is the one the form linearises (named default).
3. Scale the abscissa to [−1, 1] (`u = (2x − (a + b))/(b − a)`), build the Vandermonde-type matrix, solve by
   Householder QR with column pivoting off (deterministic order); back-transform coefficients to the unscaled
   basis. Condition number estimate from R; > 1e12 → `PROP_FIT_ILL_CONDITIONED`.
4. Residuals on the **original** y: RMS, max |r|, max |r/y|, R². `maxRel > maxRelResidual` (default 0.05) →
   warning `PROP_FIT_POOR`.
5. Output model: `validity.data` = [min x, max x], no `equation` range; `basis` as given (default `unspecified`,
   named); `fit` record with `datasetSha256`; `unverified` until `dataSource` is given and a reviewer accepts.

VC-PROP-13 checks the algorithm against an exact rational solution (the generator solves the normal equations in
`fractions.Fraction`): refit values within 1e-8 relative, coefficients within 1e-5 absolute.

### 5.5 Uncertainty bands

`relative r` ⇒ band `[y(1 − r), y(1 + r)]`; `absolute a` ⇒ `[y − a, y + a]`. The band carries `kind`. A
`fitErrorVsData` band is never labelled as a confidence interval; `statistical` bands report `coverage`. No
propagation through analyses in MVP (V2 with PHY-18).

### 5.6 Provenance hash and conflicts

`coefficientsSha256 = sha256(canonicalJson(form))` with sorted keys and shortest round-trip number formatting
(the same canonical JSON as 05 TR-FEA-06). Two models in loaded records with equal `provenance.sourceId` and
`locator`, same `property`, `direction` and `condition`, but different hashes → `PROP_SOURCE_CONFLICT` (warning)
with the maximum relative difference of their values over the common range (sampled at 101 points). Example:
the two Invar transcriptions differ by 8.1e-7 in strain at 300 K (VC-PROP-09).

### 5.7 Unverified and review flags

`unverified = basis ∈ {typical, supplier_unstated, unspecified}` ∨ 08 source status not verified ∨
`rangeStatus = 'in_equation_range_only'` ∨ (`fit` present ∧ (`fit.dataProvenance` absent ∨ `reviewedBy` absent)) ∨
private library unresolved (then no value at all). `reviewRequired = forCertification` ∨ the property is a strength
(`Ftu`, `Fty`, … per 08) ∨ (`fit` present ∧ `reviewedBy` absent). `forCertification: true` refuses unverified
models with `MAT_VALUE_UNVERIFIED` (08 semantics).

### 5.8 Sampling, integral, solver table

- Sampling: `count` points, `linear` or `log` spacing (log requires from > 0), endpoints included.
- Integral ∫ y dx: adaptive Gauss-Legendre (7/15-point Gauss-Kronrod) on each smooth segment (table intervals and
  piecewise segments split exactly), relative tolerance 1e-10. VC-PROP-20 compares with a converged Simpson
  reference (304 SS k, 4–300 K: 3 030.84358308 W/m).
- Solver table: start from range ends and all breakpoints; bisect any interval whose midpoint linear-interpolation
  error (and the error at 1/4, 3/4) exceeds `relTol · |y|` (default 1e-3, named); in log space for log forms, emitted
  in linear x. Returns `maxRelError` measured on a 10× finer grid. Cap 500 points (`PROP_SAMPLE_TOO_LARGE`).

### 5.9 Named defaults (AF-31)

| Default | Value | Source / reason |
| ------- | ----- | --------------- |
| Discontinuity tolerance | 1e-3 relative | llull choice (OQ-PROP-06) |
| Solver-table interpolation error | 1e-3 relative | llull choice; below the 0.5 % best NIST fit error |
| Fit quality threshold `maxRelResidual` | 0.05 | llull choice; equals the NIST cp fit error (5 %) |
| `sample_property` count | 101 | llull choice |
| J-C rate factor below the reference rate | 1 (no softening) | llull rule (common practice; OQ-PROP-08) |
| `fit_property_model` basis when not given | `unspecified` (⇒ unverified) | 08 FR-MAT-25 |

Every default used appears in `data.defaults[]` as `{ name, value, source, defaulted: true }`.

### 5.10 Numerical tolerances

| Quantity | Tolerance |
| -------- | --------- |
| Form evaluation vs generator | rel 1e-9 (double precision; log10/exp chains) |
| Unit conversion | rel 1e-12 (08) |
| Table interpolation | rel 1e-12 |
| Fit (exact data) | values rel 1e-8, coefficients abs 1e-5 |
| Integral | rel 1e-8 |

## 6. Interop & persistence

| Artefact | Format | Notes |
| -------- | ------ | ----- |
| Library file `*.llull-matlib.json` | 08 `MaterialLibrary`, `schemaVersion: 2`, records may hold `propertyModels` | JSON Schema generated from zod and published in `docs/schemas/` |
| Seed NIST library (V1) | `packages/core/data/seed-nist-cryogenic.llull-matlib.json` (or `@phys` data, OQ-PROP-07) | Licence `public-domain-us-gov`; each model with page URL, access date, range, fit error; primary pinned in `sources.lock.json` (08 TR-MAT-41) |
| Solver decks | CalculiX `*CONDUCTIVITY`, `*SPECIFIC HEAT`, `*EXPANSION`, `*ELASTIC` temperature rows (PHY-03/04/05) | Built by `tabulatePropertyModel`; header comment `** llull property <material>/<modelId> sha256=<h> maxRelError=<e>` |
| CSV export (`sample_property --save`) | `x,y[,derivative]` with a `# unit` header | Through the existing `--save` host path (AF-12) |

## 7. CLI / MCP / UI surfaces

- **CLI:** no new verbs; `llull <command> …`, `llull run plan.json`. `llull guide` gains a "property models"
  section: units, range status meaning, fit-error vs uncertainty, the minimal plan (AF-03).
- **MCP:** toolset `materials` (08) gains the six commands; read-only hints on queries.
- **UI:** review only (FUNCTIONAL_SPEC §6.3), drawn from `sample_property` data.

### 7.1 Stable error and check codes (AF-11)

Exit code 1 on every refusal; `data.code`, `data.ids` or `data.path`, and `data.remediation` are always set. Shared
08 codes (`MAT_UNIT_INVALID`, `MAT_UNIT_DIMENSION`, `MAT_RECORD_NOT_FOUND`, `MAT_PROVENANCE_MISSING`,
`MAT_PREFERRED_CONFLICT`, `MAT_VALUE_UNVERIFIED`, `MAT_LIBRARY_UNRESOLVED`, `MAT_HUMAN_GATE`) keep their meaning.

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `PROP_MODEL_NOT_FOUND` | error | unknown `modelId` | material, modelId | `get_material` lists model ids |
| `PROP_MODEL_EXISTS` | error | duplicate id without `replace` | material, modelId | pass `replace: true` or a new id |
| `PROP_MODEL_IN_USE` | error | removing a base of a `ratioOf` model | dependent model ids | remove or re-base the dependants first |
| `PROP_NO_MODEL_FOR_PROPERTY` | error | no model or value for (property, direction, basis, condition) | query, `candidates[]` | pick a candidate explicitly or define a sourced model |
| `PROP_CONSTANT_ONLY` | error | only an RT scalar exists and a variable value was given | material, property | define a T-dependent model, or pass `allowConstant: true` (named default in the result) |
| `PROP_VARIABLE_MISSING` | error | a variable the model needs is absent | `at.<variable>` | give it with a unit |
| `PROP_OUT_OF_RANGE` | error | outside the equation range | variable, value, `validity` | stay in range or define a model sourced for that range; llull never extrapolates |
| `PROP_OUTSIDE_DATA_RANGE` | warning | inside equation range, outside data range | variable, value | prefer a model with data at this point; result is `unverified` |
| `PROP_FORM_INVALID` | error | wrong coefficient count, missing field, empty table | `model.form.<path>` | follow the form definition in `llull describe define_property_model` |
| `PROP_TABLE_NOT_MONOTONIC` | error | table x not strictly increasing, or log mode with y ≤ 0 | `model.form.points[i]` | sort / fix the table, or choose a linear mode |
| `PROP_RANGE_INVALID` | error | equation range does not contain the data range, min ≥ max, or a variable without range | `model.validity[i]` | give data ⊆ equation ranges for every variable |
| `PROP_NONFINITE` | error | evaluation overflow / NaN inside the range | model, point | the model is malformed in this range; check coefficients against the source |
| `PROP_NONPOSITIVE_IN_RANGE` | error (check) | a positive-only property (catalogue) ≤ 0 somewhere in range | model, first offending x | correct the coefficients or narrow the range |
| `PROP_DISCONTINUITY` | warning (check) | piecewise jump above tolerance | model, breakpoint, relative jump | confirm with the source; smooth or accept explicitly |
| `PROP_SOURCE_CONFLICT` | warning (check) | same source + locator, different coefficients | both model ids, max rel diff | re-read the primary source; keep one, mark it preferred |
| `PROP_DERIVATIVE_UNAVAILABLE` | error | derivative of a `step` table | model | use a continuous interpolation mode |
| `PROP_SAMPLE_TOO_LARGE` | error | count > 1000 or solver table > 500 points | param | narrow the range or relax `relTol` |
| `PROP_FIT_INSUFFICIENT_DATA` | error | rows ≤ number of parameters | `data.rows` | add points or lower the degree |
| `PROP_FIT_DATA_INVALID` | error | non-finite rows, duplicate x, y ≤ 0 for log forms | `data.rows[i]` | clean the data or choose another form |
| `PROP_FIT_ILL_CONDITIONED` | error | condition number > 1e12 after scaling | form, degree | lower the degree or narrow the range |
| `PROP_FIT_POOR` | warning | max relative residual > threshold | residual stats | try another form or degree; do not use for design without review |
| `PROP_FIT_UNREVIEWED` | warning (check) | a fitted model used `forCertification` without reviewer acceptance | model id | ask a qualified reviewer (human gate) |
| `PROP_UNCERTAINTY_KIND` | warning (check) | a consumer used a `fitErrorVsData` band as a confidence bound | consumer, model | treat it as fit quality only |

### 7.2 Agent-first compliance

| AF | Where satisfied |
| -- | --------------- |
| AF-01, 02, 03 | Registry commands (§4), agent-written descriptions with units and next command, `llull guide` section |
| AF-04 | Every variable `{ value, unit }`; models carry units; no inference |
| AF-05 | `validation/plans/*.json` single plans; `--validate` checks forms and ranges before evaluation |
| AF-10 | `PropertyEvaluation` shape (§3.3), units on every number |
| AF-11 | §7.1 |
| AF-12 | `sample_property` bounded; CSV via `--save` |
| AF-13 | Deterministic formulas, QR without pivot randomness, canonical hashes |
| AF-20 | `check_property_models` (+ items in 08 `check_materials`) |
| AF-21 | `sample_property` gives the numbers behind the chart |
| AF-23 | Validation harness in `validation/README.md` |
| AF-30 | Range rules, catalogue positivity, conflict rule held as data and code, not agent knowledge |
| AF-31 | §5.9 |
| AF-32, 33 | §5.7 |
| AF-34 | Reviewer acceptance of fitted models via 09 signing (`reviewedBy`) |
| AF-35 | `method`, `provenance`, `coefficientsSha256`, `fit` in every result |
| AF-36 | Summary: value, source, range status, unverified, review need — in that order |
| AF-40, 41 | Sub-millisecond queries; offline |
| AF-42 | `--dry-run` on define/remove |

## 8. Performance & robustness budgets

| Operation | Budget (desktop) |
| --------- | ---------------- |
| `evaluate_property`, one point | ≤ 1 ms |
| `sample_property` 1 000 points + integral | ≤ 20 ms |
| Solver table (log-polynomial 4–300 K, 1e-3) | ≤ 10 ms, ≤ 60 points |
| `fit_property_model`, 10 000 rows, 9 parameters | ≤ 50 ms |
| `check_property_models`, 200 models | ≤ 200 ms |

Robustness: every failure is a refusal with code and remediation; no exception escapes `run` (the `execute` wrapper
also catches); evaluation never returns NaN or ±∞ (`PROP_NONFINITE`).

## 9. Test strategy (→ VC ids in validation/README.md)

| Level | Location | Covers |
| ----- | -------- | ------ |
| Unit (model) | `tests/unit/materials/propertyModelEval.test.ts` | Forms and derivatives VC-PROP-01…07, 10–12; range guard VC-PROP-08; tables VC-PROP-11; units VC-PROP-16, all driven by `validation/expected_results.json` |
| Unit (commands) | `tests/unit/materials/propertyModels.test.ts` | define/remove happy + failure, `is pure`, preferred uniqueness, codes VC-PROP-19, adapter VC-PROP-17 |
| Unit (fit) | `tests/unit/materials/fitPropertyModel.test.ts` | VC-PROP-13, 14; ill-conditioning; insufficient data |
| Unit (check) | `tests/unit/materials/checkPropertyModels.test.ts` | Discontinuity and conflict VC-PROP-09, unverified VC-PROP-18 |
| Contract | `tests/unit/contract/` | Toolset membership, `toToolSchemas()` snapshot, persistence round trip of `propertyModels`, private-library non-serialization (08 VC-MAT-14 extended) |
| Golden | `tests/golden/plans.ts` | `cryo_6061_k_proposed` plan: id-normalized document + replay equality |
| Quality gate | `npm run quality` | `python3 -I validation/generate_prop_reference.py --check` |
| Agent harness | CLI script (AF-23) | Every case of `expected_results.json` via `--json` and exit codes |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 Types + evaluator | `propertyModel.ts`, `propertyCatalog.ts`, `propertyModelEval.ts` (forms, ranges, derivatives, units), unit-grammar scale units | 08 M1–M2 (`lib/quantity.ts`, `MaterialRecord`) | 4 d |
| M2 Commands | define/remove/evaluate/sample/check, adapter for 08 tables, persistence validation, toolset | M1 | 4 d |
| M3 Multi-variable | product, table2d, rate factors, ratioOf | M1 | 2 d |
| M4 Fit | `lib/leastSquares.ts` (scaled QR), `fit_property_model` | M1 | 3 d |
| M5 Solver tabulation + integral | `tabulatePropertyModel`, Gauss-Kronrod | M1 | 2 d |
| M6 Seed NIST library | re-read primary pages, pin sha256, ranges and errors, ship | M2; network access to trc.nist.gov | 2 d |

MVP (M1, M2) ≈ 8 d; V1 (M3–M6) ≈ 9 d. Consumers: PHY-02 needs M1; PHY-03/04/05 need M5.

## 11. Open questions / decisions needed

| Id | Question | Proposed default |
| -- | -------- | ---------------- |
| OQ-PROP-01 | Should evaluation be allowed between the data range and the equation range at all? | Yes, with warning + `unverified` (NIST explicitly gives the equation range) |
| OQ-PROP-02 | Should any user-controlled extrapolation exist (cryoheatflow offers an explicit, warned power-law extension)? | No in MVP; a user defines a wider model with its own source |
| OQ-PROP-03 | NIST pages could not be fetched; when can the seed library be built? | M6 needs one session with access; until then coefficients live in `validation/` only |
| OQ-PROP-04 | Equation ranges conflict between transcriptions (6061 E, G-10 k) | Mark TBD; seed library takes the primary page value |
| OQ-PROP-05 | Unit grammar: add dimensionless scale units (`1e-5`, `ppm`) to 08 `lib/quantity.ts` | Yes (small 08 addition) |
| OQ-PROP-06 | Discontinuity tolerance default 1e-3 — right? (304 E jump is 1.7e-4) | Keep; configurable per check |
| OQ-PROP-07 | Seed data location: `packages/core/data` or the `@phys` plugin | `@phys` data folder (keeps core lean); records still core types |
| OQ-PROP-08 | J-C rate factor below ε̇0: 1 (clamp) or allow < 1? | Clamp to 1 (named); PHY-19 may override with its own law |
| OQ-PROP-09 | Should `fit_property_model` move to the `@phys` plugin with PHY-02 fits? | Keep in core (small, linear only); non-linear LM lives in `@phys` (PHY-02) |
| OQ-PROP-10 | Uncertainty propagation into analyses | Defer to PHY-18 |

## 12. References

See FUNCTIONAL_SPEC §11 [R1]–[R15] and `validation/sources.md` [S1]–[S9]. Additionally:

- [T1] llull command layer — `.claude/context/command-layer.md`; `packages/core/src/commands/inspect/measureSolid.ts`; `packages/core/src/commands/document/materials.ts`; `packages/core/src/model/types.ts`
- [T2] 08 MAT TECHNICAL_SPEC §3.1 (`MaterialRecord`, `PropertyValue`, `TemperatureDependence`), §5.1 (units), §5.5 (temperature interpolation), §7.1 (MAT codes) — `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`
- [T3] 05 FEA TECHNICAL_SPEC TR-FEA-04/06/07 (materials view, canonical hash, unit systems) — `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`

## 13. Implementation status (2026-10-16)

**Built: M1–M5** (types, catalogue, evaluator, commands, multi-variable forms, fit, tabulation + integral). `npm run quality:physics`
judges 81 VC-PROP cases through `tests/unit/physics/` (VC-PROP-01…20 values, VC-PROP-08 statuses, VC-PROP-18/19 behaviour): all pass.
VC-PROP-21 (solver table ≤ 60 points, `maxRelError` ≤ 1e-3) is a unit test.

| Item | Where |
| ---- | ----- |
| Types, catalogue | `packages/core/src/model/propertyModel.ts`, `model/propertyCatalog.ts` |
| Forms §5.1–5.2, range guard §5.3, consumer API §3.3 | `model/propertyForms.ts`, `model/propertyModelEval.ts` |
| Sampling, integral, solver table §5.8 | `model/propertyTabulate.ts` (adaptive Gauss-Kronrod 7/15) |
| Well-formedness §3.4 | `model/propertyModelValidate.ts`; load-time check in `commands/persistence/guards.ts` (also re-verifies `coefficientsSha256`) |
| Least squares, SHA-256 | `lib/leastSquares.ts` (Householder QR, equilibrated columns), `lib/sha256.ts` (FIPS 180-4, pure) |
| Six commands §4 | `commands/document/{propertyModels,propertyQueries,fitPropertyModel,checkPropertyModels}.ts`, toolset `materials` |

**Deviations (08 MAT is not built, so this pack carries a minimal bridge):**

- Models hang off the document **`Material`** (`Material.propertyModels`), the material id is the `create_material` name, and
  `create_material` keeps a material's models when it replaces it. `Basis` and a minimal `Provenance` (citation or sourceId, locator,
  url, accessed, note) live in `propertyModel.ts` until 08 provides them. The only scalar value is `Material.density`, so
  `PROP_CONSTANT_ONLY` / `allowConstant` apply to `density`. The 08 source status is unknown, so `unverified` follows the basis,
  range and fit rules of §5.7 only.
- TR-PROP-07 (08 `PropertyValue` adapter) has nothing to adapt yet; an 08 percent-of-RT table is a `ratioOf` model (VC-PROP-17 proves
  the arithmetic). TR-PROP-15 / VC-PROP-22 (private libraries) and library `schemaVersion: 2` wait for 08 libraries.
- `cte` queries with no `cte` model derive the instantaneous CTE from the preferred `thermalStrain` model (`method` says so).
- New codes: `PROP_PROPERTY_UNKNOWN` (property not in the catalogue) and `PROP_EQUATION_RANGE_MISSING` (info, check).
- Parameter shapes kept flat for the MCP schema rules: `at` / `fixed` / `condition` are maps validated in `run` (condition keys
  strictly), and `sample_property` takes `solverTable: true` + `solverTableRelTol`.
- `fit_property_model`: `powerLaw` fits use `reference = 1` (in the variable unit); `degree` defaults to 3 (named default).
- Refusals carry `error { code, paths, remediation }` and `data` = the refusal (`PropertyEvaluationRefused`).

**Validation pack fix:** VC-PROP-12 rate-factor cases had `rel 1e-12` while their values are stored to 12 significant digits (rounding
alone reaches 3.9e-12); the generator now writes `rel 1e-11` for those two cases (regenerated, no other change).

**Not built:** M6 seed NIST library (OQ-PROP-03, needs access to trc.nist.gov); VC-PROP-23 budgets are not measured; the
`llull guide` section.

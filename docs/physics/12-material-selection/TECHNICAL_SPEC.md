# PHY-12 — Material selection & substitution — Technical spec

Gap id **SEL** · Status: specification (no implementation) · Written 2026-10-15
Functional: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

---

## 1. Current state in llull

Verified against the repository on 2026-10-15 (today's code) and the aerospace packs (baseline, built first).

| Area | File(s) | Today / after aerospace | Limit for selection |
| ---- | ------- | ----------------------- | ------------------- |
| Material (today) | `packages/core/src/model/types.ts` `Material { name, density, color, metalness, roughness, finish? }`; `finish` is a **procedural render texture** (`MaterialFinish`: carbon_twill, brushed …) | one density in g/(doc unit)³ | no E, strength, basis |
| Material commands (today) | `packages/core/src/commands/document/materials.ts` `create_material`, `assign_material` (sets `BaseEntity.materialId`) | `assign_material` is the only way to change a part's material | is also the apply step of a substitution (FR-SEL-16) |
| Mass (today) | `commands/inspect/measureSolid.ts` `mass_properties` (+ `solidVolume.ts`) | volume × density, instances resolve own → instance → param density | what-if needs the same path with another density |
| BOM (today) | `commands/assembly/billOfMaterials.ts` | counts instances per component | no material rows (08 adds them) |
| Material record (08 MAT) | `model/material.ts` `MaterialRecord`, `PropertyValue { property: MaterialPropertyName, quantity, basis, direction, temperature, provenance, preferred }`; `MaterialPropertyName` = density, E, Ec, G, nu, Ftu, Fty, Fcy, Fsu, Fbru, Fbry, elongation, cte, k, cp | basis + provenance + `unverified` (TR-MAT-50) | the input of every SEL query |
| Property models (PHY-01) | `model/propertyModel.ts` (owned by PHY-01) | `f(T, …)` with valid range and refusal | operating-temperature selection |
| FEA (05) | `@cae` (`packages/domain-cae`), `FeaMaterialView`, `compute_margins` (§5.8), staleness hash TR-FEA-06 | margins per part with basis and `unverified` | material change ⇒ results stale |
| Composites (06) | `LaminaMaterial`, CLT ABD, quasi-isotropic effective properties | in-plane laminate constants | not a scalar isotropic material |
| PLM (09) | `release_item`, `revise_item`, `create_change_order` (classification human-gated) | released definitions locked | applying a substitution to a released part |

No command today ranks materials, computes an index or runs a material what-if (`grep -rliw "ashby\|performance index\|compare_materials" packages src server/src` finds nothing).

## 2. Target architecture

### 2.1 Layer placement (proposal, pending README §5.1)

| Concern | Layer | Why |
| ------- | ----- | --- |
| New scalar property names `pricePerMass`, `embodiedCarbon`, `maxServiceTemperature` | **Addition to the 08 MAT `MaterialPropertyName` list** (`model/material.ts`, owned by 08); each a `PropertyValue` with unit, basis, provenance | No pack defines material data except 08/PHY-01/PHY-02 (README §6.2) |
| Index rule table (data, AF-30) and evaluation | `packages/domain-physics/src/selection/indexRules.ts`, `indices.ts` (pure) | Domain capability ⇒ plugin (L10) |
| Ranking, constraints, Pareto | `@phys/selection/rank.ts` (pure) | same |
| Commands | `@phys/selection/commands/*.ts`, `CadPlugin { name: 'selection', toolset: 'selection', commands }` | one plugin per discipline (README §6.2) |
| Mass in the what-if | reuse core `mass_properties` through `ctx.registry` + `execute` on a **virtual** document copy (`assign_material` applied in memory, never returned) | L10: a plugin composes core commands via `execute`; purity (L3) |
| Margins in the what-if | read 05 `compute_margins` data via `execute`; re-scale in `@phys/selection/marginRescale.ts`; re-solve plan as data | 05 owns the analysis stack (README §6.2: extend, do not duplicate) |
| Composition | `src/app/plugins.ts` `installPlugin(selectionPlugin)` | composition root |

Dependencies: `@phys → @core` public API only (`model`, `lib`, `commands/{schema,types,noop,registry}`); reads 08 records
from `doc.materialRecords`, 05 results through registry commands (no `@cae` import needed: data shapes are
read through `execute` results; a shared type import from `@cae` would need an arch rule and is avoided).

### 2.2 Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-SEL-01 | MUST | `indexRules.ts` exports `INDEX_RULES: readonly IndexRule[]` (§3.1), one per case of `validation/performance_indices.csv`, each with `source` and `derivation` strings; a unit test asserts the table equals the CSV | FR-SEL-01 |
| TR-SEL-02 | MUST | Property resolution goes through the 08 resolver (preferred `PropertyValue`, direction, thickness, temperature) and returns the value converted to the index base units (§5.1) with its basis, provenance and `unverified` | FR-SEL-02, 11 |
| TR-SEL-03 | MUST | Index value `P^n / ρ` computed in base units (E in GPa, σ in MPa, ρ in Mg/m³); the unit string is generated from the exponents (`GPa^(1/2)/(Mg/m^3)`) | FR-SEL-01, 02 |
| TR-SEL-04 | MUST | Strength property for strength indices is explicit (`strengthProperty: 'Fty' \| 'Ftu' \| 'Fcy'`), no default (AF-31) | FR-SEL-02 |
| TR-SEL-05 | MUST | Ranking: descending score, tie-break ascending material id; NaN never produced (missing ⇒ excluded) | FR-SEL-03, 10 |
| TR-SEL-06 | MUST | Constraint evaluation with unit conversion through `lib/quantity.ts` (08 TR-MAT-01); missing property ⇒ `missing`, not pass/fail | FR-SEL-04 |
| TR-SEL-07 | SHOULD | Pareto set by pairwise dominance (all objectives minimised after sign normalisation), O(N²·k), N ≤ 5,000 | FR-SEL-05 |
| TR-SEL-08 | MUST | `substitute_material` design-rule ratios exactly as §5.3; mass before/after by `mass_properties` on the real and the virtual document | FR-SEL-07 |
| TR-SEL-09 | MUST | Margin re-scaling only when every condition of §5.4 holds; otherwise `SEL_MARGINS_NEED_RESOLVE` + `resolvePlan` | FR-SEL-08, 09 |
| TR-SEL-10 | MUST | Basis set of each comparison is collected; >1 basis ⇒ `SEL_BASIS_MIXED` warning | FR-SEL-12 |
| TR-SEL-11 | SHOULD | Temperature: when `temperature` is given, properties are evaluated with PHY-01 `PropertyModel`; out-of-range codes from PHY-01 are forwarded unchanged in `excluded[]` | FR-SEL-13 |
| TR-SEL-12 | MUST | Composite candidates name a 06 layup (`layup: { part, zone? }` or laminate id); E and ν come from 06 effective in-plane constants; `SEL_ANISOTROPIC` warning always set | FR-SEL-15 |
| TR-SEL-13 | MUST | All SEL commands `annotations: { readOnly: true, idempotent: true }`; same document reference back; `affected: []` | FR-SEL-16, L3 |
| TR-SEL-14 | SHOULD | `material_chart_data` returns points in base units and guide lines (slope 1/n on log P vs log ρ) | FR-SEL-18 |
| TR-SEL-15 | COULD | User index: exponents vector + `derivationNote` (non-empty string, stored in `data.provenance`) | FR-SEL-06 |
| TR-SEL-20 | MUST | Error/check codes of §7.1; every result has `unverified`, `unverifiedReasons[]`, `provenance`, and (margins) `reviewRequired` | FR-SEL-10, 11, 19 |

## 3. Data model

### 3.1 Rule table (plugin data)

```ts
export type IndexCase = 'tie_stiffness' | 'tie_strength' | 'beam_stiffness' | 'beam_strength'
  | 'panel_stiffness' | 'panel_strength' | 'column_buckling';
export interface IndexRule {
  readonly case: IndexCase;
  readonly property: 'E' | 'strength';           // 'strength' resolved by strengthProperty
  readonly exponent: { readonly num: number; readonly den: number };   // 1/2 stored exactly
  readonly freeVariable: string;                  // "section side b", "thickness t"
  readonly constraint: string;                    // "S = C E b^4 / (12 L^3)"
  readonly derivation: string;                    // "m = rho L b^2, b ~ E^(-1/4)"
  readonly source: string;                        // "Ashby, ASM Handbook vol. 20 (R1); validation/performance_indices.csv"
}
```

### 3.2 Results

```ts
export interface PropertyUse {
  readonly property: string; readonly value: number; readonly unit: string;   // base unit after conversion
  readonly basis: string; readonly propertyValueId: string; readonly provenance: string;
  readonly temperature?: { readonly value: number; readonly unit: string };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
}
export interface IndexResult {
  readonly material: string; readonly case: IndexCase | 'user';
  readonly value: number; readonly unit: string; readonly inputs: readonly PropertyUse[];
  readonly unverified: boolean; readonly warnings: readonly SelIssue[];
}
export interface CompareResult {
  readonly ranked: readonly { readonly material: string; readonly rank: number; readonly score: number;
    readonly objectives: readonly IndexResult[] }[];
  readonly failed: readonly { readonly material: string; readonly constraint: string; readonly value: number; readonly unit: string }[];
  readonly excluded: readonly { readonly material: string; readonly code: string; readonly missing?: readonly string[] }[];
  readonly pareto?: readonly string[];
  readonly weights: { readonly value: readonly number[]; readonly defaulted: boolean };
  readonly basesUsed: readonly string[]; readonly unverified: boolean;
}
export type DesignRule = 'same_geometry' | 'equal_stiffness_tie' | 'equal_stiffness_beam' | 'equal_stiffness_panel'
  | 'equal_strength_tie' | 'equal_strength_beam' | 'equal_strength_panel';
export interface SubstitutionResult {
  readonly entityIds: readonly string[]; readonly from: string; readonly to: string; readonly designRule: DesignRule;
  readonly mass: { readonly beforeG: number; readonly afterG: number; readonly ratio: number; readonly method: 'same_geometry' | 'index_rule' };
  readonly stiffness?: { readonly ratio: number; readonly deflectionRatio: number; readonly modalFrequencyRatio?: number; readonly bucklingFactorRatio?: number };
  readonly margins?: { readonly method: 'rescaled'; readonly rows: readonly RescaledMargin[] }
    | { readonly code: 'SEL_MARGINS_NEED_RESOLVE'; readonly failedConditions: readonly MarginCondition[]; readonly resolvePlan: readonly PlanStep[] }
    | { readonly code: 'SEL_NO_ANALYSIS' };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[]; readonly reviewRequired: boolean;
}
export type MarginCondition = 'single_material' | 'same_poisson' | 'no_body_force' | 'no_thermal_load'
  | 'no_prescribed_displacement' | 'same_allowable_basis' | 'results_current';
```

No document slice is added: SEL is read-only. Studies are saved with `--save` (AF-12); a saved study carries
the `documentHash`, library ids/versions/hashes and the generator-equivalent inputs so it can be re-run.

### 3.3 08 property-name additions (owned by 08 MAT)

| Property | Unit dimension | Basis allowed | Notes |
| -------- | -------------- | ------------- | ----- |
| `pricePerMass` | currency / mass (`EUR/kg`, `USD/lb`); currency is a unit atom, no FX conversion | `supplier_unstated`, `company` | requires `provenance.accessed` (prices date) |
| `embodiedCarbon` | mass CO₂e / mass (`kg/kg`) + `boundary: 'cradle_to_gate' \| 'cradle_to_grave'` qualifier | `typical`, `company` | licence flag mandatory (ICE: Tools and Integration Licence) |
| `maxServiceTemperature` | temperature | `typical`, `company`, `supplier_unstated` | constraint use only |

## 4. Commands (plugin `selection`, toolset `selection`)

| Command | Kind | Params sketch | Tags |
| ------- | ---- | ------------- | ---- |
| `material_index` | query | `{ materials: string[], indices: IndexCase[], strengthProperty?: 'Fty'\|'Ftu'\|'Fcy', direction?: 'L'\|'LT'\|'ST', thickness?: {value,unit}, temperature?: {value,unit}, layups?: Record<material, {laminateId}> }` | `@affects none; data = { results: IndexResult[] }` `@invariant same doc back; values in base units with unit strings` `@failure unknown material → SEL_MATERIAL_NOT_FOUND; strength index without strengthProperty → SEL_STRENGTH_PROPERTY_UNSET; missing property → result in excluded[] (SEL_PROPERTY_MISSING)` |
| `compare_materials` | query | `{ materials: string[] \| { library: string }, objectives: { index: IndexCase \| 'user', weight?: number, strengthProperty?, exponents?, derivationNote?, minimise?: 'mass'\|'cost'\|'co2' }[], constraints?: { property, min?: {value,unit}, max?: {value,unit} }[], pareto?: boolean, missing?: 'report' (only value), temperature? }` | `@affects none; data = CompareResult` `@invariant deterministic order; weights sum normalised; no imputation` `@failure 0 objectives → SEL_NO_OBJECTIVE; negative weight → SEL_WEIGHT_INVALID; all candidates excluded → data with empty ranked + exit 0 and warning SEL_NO_CANDIDATE` |
| `substitute_material` | query (composes `mass_properties`, 05 `compute_margins` via `execute`) | `{ entityIds: string[], from: string, to: string, designRule: DesignRule, strengthProperty?, include?: ('mass'\|'stiffness'\|'margins')[], analysisId?: string, nuTolerance?: number }` | `@affects none (virtual copy only); data = SubstitutionResult` `@invariant input document unchanged (is pure test); mass via the core mass path` `@failure entity without `from` material → SEL_MATERIAL_NOT_ASSIGNED; to-material missing E/ρ for the rule → SEL_PROPERTY_MISSING; designRule omitted → SEL_DESIGN_RULE_UNSET` |
| `material_chart_data` | query | `{ materials, x: {property \| index}, y: {property \| index}, guides?: IndexCase[] }` | `@affects none; data = { points[], guides[{case, slope}] , units }` |
| `check_material_selection` | query (AF-20) | `{ entityIds?: string[], studyFile?: never }` (works on the document: assigned materials, 05 staleness, 09 state) | `@affects none; data = { status, items: [{code, severity, ids, message, remediation}] }` |

Applying a choice: 08 `assign_material` (core, mutating). SEL adds no mutating command (FR-SEL-16).

## 5. Algorithms

### 5.1 Units

Base units for indices: E in GPa, strength in MPa, density in Mg/m³ (= g/cm³). Ranking is invariant to a
consistent unit change (indices of all candidates scale by the same factor), but the reported value and its
unit string are fixed so runs diff cleanly (AF-13). Conversions use 08 `lib/quantity.ts` exact factors
(1 lb = 453.59237 g, 1 in = 25.4 mm, 1 ksi = 6.894757293168 MPa).

### 5.2 Index derivation (rule table rows)

For each case: write mass `m = ρ·V(x)` with free variable x, write the constraint `g(P, x) = target`, solve for
x, substitute. Examples (S, F, M = targets; L, w fixed; C, n constants):

- Tie, stiffness: S = E A/L ⇒ A = S L/E ⇒ m = ρ L² S/E ⇒ maximise **E/ρ**.
- Beam, square section b, stiffness: S = C E b⁴/(12 L³) ⇒ b = (12 S L³/(C E))^¼ ⇒ m = ρ L b² ∝ ρ/E^½ ⇒ **E^½/ρ**.
- Beam, strength: M = σf b³/6 ⇒ b ∝ σf^(−⅓) ⇒ m ∝ ρ/σf^⅔ ⇒ **σf^⅔/ρ**.
- Panel, thickness t, stiffness: S = C E w t³/(12 L³) ⇒ t ∝ E^(−⅓) ⇒ **E^⅓/ρ**; strength M = σf w t²/6 ⇒ **σf^½/ρ**.
- Euler column, square b: F = n π² E b⁴/(12 L²) ⇒ b ∝ E^(−¼) ⇒ **E^½/ρ**.

The generator solves each constraint by bisection and measures n from two property values, asserting the
closed form to 1e-9 (VC-SEL-01). Guide lines on a log P – log ρ chart: P^n/ρ = C ⇒ log P = (1/n)·log ρ + c,
slope 1/n (VC-SEL-18).

### 5.3 Design-rule ratios (`substitute_material`)

With 1 = current, 2 = candidate:

| Rule | Mass ratio m₂/m₁ | Stiffness / response |
| ---- | ---------------- | -------------------- |
| `same_geometry` | ρ₂/ρ₁ (exact, from `mass_properties`) | stiffness E₂/E₁, deflection E₁/E₂ (single material, same ν), modal frequency √((E₂/ρ₂)/(E₁/ρ₁)), linear buckling factor E₂/E₁ |
| `equal_stiffness_tie` | (ρ₂/ρ₁)(E₁/E₂) | stiffness unchanged |
| `equal_stiffness_beam` | (ρ₂/ρ₁)(E₁/E₂)^½ | stiffness unchanged; section side ×(E₁/E₂)^¼ |
| `equal_stiffness_panel` | (ρ₂/ρ₁)(E₁/E₂)^⅓ | thickness ×(E₁/E₂)^⅓ |
| `equal_strength_tie / beam / panel` | (ρ₂/ρ₁)(σ₁/σ₂)^(1, ⅔, ½) | strength unchanged |

Index-rule results are labelled `method: 'index_rule'` (an idealised part of that case, not the CAD geometry);
the agent rebuilds the geometry with parameters if it wants the exact mass (01/parametric).

### 5.4 Margin re-scaling and its exactness conditions

Linear static FE: K u = f. For one homogeneous isotropic material, K(E, ν) = E·K̂(ν) and the stress recovery is
σ = E·D̂(ν)·B·u. If f does not depend on the material (no gravity/inertia ⇒ no ρ; no thermal ⇒ no α) and every
prescribed displacement is zero, then u = K̂⁻¹f/E and σ = D̂ B K̂⁻¹ f, **independent of E**. If ν₂ ≠ ν₁ the
stresses change and the model must be re-solved. Under those conditions the 05 margin
MS = A/(σ·FoS·Π extra) − 1 becomes **MS₂ = (1 + MS₁)·A₂/A₁ − 1** (VC-SEL-08). In multi-material or
statically indeterminate mixed models the load sharing depends on the stiffness ratio (two-bar example: forces
666.7/333.3 N for any single material, 857.1/142.9 N when only one bar is changed from E to 3E, VC-SEL-09), so
`single_material` is required. The 2D result that plane traction stresses are independent of both moduli
(Michell; [R3]) is stronger but needs topology conditions; llull uses only the exact K = E·K̂ argument.

Conditions checked (all from document data; any failure ⇒ `SEL_MARGINS_NEED_RESOLVE`):
`single_material` (all analysed parts map to the `from` material), `same_poisson` (|ν₂ − ν₁| ≤ `nuTolerance`,
default 0, named), `no_body_force` (no 05 gravity/inertia load), `no_thermal_load`, `no_prescribed_displacement`
(non-zero), `same_allowable_basis` (else MS is reported but flagged `SEL_BASIS_MIXED`), `results_current`
(05 staleness hash equals the current one *before* the virtual swap).

`resolvePlan` (data, AF-05) = `[{command:'assign_material', params:{materialName: to, entityIds}}, {command:'fea_mesh'…},
{command:'fea_solve'…}, {command:'compute_margins', params:{analysisId}}]`, intended for `llull run --dry-run` on a copy.

### 5.5 Weighted score and Pareto

Score_i = Σ_k w_k · I_k,i / max_j I_k,j (weights normalised to Σ w = 1; missing weights ⇒ equal, `defaulted: true`).
Mass-type objectives (relative mass per unit performance = 1/I) and cost/CO₂ objectives (1/I × pricePerMass or
× embodiedCarbon) are minimised; Pareto = materials not dominated in all objectives (≤ in all, < in one).
Synthetic check: Pareto {syn_a, syn_c, syn_d}, weighted order syn_d > syn_a > syn_e > syn_b > syn_c (VC-SEL-05/06).

### 5.6 Tolerances

| Quantity | Tolerance |
| -------- | --------- |
| Index values, ratios, rescaled MS | rel 1e-9 (closed form) |
| Mass in what-if | same as 08 (`exact` rel 1e-6, mesh rel 5e-3 and flagged) |
| Exponent derivation (generator) | abs 1e-9 |

## 6. Interop & persistence

No document change, no migration. Saved study: `*.llull-selection.json` (`{ format: 'llull-selection-study',
schemaVersion: 1, documentHash, libraries: [{id, version, sha256}], command, params, data }`), written only by
`--save`. Private library values inside a saved study follow 08 TR-MAT-31 (redacted unless the file stays on the
workstation).

## 7. CLI / MCP / UI surfaces

- CLI: no new verbs; `llull <command>` and `llull run` (AF-01). `llull guide` gains a selection section: the
  seven cases in plain words, "name the loading case", strength property must be explicit (AF-03).
- MCP: toolset `selection` (all read-only, safe). `TOOLSET_NAMES` gains `selection` (from the plugin).
- UI: Ashby chart from `material_chart_data`, ranking table, substitution report (review only).

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `SEL_MATERIAL_NOT_FOUND` | error | unknown material id | material | `get_material` / library listing |
| `SEL_MATERIAL_NOT_ASSIGNED` | error | an entity in `entityIds` does not carry `from` | entity ids | `assign_material` first or fix `from` |
| `SEL_PROPERTY_MISSING` | warning (exclusion) / error (substitute) | a required property has no resolvable value | material, property names | `set_material_property` with a sourced value |
| `SEL_STRENGTH_PROPERTY_UNSET` | error | strength index without `strengthProperty` | param path | pass `Fty`, `Ftu` or `Fcy` |
| `SEL_NO_OBJECTIVE` | error | empty objectives | params.objectives | add an index |
| `SEL_DERIVATION_NOTE_MISSING` | error | user index without `derivationNote` | params.objectives[k] | state how the index was derived |
| `SEL_WEIGHT_INVALID` | error | weight < 0 or all 0 | params.objectives[k].weight | positive weights |
| `SEL_NO_CANDIDATE` | warning | every candidate failed or was excluded | — | relax constraints or add data |
| `SEL_DESIGN_RULE_UNSET` | error | `substitute_material` without `designRule` | params.designRule | name the rule (same_geometry …) |
| `SEL_BASIS_MIXED` | warning | inputs of a comparison or margin use different bases | materials, bases | compare like with like (A vs A) |
| `SEL_ANISOTROPIC` | warning | composite candidate (layup effective properties) | material, laminate | check 06 `analyze_laminate` FPF; index covers in-plane stiffness only |
| `SEL_LAYUP_REQUIRED` | error | composite candidate without a layup | material | pass `layups` |
| `SEL_MARGINS_NEED_RESOLVE` | info (in data) | an exactness condition of §5.4 fails | failed conditions | run `data.margins.resolvePlan` |
| `SEL_NO_ANALYSIS` | info | `include: margins` but no 05 analysis on the entities | entity ids | create an analysis (05) or drop margins |
| `SEL_VALUE_UNVERIFIED` | warning (not suppressible) | any input `unverified` | material, property ids | replace with a verified sourced value |
| `SEL_SUBSTITUTION_RELEASED` | error (check) | assigned material differs from the released revision and no open ECO lists the item | item id | open an ECO (09) |
| `SEL_FEA_STALE_AFTER_SUBSTITUTION` | warning (check) | material changed since the last 05 solve | analysis id | `fea_solve` again |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01, 02, 03, 04 | registry commands; descriptions state base units and refusals; `llull guide` section; `{value, unit}` params |
| AF-05 | `validation/plans/*.json`, `resolvePlan` as plan data |
| AF-10, 12, 13 | `data` shapes §3.2; studies via `--save`; deterministic order and tie-break |
| AF-11 | §7.1 |
| AF-20 | `check_material_selection` |
| AF-21 | `material_chart_data` replaces the visual chart |
| AF-30 | `INDEX_RULES` data table with sources |
| AF-31 | strength property explicit; weights/ν tolerance named defaults |
| AF-32, 33 | `unverified` propagation; `reviewRequired` on margins and on any study of a released/certified part |
| AF-34 | applying a substitution to a released part goes through 09 ECO classification (human) |
| AF-35, 36 | `inputs[]`, `provenance`, rule `derivation`; plain summary "lighter by x %, data typical, needs an engineer" |
| AF-41, 42 | offline; all commands read-only (dry-run not needed) |

## 8. Performance & robustness budgets

| Operation | Budget |
| --------- | ------ |
| `material_index` 100 materials × 7 indices | ≤ 20 ms |
| `compare_materials` 1,000 materials × 3 objectives + Pareto | ≤ 200 ms |
| `substitute_material` same_geometry on 1 part (closed-form volume) | ≤ 10 ms; exact OCC volume as `mass_properties` |
| `substitute_material` on 10⁴ fastener instances | ≤ 1 s (08 mass cache) |

Robustness: never throw; every exclusion is listed; no NaN or Infinity in `data` (density ≤ 0 rejected by 08).

## 9. Test strategy (→ VC ids)

| Level | Location | Covers |
| ----- | -------- | ------ |
| Unit (plugin) | `tests/unit/physics/selection/indices.test.ts` | rule table = CSV (TR-SEL-01), exponents and values VC-SEL-01, 02, 18 from `expected_results.json` |
| Unit | `…/rank.test.ts` | order, constraints, Pareto, weights VC-SEL-03…06; missing data VC-SEL-14 |
| Unit | `…/substitute.test.ts` | ratios VC-SEL-07, rescale VC-SEL-08, condition failures VC-SEL-09, `is pure` |
| Unit | `…/agentFirst.test.ts` | `unverified`, `SEL_BASIS_MIXED`, `SEL_ANISOTROPIC`, codes VC-SEL-15…17 |
| Contract | `tests/unit/contract/` | toolset membership, `toToolSchemas()` snapshot, plugin install |
| Golden | `tests/golden/plans.ts` | `substitute_block_ti` (VC-SEL-10/11) id-normalised |
| Server | `server/tests/` | 05 round trip: substitute → resolve plan → margins equal the rescaled MS for a single-material bracket (rel 1e-6) |
| Quality gate | `npm run quality` | `generate_selection_reference.py --check` |
| Production gate | `docs/PRODUCTION_GATE.md` | "lighter bracket": compare 4 candidates, substitute, re-solve, check |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 | `@phys` scaffolding (alias, arch rule, knip) if not already created by an earlier PHY pack; rule table; `material_index` | 08 M2 | 3 d |
| M2 | `compare_materials` (single objective, constraints, missing report), `check_material_selection` | M1 | 3 d |
| M3 | `substitute_material` mass + same-geometry ratios + design rules | M1; 08 mass fix | 3 d |
| M4 | Margin re-scaling + re-solve plan; 05 staleness link | M3; 05 M3 | 4 d |
| M5 | Multi-objective, Pareto, chart data; 06 layup candidates | M2; 06 M2 | 4 d |
| M6 | Temperature via PHY-01; cost/CO₂ properties (08 additions) | PHY-01; 08 | 3 d |

MVP (M1–M3) ≈ 9 d; V1 (M4–M5) ≈ 8 d; V2 (M6) ≈ 3 d.

## 11. Open questions

| Id | Question | Proposed default |
| -- | -------- | ---------------- |
| OQ-SEL-01 | Should index-rule mass ratios be offered at all on CAD parts (idealised case vs real geometry)? | Yes, labelled `index_rule`; exact mass only for `same_geometry` |
| OQ-SEL-02 | ν tolerance for margin re-scaling: 0 (exact) or a small band (e.g. 0.01) with a bounded error estimate? | 0; any band needs a sourced error bound |
| OQ-SEL-03 | Currency handling for `pricePerMass`: forbid mixing currencies, or allow a user FX table? | Forbid (`SEL_UNIT_MIXED` would be added) |
| OQ-SEL-04 | Should `substitute_material` accept a whole assembly and propagate to fastener catalogue materials (08)? | V2 |
| OQ-SEL-05 | Fracture toughness / fatigue indices (K_IC/ρ, endurance) once PHY-07/08 add those properties? | Add as rule rows owned by those packs |
| OQ-SEL-06 | Does `@phys` read 05 results through `execute` only (as proposed) or import `@cae` types (needs an arch rule)? | `execute` only |

## 12. References

See FUNCTIONAL_SPEC §11 [R1]–[R8] and `validation/sources.md` [S1]–[S10]. Additionally:

- [T1] llull architecture laws L1–L10 — `.claude/rules/architecture.md`
- [T2] Command layer signatures — `.claude/context/command-layer.md`
- [T3] Physics gap list and pack conventions — `docs/physics/README.md` §6

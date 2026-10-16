# PHY-04: Thermo-mechanical coupling & thermal fits — technical specification

Gap id **TMC** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit |
| ---- | ----------- | ---- | ----- |
| Today | No thermal strain, no CTE (`Material` has density and PBR fields only); `grep -ril "thermal expansion"` over `packages/*/src`, `server/src` finds nothing | `packages/core/src/model/types.ts` | — |
| Parametric expressions | Pure evaluator (`+ − * /`, `pi`, `sqrt`, `hypot`, `pow`, … no `^`) | `packages/core/src/commands/parametric/expression.ts` (`evaluateExpression`) | Not in the plugin public API (`commands/{schema,types,noop,derivation,registry}` only, architecture L10) |
| Plugin dependency rule | domain packages import only core | `.dependency-cruiser.cjs` `plugins-and-kernels-depend-on-core-only` | Same placement decision as PHY-03 §2.1 |
| After 08 MAT (spec) | `cte` `PropertyValue` with optional `TemperatureDependence`; no field says whether a CTE is secant or instantaneous, nor its reference temperature | 08 TECHNICAL_SPEC §3.1 | Basis gap (§3.3, §11 Q2) |
| After 03 GDT (spec) | `SizeDimensionPmi.tolerance = { type: 'fit', code, upper, lower }` (code text only), `add_size_dimension`, `analyze_stackup` at one temperature; no ISO 286 tables shipped | 03 TECHNICAL_SPEC §3–§4, FUNCTIONAL §4.2 | No temperature |
| After 05 FEA (spec) | static case, constraints, loads, margins, artifact-validated results, staleness | 05 TECHNICAL_SPEC | No temperature load |
| After PHY-03 (spec) | `heat_steady` / `heat_transient`, `ThermalResultsSummary.fieldRefs[]` by results hash | `docs/physics/03-thermal-analysis/TECHNICAL_SPEC.md` §3 | Producer of temperature fields |
| Bundled CalculiX | `*EXPANSION` (secant w.r.t. `ZERO`), `*TEMPERATURE` (incl. `FILE`, `BSTEP`), `*COUPLED TEMPERATURE-DISPLACEMENT`, `*UNCOUPLED TEMPERATURE-DISPLACEMENT`, `*EL FILE THE` (test `beamt`) | [R7] | — |

## 2. Target architecture

```
packages/domain-physics/src/thermomech/   CadPlugin "thermomech", toolset "analysis"
   commands/  set_temperature_field, set_reference_temperature, (queries) fit_at_temperature, thermal_stress_check,
              thermal_distortion_report, check_thermo_mechanical, dispose_fit_result (human gate)
   extension.ts   AnalysisTypeExtension for 'thermo_static' | 'coupled_temperature_displacement' (PHY-03 §3.2 port)
   field.ts       temperature-field resolution (thermal artifact / uniform / expression / table) → nodal T (pure)
   cte.ts         secant / instantaneous conversions, table sampling (pure)
   fits.ts        fit_at_temperature + Lamé (pure)        analytic.ts   closed forms (pure)
packages/core/src
   model/analysis.ts   + AnalysisType members, TemperatureFieldSource, ThermoMechSetup (§3)
   lib/expression.ts   (proposal) evaluateExpression moved from commands/parametric to lib so plugins can evaluate fields
   plugins/plugin.ts   AnalysisTypeExtension port (PHY-03 §3.2)
```

Placement follows PHY-03 §2.1 (Proposal A, extension port in core; Proposal B fallback inside `domain-cae`). Laws: L1
(commands only; solve through 05 transports), L2 (core API only), L3, L4 (no field arrays in the document: temperatures are
resolved at deck time from the artifact store or the expression), L5, L6, L8 (references to thermal cases by id; staleness
by hash), L9 (`fit_at_temperature` reads PMI data only — no kernel; distortion reads mesh artifacts), L10.

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-TMC-01 | MUST | `AnalysisType` gains `'thermo_static'` (MVP) and `'coupled_temperature_displacement'` (V1), owned by this pack. |
| TR-TMC-02 | MUST | `thermo_static` = 05 `static` case + `thermomech: ThermoMechSetup` (§3.1). All 05 constraints, loads, mesh controls, probes and margins apply unchanged. |
| TR-TMC-10 | MUST | Field source `thermal_result`: references a PHY-03 case id and a time (`'last'` or seconds); resolves to `fieldRefs[]` → `resultsHash`; `inputHash` (05 TR-FEA-06) of the mechanical case includes that `resultsHash`, the reference temperature and the CTE data; MVP requires `meshHash(thermal) == meshHash(mechanical)` else `TMC_MESH_MISMATCH`. |
| TR-TMC-11 | MUST | Deck: `*INITIAL CONDITIONS, TYPE=TEMPERATURE` = T_ref on all nodes; per material `*EXPANSION, ZERO=<T_ref>` with secant α (table if temperature dependent); in the `*STATIC` step a `*TEMPERATURE` block listing every node's temperature (self-contained deck; the `FILE=`/`BSTEP=` form is not used so the exported deck does not depend on a side file); `*EL FILE S, E, THE`. Byte-identical for identical inputs. |
| TR-TMC-12 | MUST | Field source `expression`: evaluated at each mesh node with x, y, z in the declared `coordinatesUnit`, result in the declared `temperatureUnit`; grammar = llull's parametric expression grammar (TR-TMC-12 needs `evaluateExpression` in `lib/`, §11 Q3); non-finite at any node → `TMC_FIELD_INVALID` with the node count. |
| TR-TMC-13 | SHOULD (V1) | Layered parts (bimetal, bonded inserts) when 05 supports bonded multi-part conformal meshes; until then `thermal_stress_check check=bimetal` only. |
| TR-TMC-14 | MUST | Field source `uniform` and `table` (CSV `x,y,z,T` with units; nearest-node match within 1e-6 × model size, otherwise `TMC_FIELD_TABLE_UNMATCHED`). |
| TR-TMC-15 | MUST | CTE handling (§5.2): source order and basis per §3.3 (`thermalStrain` model first); instantaneous tables integrated to secant at the case reference temperature by Simpson's rule on the table (piecewise linear ⇒ exact trapezoid of a linear function); re-referencing exact; PHY-01 fitted models sampled (step ≤ 10 K) then integrated; conversions listed in `data.provenance`. |
| TR-TMC-16 | MUST | `thermal_distortion_report` (§5.4): best-fit plane (least squares, SVD-free closed form on the 3 × 3 covariance via Jacobi rotation) of a face's nodes before/after displacement; out-of-plane deviation = max − min signed distance; relative displacement of named points; comparison with a 03 flatness/profile tolerance found on that face (`pmiId`), `reviewRequired: true`. |
| TR-TMC-20 | MUST | `fit_at_temperature` (§5.3) pure: diameters scaled with each part's secant CTE from its spec temperature; status rules; derived fit intent; per-part temperatures; outputs with units (mm or in per document); `provenance { formula, inputs, cteSources }`; no kernel and no solver. |
| TR-TMC-21 | SHOULD (V1) | Lamé interference pressure (solid or hollow shaft, hub outer diameter given) and hub bore hoop stress per temperature, both elastic; materials' E, ν from 08. |
| TR-TMC-22 | SHOULD (V1) | Coupled deck: `*COUPLED TEMPERATURE-DISPLACEMENT[, STEADY STATE]` with PHY-03 thermal BCs (DOF 11 boundaries, film, radiation, flux) and 05 mechanical BCs in one step; `*NODE FILE U, NT`, `*EL FILE S, HFL`. |
| TR-TMC-23 | SHOULD (V1) | Mesh mapping: for each mechanical node, locate the containing thermal element (BVH on element AABBs, deterministic order), interpolate with its shape functions; report `maxMappingDistance`, nodes outside (nearest-face projection, flagged), and a check that the mapped field reproduces the thermal nodal values at coincident nodes to 1e-9. |
| TR-TMC-30 | MUST | Agent-first contract: reference temperature, spec temperature, load category never defaulted; `unverified` = OR of CTE/E/ν flags; `reviewRequired` on fit rows, distortion comparisons and margins. |
| TR-TMC-31 | MUST | Stable codes §7.1. |
| TR-TMC-32 | MUST | `dispose_fit_result` verifies a human signature through the 09 signing port (AF-34a); agents get `TMC_HUMAN_GATE`. |

## 3. Data model

### 3.1 Analysis slice additions (core `model/analysis.ts`)

```ts
export type TemperatureFieldSource =
  | { readonly kind: 'thermal_result'; readonly analysisId: string; readonly time: number | 'last';
      readonly mapping: 'same_mesh' | 'interpolate' /* V1 */ }
  | { readonly kind: 'uniform'; readonly value: Q }
  | { readonly kind: 'expression'; readonly expression: string; readonly coordinatesUnit: 'mm' | 'm' | 'in'; readonly temperatureUnit: 'degC' | 'K' | 'degF' }
  | { readonly kind: 'table'; readonly csvSha256: string; readonly rows: number; readonly coordinatesUnit: string; readonly temperatureUnit: string };
  // table content lives in the 05 artifact store (L4); the document keeps the hash

export interface ThermoMechSetup {                    // AnalysisCase.thermomech (thermo_static / coupled)
  referenceTemperature: Q;                            // stress-free temperature, mandatory (no default)
  field?: TemperatureFieldSource;                     // thermo_static: mandatory before solve
  thermal?: ThermalSetup;                             // coupled (V1): PHY-03 thermal BC set inside the same case
  loadCaseName: string;                               // the 05 load case that carries the thermal load
}
export interface AnalysisCase { /* 05 + PHY-03 */ thermomech?: ThermoMechSetup }

export interface FitDispositions { [rowKey: string]: { decision: 'accepted' | 'rejected' | 'redesign'; justification: string;
  inputsHash: string; signer: string; signatureId: string } }   // CadDocument.analysis.fitDispositions (keyed by pmi pair + T)
```

### 3.2 Query results

```ts
export interface FitRow {
  readonly temperature: { hole: Q; shaft: Q };
  readonly holeDiameter: { min: number; max: number }; readonly shaftDiameter: { min: number; max: number };
  readonly clearance: { min: number; max: number };   // document length unit; negative = interference
  readonly status: 'clearance' | 'interference' | 'interference_possible' | 'clearance_possible';
  readonly code?: 'TMC_FIT_INTERFERENCE' | 'TMC_FIT_LOOSE';
  readonly interferencePressureMPa?: { min: number; max: number }; readonly hubHoopStressMPa?: { max: number };  // V1
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true; readonly reviewReason: string; readonly disposition: 'none' | 'pending_human' | 'accepted' | 'rejected' | 'redesign';
}
export interface FitResult {
  readonly unit: 'mm' | 'in'; readonly specTemperature: Q;
  readonly intent: 'clearance' | 'interference' | 'transition'; readonly intentSource: 'derived_from_limits_at_spec_temperature' | 'given';
  readonly rows: readonly FitRow[];
  readonly provenance: { formula: 'D(T) = D_spec (1 + a_sec(T; T_spec) (T - T_spec))'; cte: ReadonlyArray<{ part: string; source: string; basis: string; conversion?: string }>;
    limits: ReadonlyArray<{ pmiId?: string; code?: string; upper: number; lower: number; nominal: number }> };
  readonly summary: string;
}
```

### 3.3 CTE source and basis (PHY-01 / PHY-02 alignment)

Order of preference, all read through PHY-01's consumer API (`resolvePropertyModel` / `evaluatePropertyModel` /
`tabulatePropertyModel`, `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3.3):

1. A **`thermalStrain`** model (PHY-01 catalogue, dimensionless s(T) = (L − L_ref)/L_ref): the secant CTE for CalculiX is
   derived exactly with PHY-01's formula ᾱ(T_ref→T) = (s(T) − s(T_ref)) / ((T − T_ref)(1 + s(T_ref))) — no basis ambiguity.
2. A **`cte`** model or 08 scalar whose basis is stated. PHY-01 has no CTE-basis field, so this pack requests one
   (`PropertyCondition.cteBasis?: { kind: 'secant'; referenceTemperature: Q } | { kind: 'instantaneous' }`); until PHY-01
   adds it, `set_temperature_field` / `fit_at_temperature` accept a per-material `cteBasis` override recorded in provenance.
3. Neither ⇒ `TMC_CTE_BASIS_UNKNOWN`.

The secant table written to `*EXPANSION, ZERO=<T_ref>` is produced by `tabulatePropertyModel` (deck header: model ids,
`coefficientsSha256`, `maxRelError`, as PHY-01 requires of PHY-04). Elastic constants come from the part's PHY-02
`ConstitutiveSet` (elastic kind `elastic_isotropic`; `model/materialModel.ts`) or, absent one, the 05 `FeaMaterialView`
(E, ν), with E(T) tables again from `tabulatePropertyModel`. Out-of-range requests are PHY-01 `PROP_OUT_OF_RANGE`.

No document version bump: optional fields in the aerospace v3 envelope (README §6.2).

## 4. Commands

Plugin `thermomech`, toolset `analysis`.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| (05) `create_analysis` | mutating | `analysisType: 'thermo_static' \| 'coupled_temperature_displacement'`, `referenceTemperature: Q` (required for these types) | @failure `TMC_REFERENCE_TEMPERATURE_MISSING` |
| `set_reference_temperature` | mutating | `{ analysisId, value, unit }` | @affects case.thermomech.referenceTemperature · @failure not a thermomech case |
| `set_temperature_field` | mutating | `{ analysisId, source: TemperatureFieldSource (table: file via transport → hash) , cteBasis?: Record<material, basis> }` | @affects case.thermomech.field · @invariant referenced thermal case exists and is `heat_*`; expression parses (syntax only at command time); units valid · @failure `TMC_FIELD_SOURCE_INVALID`, `TMC_FIELD_INVALID`, `THM_CASE_TYPE` |
| `fit_at_temperature` | query | `{ holePmiId? , shaftPmiId?, hole?: { nominal, upper, lower }, shaft?: {…}, holeMaterial?, shaftMaterial?, specTemperature: Q, temperatures?: Q[], holeTemperatures?: Q[], shaftTemperatures?: Q[], range?: { min: Q, max: Q, steps }, hubOuterDiameter? (V1), intent? }` → `data: FitResult` | pure; materials from the PMI parts' assigned records when not given · @failure `TMC_SPEC_TEMPERATURE_MISSING`, `TMC_FIT_LIMITS_MISSING`, `TMC_FIT_NOT_A_PAIR`, `TMC_MATERIAL_NO_CTE`, `TMC_CTE_BASIS_UNKNOWN`, `TMC_PROPERTY_OUT_OF_RANGE` |
| `thermal_stress_check` | query | `{ check: 'restrained' \| 'inclusion' \| 'bimetal' \| 'thick_cylinder' \| 'gradient_beam' \| 'shrink_fit' \| 'cte_secant', inputs }` → `{ value(s), unit, formula, inputs }` | pure; equals `generate_thermomech_reference.py` to 1e-12 relative |
| `thermal_distortion_report` | query | `{ analysisId, faces?: [{ name, target: FeaTarget, pmiId? }], points?: [{ name, point }], loadCase? }` → `data { maxDisplacement, faces[{ name, flatnessBefore, flatnessAfter, change, tolerance?, withinTolerance?, reviewRequired }], points[{ name, displacement }], unit }` | @failure `FEA_RESULTS_STALE` / `_MISSING` |
| `check_thermo_mechanical` | query | `{ analysisId }` → pass/warn/fail items (§7.1) + `reviewRequired: true` | 05 `check_analysis` delegates to it for these types |
| `dispose_fit_result` | mutating, **human gate** | `{ rowKey, decision, justification, signature }` | @affects analysis.fitDispositions · @failure `TMC_HUMAN_GATE`; `TMC_FIT_INPUTS_CHANGED` when the inputs hash moved |
| (05 ✱) `fea_mesh`, `fea_solve`, `fea_export` | transport | unchanged | dispatch on the extension; `fea_solve` refuses a stale thermal source |

Description sketch, `fit_at_temperature` (AF-02): *"Compute hole/shaft clearance at one or more temperatures from 03 GDT
size-dimension limits (holePmiId, shaftPmiId) or explicit limits, and each part's CTE (08 record of the assigned material;
basis secant or instantaneous must be known). specTemperature is the temperature the limits apply at (no default). Returns
per temperature min/max clearance in document length units (negative = interference), a status and code, the formula and
inputs; every row needs review. Use before approving a mixed-material fit; next: dispose_fit_result (human only) or a
design change."*

## 5. Kernel / algorithms

### 5.1 Thermal strain in CalculiX (TR-TMC-11)

CalculiX: ε_th = α(T)(T − T_ref) − α(T0)(T0 − T_ref), α secant w.r.t. `ZERO` = T_ref [R7]. llull writes `ZERO` = the case
reference temperature and `*INITIAL CONDITIONS, TYPE=TEMPERATURE` = T_ref, so T0 = T_ref and ε_th = α_sec(T)(T − T_ref).

```
*MATERIAL, NAME=<m>   *ELASTIC  E, nu[, T]   *EXPANSION, ZERO=<Tref>   a_sec, T  (table rows)
*INITIAL CONDITIONS, TYPE=TEMPERATURE   NALL, <Tref>
*STEP  *STATIC
*TEMPERATURE            <node>, <T>     (one line per node, %.12g)
*BOUNDARY / *CLOAD / *DLOAD  (05, superposed mechanical loads of the same load case)
*NODE FILE U   *EL FILE S, E, THE   *END STEP
```

### 5.2 CTE conversions (TR-TMC-15)

- Instantaneous table α_i(T) → secant at T_ref: α_s(T) = (1/(T − T_ref)) ∫_{T_ref}^{T} α_i dT', with α_s(T_ref) = α_i(T_ref).
- Secant at T_a → secant at T_b: α_b(T) = [α_a(T)(T − T_a) − α_a(T_b)(T_b − T_a)] / (T − T_b).
- Thermal strain between two temperatures is invariant to the reference (VC-TMC-07.c).
- Temperature-dependent E and ν are written as `*ELASTIC` tables (CalculiX interpolates); ranges checked against the field.

### 5.3 Fit at temperature (TR-TMC-20, TR-TMC-21)

```
for each temperature (T_h for the hole part, T_s for the shaft part):
  D_h,min/max(T_h) = (nominal + lower/upper)_hole  * (1 + a_sec,h(T_h; T_spec) (T_h - T_spec))
  D_s,min/max(T_s) = (nominal + lower/upper)_shaft * (1 + a_sec,s(T_s; T_spec) (T_s - T_spec))
  c_min = D_h,min - D_s,max ;  c_max = D_h,max - D_s,min
  status = clearance if c_min >= 0; interference if c_max < 0; otherwise
           interference_possible (intent clearance/transition) | clearance_possible (intent interference)
  intent (unless given) from the spec-temperature row: c_min >= 0 -> clearance; c_max < 0 -> interference; else transition
  codes: TMC_FIT_INTERFERENCE when intent = clearance and c_min < 0; TMC_FIT_LOOSE when intent = interference and c_max >= 0
  V1 Lame (solid shaft radius b, hub outer radius c), radial interference d_r = -c/2 when c < 0:
     p = d_r / ( b [ ((c^2 + b^2)/(c^2 - b^2) + nu_h)/E_h + (1 - nu_s)/E_s ] ),  hoop at bore = p (c^2 + b^2)/(c^2 - b^2)
```

Interference sign: a negative clearance is an interference. For `TMC_FIT_LOOSE` the test is "minimum interference ≤ 0",
i.e. c_max ≥ 0. Thermal expansion of the nominal is applied to each limit diameter (not to the nominal only) so
the 20 °C row reproduces the PMI limits exactly. Elastic deformation, gradients inside a part and form errors are out
of scope and stated in `data.assumptions`.

### 5.4 Distortion metrics (TR-TMC-16)

Signed distance of each face node to the least-squares plane through the node cloud (normal = eigenvector of the smallest
eigenvalue of the covariance, cyclic Jacobi, deterministic sweep order); flatness = max − min. "Before" uses the
undeformed coordinates, "after" x + u. Points are probed with the 05 probe machinery.

### 5.5 Analytic checks

Exactly the functions of `validation/generate_thermomech_reference.py` (restrained, inclusion, Timoshenko bimetal,
thick cylinder integral form, gradient beam, Lamé, CTE conversion), returned with formula and inputs (AF-35).

### 5.6 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Fit arithmetic | 1e-12 relative (double precision, no rounding before output) |
| CTE conversion | 1e-12 relative for linear tables; Simpson error report for sampled models |
| Expression evaluation | IEEE double; non-finite refused |
| Benchmarks | per case (0.5 %–3 %, justified in validation/README.md) |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| CalculiX INP (thermo_static / coupled) | out | extension deck sections (§5.1) |
| Temperature table CSV | in | 05-style transport `fea_import_field` (✱, writes the artifact, then `set_temperature_field kind=table`) |
| FRD (U, S, THE; coupled NT) | in | 05 readers |
| Document | persist | `analysis.cases[*].thermomech`, `analysis.fitDispositions` |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands; `llull guide` thermo-mechanical section: reference vs spec temperature, secant CTE, the fit
  query and its statuses, minimal `thermo_static` plan (`validation/plans/tmc_restrained_bar.plan.json`).
- **MCP**: toolset `analysis`; prompt `thermal_fit_check`.
- **UI**: fit table, deformed shape, flatness panel, disposition dialogs.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `TMC_REFERENCE_TEMPERATURE_MISSING` | error | thermomech case without reference temperature | analysis id | `set_reference_temperature` |
| `TMC_SPEC_TEMPERATURE_MISSING` | error | `fit_at_temperature` without `specTemperature` | param path | give the temperature the drawing limits apply at |
| `TMC_FIELD_SOURCE_INVALID` | error | field references a missing / non-thermal case or bad time | analysis ids | reference a solved `heat_*` case |
| `TMC_FIELD_INVALID` | error | expression non-finite / unparsable at nodes | node count | fix the expression |
| `TMC_FIELD_TABLE_UNMATCHED` | error | table points do not match mesh nodes | count | re-export the table or use interpolation (V1) |
| `TMC_THERMAL_RESULT_STALE` | error | referenced thermal result is stale | thermal analysis id | re-solve the thermal case |
| `TMC_MESH_MISMATCH` | error | thermal and mechanical meshes differ (MVP) | both mesh hashes | same mesh controls, or `mapping: interpolate` (V1) |
| `TMC_MATERIAL_NO_CTE` | error | analysed part / fit part without `cte` | material | `set_material_property property=cte …` |
| `TMC_CTE_BASIS_UNKNOWN` | error | CTE basis not stated | material | add `cteBasis` (secant + reference, or instantaneous) |
| `TMC_PROPERTY_OUT_OF_RANGE` | error (fit) / warning (FE) | temperature outside the CTE/E/ν model's equation range (wraps PHY-01 `PROP_OUT_OF_RANGE`, which is passed through in `data.cause`) | material, range, T | define a model sourced for that range (PHY-01) |
| `TMC_MATERIAL_UNVERIFIED` | warning (not suppressible) | a used CTE/E/ν is `unverified` | material, property | verified sourced value |
| `TMC_THERMAL_CATEGORY_UNSET` | error | margins on a thermal load case without `limit`/`ultimate` category | load case | set the category with the programme rule |
| `TMC_FIT_LIMITS_MISSING` | error | PMI size dimension has no limits (basic or untoleranced) | pmi id | add limits (03) |
| `TMC_FIT_NOT_A_PAIR` | error | the two features are not hole + shaft of matching nominal (> 1e-6 relative difference) | pmi ids | pick the mating features |
| `TMC_FIT_INTERFERENCE` | fail | clearance intent and c_min < 0 at a temperature | row key | redesign or human disposition |
| `TMC_FIT_LOOSE` | fail | interference intent and minimum interference ≤ 0 | row key | same |
| `TMC_FIT_INPUTS_CHANGED` | error | disposition on a row whose inputs hash changed | row key | recompute, then disposition |
| `TMC_HUMAN_GATE` | error | `dispose_fit_result` by an agent / without valid signature | row key | hand over to the qualified reviewer |
| 05 / PHY-03 codes | — | `FEA_*`, `THM_*` apply unchanged | | |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01…05 | registry commands, unit-bearing params, guide section, plans |
| AF-10…13 | `FitResult`, distortion and check shapes with units; deterministic arithmetic |
| AF-11 | §7.1 (VC-TMC-61) |
| AF-20/21/23 | `check_thermo_mechanical`; distortion numbers instead of plots; CLI harness |
| AF-30/31 | no default reference / spec temperature / category (VC-TMC-60) |
| AF-32…36 | unverified propagation; `reviewRequired` rows; `dispose_fit_result` human gate (VC-TMC-63); provenance with formula and CTE sources; owner summary |
| AF-40…42 | 05 transports; `--dry-run` on set-up commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| `fit_at_temperature`, 100 temperatures | ≤ 5 ms |
| `*TEMPERATURE` block for 200k nodes | ≤ 1 s to write, deterministic `%.12g` |
| Expression field, 200k nodes | ≤ 300 ms |
| Mapping (V1), 200k target nodes on 200k-element source | ≤ 5 s |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/thermomech/*`) | commands happy / failure / `is pure`; fits (all pairs of `fit_at_temperature.csv`); CTE conversions; analytic checks vs `expected_results.json`; deck section golden text | 01, 03, 04, 06–09, 60–63 |
| Golden | the four plans in `validation/plans/` | 01, 02, 05, 06 |
| Integration (ccx) | LE11, restrained bar, sequential thick cylinder, T1 (plane stress per 05 idealization) | 01, 02, 03, 05 |
| Agent-first | staleness chain, codes, human gate | 50, 60–63 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `fit_at_temperature`, `thermal_stress_check`, CTE conversions (no FE) | 03 GDT M1 (PMI sizes), 08 M1–M2, CTE basis decision | 1.5 w |
| M2 | `thermo_static` (uniform / expression / thermal_result same mesh), deck sections, `check_thermo_mechanical`, staleness chain | PHY-03 M2, 05 M3, extension port (PHY-03 M0), `lib/expression` move | 2 w |
| M3 | `thermal_distortion_report`, validation (LE11, T1, bar, cylinder), golden plans, guide | M2, PHY-00 | 1 w |
| M4 (V1) | coupled procedure, mesh mapping, Lamé in fits, orthotropic CTE, fit stack-ups at temperature (03 `analyze_stackup`), bimetal FE | M3, 05 bonded meshes, 06 V2 | 3 w |

## 11. Open questions / decisions needed

1. **Placement** — as PHY-03 §2.1 (extension port in core vs inside `domain-cae`).
2. **CTE basis field**: PHY-01 is final without one; accept the requested `PropertyCondition.cteBasis` (§3.3), or require `thermalStrain` models for every CTE used in analysis? Many datasheets
   do not say; who decides when a value's basis is unknown?
3. **Expression evaluator in plugins**: move `commands/parametric/expression.ts` to `lib/` (pure leaf) or expose it in the
   plugin public API? Both are core changes.
4. **Spec temperature default**: adopt ISO 1's standard reference temperature as a named default once its value is verified
   from the standard (not seen in this session), or keep it always explicit?
5. **Thermal load category and factors**: programme rules differ; should llull ship a rule-table hook (like 03's customer
   rule tables) for thermal factors?
6. **Bonded multi-part meshes** in 05 (needed for layered FE): owned by 05 V2 tied contact or a conformal multi-body mesh?

## 12. References

- [R1]–[R11]: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md).
- llull: `.claude/rules/architecture.md`, `.dependency-cruiser.cjs`, `packages/core/src/commands/parametric/expression.ts`,
  `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`,
  `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`, `docs/physics/03-thermal-analysis/TECHNICAL_SPEC.md`.

## 13. Implementation status (2026-10-16)

**Built: M1** — `fit_at_temperature` (TR-TMC-20, with the V1 Lamé pressure / hub hoop stress of TR-TMC-21), `thermal_stress_check`
(§5.5) and the CTE conversion module (TR-TMC-15). VC-TMC-01.a–c, 03.a–c, 04.a/b, 05.a–c, 06.a–d, 07.a–c, 08.a–d, 09.a–c and 62 are
judged by `tests/unit/physics/thermomech/` (all pass); every row of `fit_at_temperature.csv` (12), `thick_cylinder_profile.csv` (11) and
`cte_conversion.csv` (6) is reproduced. VC-TMC-60 / 61 are asserted for the fit-side codes.

| Item | Where |
| ---- | ----- |
| `fit_at_temperature` | `packages/core/src/commands/thermomech/{fitAtTemperature,fitMath,materialCte}.ts` |
| `thermal_stress_check` | `commands/thermomech/{thermalStressCheck,thermalChecks,analytic}.ts` |
| CTE conversions §5.2 | `commands/thermomech/cteConversion.ts` (exact for linear laws / piecewise-linear tables; Simpson ≤ 10 K with a Richardson error estimate otherwise) |

Toolset `analysis`.

**Deviations (recorded, not silent):**

- **Placement.** Core feature catalog `commands/thermomech/` (no `packages/domain-physics`), as PHY-00/01.
- **No PMI.** 03 GDT size dimensions do not exist: limits are explicit `hole` / `shaft` `{ nominal, upper, lower }` in document units;
  `provenance.limits[]` carries `part` instead of `pmiId` / `code`; `unit` is the document length unit.
- **CTE sources.** A PHY-01 `thermalStrain` model is preferred (exact §3.3 secant); a `cte` model needs the per-material `cteBasis`
  override (`secant` + reference, or `instantaneous`) because PHY-01 has no basis field (§11 Q2); explicit `holeCte` / `shaftCte`
  need a `referenceTemperature` and are always `unverified`. E, ν for Lamé are explicit inputs (`lame`), flagged `unverified`.
- **Temperatures.** No silent spec-temperature row: no temperature given ⇒ `TMC_FIT_TEMPERATURES_MISSING`.
- **Formula string** is the VC-TMC-62 text `D(T) = D_spec (1 + a_sec (T - T_spec))`.
- **`thermal_stress_check` inputs** are a `Record<string, { value, unit }>` per check (keys in the description), unknown / missing keys
  refused; defaults (`inclusion r = a`, thick-cylinder radii) listed in `data.defaults`.
- **Extra codes:** `TMC_FIT_TEMPERATURES_MISSING`, `TMC_CTE_SOURCE_CONFLICT`, `TMC_CHECK_INPUT_MISSING`, `TMC_CHECK_INPUT_UNKNOWN`,
  `TMC_CHECK_INPUT_INVALID`.
- **Rows** carry `disposition: 'pending_human'` when a code is raised (no signing port), `'none'` otherwise.

**Validation pack fix (2026-10-16, owner-approved):** the generator derived VC-TMC-09.b/c with the nominal-diameter linearisation
`i(T) = i(20) − D (α_hub − α_shaft) ΔT`, contradicting §5.3 (every limit diameter scales; 1.6e-5 mm against `abs 1e-7`). It now
derives them limit by limit (values 0.0200761625 / −0.01396495 mm; no other case changed) and `fit_at_temperature` measures them.
`thermal_stress_check check=shrink_fit` keeps its stated nominal-diameter linearisation (a quick check, not judged on 09.b/c).

**M2 + M3: built (2026-10-16, owner decision)** on the minimal 05 slice (`docs/physics/FE_PIPELINE_DESIGN.md`), discipline inside
`packages/domain-cae/src/thermomech/` (PHY-03 §2.1 Proposal B). The CTE derivation modules moved to core `model/{cteConversion,materialCte}.ts`
and the expression evaluator to `lib/expression.ts` (§11 Q3) so the plugin can use them.

| Item | Where |
| ---- | ----- |
| `create_analysis analysisType=thermo_static` (reference temperature required) | `packages/domain-cae/src/commands/analysis.ts` (05 slice) |
| `set_reference_temperature`, `set_temperature_field` (uniform / expression / thermal_result same mesh / table) | `thermomech/commands.ts`, `field.ts` |
| Deck §5.1 (`*EXPANSION, ZERO=` secant table, initial conditions = T_ref, `*TEMPERATURE` per node, `*NODE FILE U, NT`, `*EL FILE S, E, THE`) | `thermomech/{deck,cte,units}.ts` + the 05 `mechanicalStepLines` |
| `check_thermo_mechanical`, `thermal_distortion_report` (Jacobi plane fit), `dispose_fit_result` (human gate) | `thermomech/{check,distortion,plane,dispose}.ts` |
| Staleness chain thermal → thermo_static (TR-TMC-10) | `hash/inputHash.ts`: the dependent case hashes the source case's results hash **and** its current input hash |

FE benchmarks, real Gmsh + ccx 2.21 (`server/tests/feaThermomech*.test.ts`, adapted plans in `server/tests/fixtures/thermomech/`, run by
`npm run quality:physics`): VC-TMC-01.a/b/c (−251.997 / −359.996 / −629.994 MPa), 02 LE11 (−103.43 MPa vs −105, −1.5 %, OCC kernel, full
FeenoX section revolved), 05.a/b/c sequential thick cylinder (−206.93 / 133.69 / −208.40 MPa, ≤ 1.4 %), 08.b/c/d thermal bow
(`thermal_distortion_report` agrees with the probe), 60, 61, 63, and the fit plan (06.a–d). VC-TMC-50 is verified on its
`fea_report` (stale) and `check_thermo_mechanical` (`TMC_THERMAL_RESULT_STALE`) sides and by the refused mechanical solve; its contract also
lists `compute_margins`, a 05 command not built in the minimal slice, so the case is not recorded as a whole.

**FE deviations:**

- **Same-mesh test:** two cases with different BCs never share a mesh hash (their node sets differ), so `thermal_result` compares nodes
  and element blocks when the hashes differ; a missing mesh or a different discretisation is still `TMC_MESH_MISMATCH`.
- **Table fields** read `{ kind: 'fe_table', rows }` from the artifact store under the CSV hash; the `fea_import_field` transport that
  writes it is not built.
- **LE11 needs the OCC kernel:** with Manifold the sphere tessellation gives overlapping facets in Gmsh. Initial temperatures are written
  per node (no set-name dependency). `TMC_THERMAL_CATEGORY_UNSET` is a warning (`add_fea_load` always sets a category).
- **Human gate:** `dispose_fit_result` verifies through `ctx.humanSignature`; none is installed (09 PLM), so agents get `TMC_HUMAN_GATE`.

**Still open:** VC-TMC-50's `compute_margins` key (05 margins); VC-TMC-03.b NAFEMS T1 FE (needs plane stress or bonded multi-part meshes — 05 V1; the analytic VC-TMC-03.a–c pass);
M4 (coupled procedure, mesh mapping, orthotropic CTE, fit stack-ups, bimetal FE); `fea_import_field`; a signing implementation (09 PLM);
the `llull guide` section.

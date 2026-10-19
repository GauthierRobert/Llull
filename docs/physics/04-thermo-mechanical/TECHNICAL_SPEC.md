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
| TR-TMC-24 | SHOULD | RS1 RS-7: above a named node count (set from VC-TMC-10) the `interpolate` mapping runs in `llull-compute post map <job-folder>` (crate `llull-post` on the shared `llull-bvh`, Rust CPU, rayon over target nodes) with the same rules as TR-TMC-23 (lowest containing element index wins, nearest-point projection outside, same report). The server stores the mapped field as an artifact bound to the thermal `resultsHash` and the mechanical mesh hash; the deck writer checks both hashes before writing `*TEMPERATURE`. `thermomech/mapping.ts` stays the reference and the small-mesh path; without the binary it runs at any size (slower). |
| TR-TMC-30 | MUST | Agent-first contract: reference temperature, spec temperature, load category never defaulted; `unverified` = OR of CTE/E/ν flags; `reviewRequired` on fit rows, distortion comparisons and margins. |
| TR-TMC-31 | MUST | Stable codes §7.1. |
| TR-TMC-32 | MUST | `dispose_fit_result` verifies a human signature through the 09 signing port (AF-34a); agents get `TMC_HUMAN_GATE`. |

### 2.1 Stack amendment (RS1, 2026-10-18)

Decision [RS1](../../decisions/RS1-native-compute.md) step **RS-7** (medium, Rust CPU) moves large mesh-to-mesh temperature
mapping (point location of up to 200k mechanical nodes in the thermal mesh) to `llull-compute post`, using the shared BVH crate
`llull-bvh` (TR-TMC-24). The TS mapping (`thermomech/mapping.ts`, built 2026-10-17, §14) stays the reference and the small-case
path; the native result must match it (VC-TMC-10). Nothing in `packages/*` imports native code: the job runs in the `server/`
solve path and its output is a hash-bound artifact. Gmsh and CalculiX are unchanged. Rust CPU, because the mapped values are
written into the deck and must be bit-reproducible (RS1 §2 rule 3).

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
| Mapping (V1), 200k target nodes on 200k-element source | ≤ 5 s (native `llull-compute post map`; the TS path's time at this size TBD — measure, VC-TMC-10) |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/thermomech/*`) | commands happy / failure / `is pure`; fits (all pairs of `fit_at_temperature.csv`); CTE conversions; analytic checks vs `expected_results.json`; deck section golden text | 01, 03, 04, 06–09, 60–63 |
| Golden | the four plans in `validation/plans/` | 01, 02, 05, 06 |
| Integration (ccx) | LE11, restrained bar, sequential thick cylinder, T1 (plane stress per 05 idealization) | 01, 02, 03, 05 |
| Agent-first | staleness chain, codes, human gate | 50, 60–63 |
| Native (`npm run native:check`; `server/tests` with `llull-compute`) | `llull-post` mapping vs `thermomech/mapping.ts` on the VC-TMC-05 meshes and a 200k-node case | 10 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `fit_at_temperature`, `thermal_stress_check`, CTE conversions (no FE) | 03 GDT M1 (PMI sizes), 08 M1–M2, CTE basis decision | 1.5 w |
| M2 | `thermo_static` (uniform / expression / thermal_result same mesh), deck sections, `check_thermo_mechanical`, staleness chain | PHY-03 M2, 05 M3, extension port (PHY-03 M0), `lib/expression` move | 2 w |
| M3 | `thermal_distortion_report`, validation (LE11, T1, bar, cylinder), golden plans, guide | M2, PHY-00 | 1 w |
| M4 (V1) | coupled procedure (steady + transient, §16), mesh mapping, Lamé in fits, orthotropic CTE (§16), fit stack-ups at temperature (§16, `stackup_at_temperature`; 03 `analyze_stackup` not built), bimetal FE (§16) | M3, 05 bonded meshes, 06 V2 | 3 w |
| RS-7 | native mapping job on `llull-bvh`, mapped-field artifact, deck hash check, VC-TMC-10 | M4, RS-0 (`solver/` workspace) | 1 w (share of RS1 RS-7) |

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
- [RS1] Native compute programme — [`../../decisions/RS1-native-compute.md`](../../decisions/RS1-native-compute.md) (step RS-7)
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
`fea_report` (stale) and `check_thermo_mechanical` (`TMC_THERMAL_RESULT_STALE`) sides and by the refused mechanical solve; its `compute_margins`
key is closed by §14.

**FE deviations:**

- **Same-mesh test:** two cases with different BCs never share a mesh hash (their node sets differ), so `thermal_result` compares nodes
  and element blocks when the hashes differ; a missing mesh or a different discretisation is still `TMC_MESH_MISMATCH`.
- **Table fields** read `{ kind: 'fe_table', rows }` from the artifact store under the artifact hash; the `fea_import_field` transport that
  writes it is built (2026-10-17, see §14).
- **LE11 needs the OCC kernel:** with Manifold the sphere tessellation gives overlapping facets in Gmsh. Initial temperatures are written
  per node (no set-name dependency). `TMC_THERMAL_CATEGORY_UNSET` is a warning (`add_fea_load` always sets a category).
- **Human gate:** `dispose_fit_result` verifies through `ctx.humanSignature`; none is installed (09 PLM), so agents get `TMC_HUMAN_GATE`.

**Still open:** the M4 remainder was built in §16 (M4b); a signing implementation (09 PLM); the `llull guide` section.

**Review fixes (2026-10-17):**

- **Thermal source is verified (05 §4.1).** `thermal_result` fields and `check_thermo_mechanical` use `trustedRecord` for the source case: stale ->
  `TMC_THERMAL_RESULT_STALE`, a summary that differs from its artifact -> `FEA_SUMMARY_MISMATCH`, no artifact store / artifact / thermal mesh ->
  `FEA_RESULTS_MISSING` (a source can no longer be used on its recorded summary alone). `thermal_distortion_report` does the same for the case itself.
- **Bounded allocation.** `temperatureProblem` rejects temperatures below absolute zero or above 1e5 K ("llull guard"); the uniform-field resolver
  re-checks it for loaded documents. `secantExpansion` evaluates both ends of the field range BEFORE building the table (a range outside the model
  validity is refused with `TMC_PROPERTY_OUT_OF_RANGE`, never sampled) and tabulates at most 1000 intervals (a wider range gets a coarser step).
- **Deck text.** Material ids, model sources, conversions and unverified reasons in the `*EXPANSION` comments pass through `commentText`;
  `loadCaseName` of `create_analysis` must match `[A-Za-z0-9_]{1,40}` (`FEA_LOAD_INVALID`).
- **Fit dispositions.** `dispose_fit_result` stores the verified `signature` with the decision so a reader can re-verify it; no read path counts
  `fitDispositions` yet (rows are always `pending_human`), so nothing trusts them.

## 14. PHY-04 closure (2026-10-17)

Built on the 05 slice; every number below was measured with Gmsh 4.15.2 and CalculiX 2.21 (`npm --prefix server test -- feaThermomech`, recorded for
`npm run quality:physics`).

| Item | What | Where |
| ---- | ---- | ----- |
| VC-TMC-50 in full | `fea_report(ms).state` = `stale`, `compute_margins(ms).code` = `FEA_RESULTS_STALE`, `check_thermo_mechanical(ms).items` = `[TMC_THERMAL_RESULT_STALE]`; judged with all three keys by a unit test on hand-built trusted artifacts and by the CLI pipeline on the thick-cylinder plan | `tests/unit/cae/thermomech/margins.test.ts`, `server/tests/feaThermomech.test.ts` |
| `compute_margins` (05 §5.8) | read-only, toolset `analysis`; see 05 TECHNICAL_SPEC §13 | `packages/domain-cae/src/margins/` |
| `fea_import_field` (TR-TMC-14, §6) | CSV `x,y,z,T` (optional header, `#` comments, comma / semicolon / tab / space) with declared `coordinatesUnit` / `temperatureUnit` -> artifact `{ kind: 'fe_table', rows }` stored under `sha256Hex(canonicalJson(artifact))` -> `set_temperature_field { source: { kind: 'table', csvSha256, rows, coordinatesUnit, temperatureUnit } }` through the command bus. Nearest-node match within 1e-6 x model size at deck time, else `TMC_FIELD_TABLE_UNMATCHED` (already in `field.ts`). CLI `llull fea_import_field analysisId=… file=T.csv coordinatesUnit=mm temperatureUnit=degC`, MCP tool of the same name (`csv` inline or `path` in the exchange directory). Guards named in code: 5e6 rows, 256 Mi characters, temperatures in [0, 1e5] K | `thermomech/tableImport.ts` (pure), `server/src/fea/feaImportField.ts`, `packages/mcp/src/feaTools.ts` |
| Coupled procedure (TR-TMC-22, steady state) | `create_analysis analysisType=coupled_temperature_displacement` (reference temperature required) holds a `ThermoMechSetup` whose `thermal` is the PHY-03 set-up: `add_thermal_bc` and the other thermal commands work on it unchanged (`thermal/access.ts` resolves `thermomech.thermal`), mechanical constraints and loads are the 05 ones. Deck: conductivity (PHY-03 tables) + secant `*EXPANSION, ZERO=<T_ref>` over the BC temperatures, `*INITIAL CONDITIONS` = T_ref, `*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE`, the 05 mechanical lines, then the thermal BCs, `*NODE FILE U, NT`, `*EL FILE S, HFL`. Not written (refused with `TMC_COUPLED_UNSUPPORTED`): cavity radiation, thermal contacts, amplitudes, h(T) film tables; no transient coupled step in this closure (built in §16). `set_temperature_field` takes `cteBasis` only on a coupled case | `thermomech/coupledDeck.ts`, `decks/deckBuilder.ts` |
| Mesh mapping (TR-TMC-23) | `set_temperature_field` `thermal_result` gains `mapping: 'same_mesh' \| 'interpolate'`. Interpolate: bounding-box tree over the thermal elements (C3D4 / C3D10, mid-edge nodes at the straight positions), the lowest element index containing the node wins, shape-function interpolation of `NDTEMP`; a node outside every element takes the value at the nearest point of the nearest element and is counted. Report in the deck comment and the field description: `maxMappingDistance`, nodes outside, coincident-node error (must be < 1e-9 of the field magnitude, else `TMC_FIELD_INVALID`); `check_thermo_mechanical` warns `TMC_MAPPING_PROJECTED` | `thermomech/mapping.ts`, `field.ts` |

Measured values (MPa):

| Case | Setup | Measured | Expected | Error |
| ---- | ----- | -------- | -------- | ----- |
| VC-TMC-01.a | coupled restrained bar, 120 degC on both ends | -251.997 | -252 | -0.001 % |
| VC-TMC-05.a / b / c | coupled thick cylinder (bore 120 degC, outer 20 degC, one analysis) | -206.926 / 133.691 / -208.399 | -209.824 / 133.033 / -209.824 | -1.4 % / +0.5 % / -0.7 % |
| VC-TMC-05.a / b / c | sequential, thermal mesh 3 mm mapped (interpolate) onto the 2 mm mechanical mesh | -206.715 / 133.261 / -208.793 | same | -1.5 % / +0.2 % / -0.5 % |
| VC-TMC-03.a / b / c | NAFEMS T1 as FE, two materials on a conformal mesh (h = 0.02 mm): hoop just outside, sigma_y at (1.005, 0), inside the disc | 50.39 / 49.89 / -49.55 | 50 / 49.5037 / -50 | +0.8 % / +0.8 % / +0.9 % |

(With a 4 mm thermal mesh the mapped bore hoop stress is -205.37 MPa, -2.1 %: the error is the coarse thermal solution, not the mapping.)

**VC-TMC-03.a / .b / .c as FE (conformal two-material model).** The earlier one-material attempt (a nodal temperature step from `fea_import_field`, 0.001 per K inside
r < 1 mm) smeared the step over the elements straddling r = a, and CalculiX averages the extrapolated element stresses at each node: the value at (1.005, 0) was mesh noise
(35.5 .. 52.9 MPa over ring sizes 0.10 .. 0.02 mm, 38 k .. 171 k nodes) and 03.a/.b were not judged. It is replaced by the two-material form of the pack's statement
(`server/tests/feaThermomechT1.test.ts`, plan `tmc_nafems_t1`):

- Geometry from commands: the disc is a quarter `revolve_profile` (r 0..1 mm), the plate a 10 x 10 mm box minus a copy of the disc (`boolean` subtract), so the two parts touch exactly
  on the quarter cylinder. Disc: E = 100 GPa, nu = 0.3, thermal strain 0.001 per K; plate: same E and nu, thermal strain 0 (alpha_bulk = 0). Reference 0 degC, uniform field 1 degC.
  Symmetry (`ux = 0` on x = 0, `uy = 0` on y = 0, per part), one `uz` pin.
- `set_mesh_controls bonding: 'conformal'` (05 §13): both parts are fragmented in one Gmsh model, so the interface nodes are shared (a bonded joint) while each part keeps
  its element set and material. The temperature step is then the material step; no table field is needed.
- A thin 3D plate is plane stress only away from the interface: within about one thickness h of it the free faces change the state (the hoop stress rises towards the
  plane-strain value; h = 0.05 mm: 59.8 MPa at r = 1.011, 62.9 at r = 1.0067 against 49.4 / 49.7). The exterior field is therefore read at the plate-only node on y = 0 nearest
  r = a + 1.5 h and moved to the probe radius with its exact law sigma_theta ~ 1/r^2 (a node shared with the disc would average two stress states and is never probed).
  03.a is the same reading moved to r = a+; 03.b to r = 1.005 mm; 03.c is the disc node nearest (0.5, 0) read as is.

Measured (global size 0.2 mm, order 2, ring refinement size = thickness h; "raw" is sigma_y at the node of radius r, "closed" is 50 (a/r)^2):

| h = ring size (mm) | nodes | node r (mm) | raw | closed | moved to 1.005 (03.b, 49.5037) | moved to a (03.a, 50) | disc (03.c, -50) |
| ------------------ | ----- | ----------- | --- | ------ | ------------------------------ | --------------------- | ---------------- |
| 0.04 | 47 k | 1.0593 | 44.93 | 44.56 | 49.92 (+0.8 %) | 50.42 (+0.8 %) | -49.55 (+0.9 %) |
| 0.02 | 75 k | 1.0298 | 47.52 | 47.15 | 49.89 (+0.8 %) | 50.39 (+0.8 %) | -49.55 (+0.9 %) |
| 0.01 (not in the suite) | 179 k | 1.0149 | 48.90 | 48.54 | 49.87 (+0.7 %) | 50.37 (+0.7 %) | -49.55 (+0.9 %) |

The remaining +0.4 MPa is the finite plate (the free edges add about 50 (a/W)^2 = 0.5 MPa, W = 10 mm: the pack notes it); the sequence is converged to 0.1 MPa. All three cases
pass the 2 % judge on both suite meshes, and are also judged analytically by `thermal_stress_check inclusion`.

## 15. RS-7 native mapping (2026-10-19)

**Built: TR-TMC-24.** `llull-compute post map` (crate `solver/crates/llull-post`, `map.rs`, on the shared `solver/crates/llull-bvh`) maps a
thermal result onto the mechanical mesh with the rules of `thermomech/mapping.ts`: same tree (median split on the widest axis, centre then index
order), same branch-and-bound visit order and TIE rule, same shape functions and report; target nodes in parallel (rayon), report reduced in node
order.

| Item | Where |
| ---- | ----- |
| Request (thermal results hash, step, scale conversion, thermal mesh hash, hash of the mechanical mesh nodes) and job buffers; the `fe_results` artifact (`solver: 'llull-compute post map'`, field `MAPPED` = T, element, distance per node) bound to the request key and the target nodes hash; the reader | `packages/domain-cae/src/thermomech/mappedField.ts` |
| The deck (`resolveTemperatureField`) uses a bound native artifact (description says `native llull-compute post map`), else maps in TS; the report of both paths comes from the shared `mappingReport` | `thermomech/field.ts`, `thermomech/mapping.ts` |
| `fea_map_field` transport, and the `fea_solve` pre-step from `LLULL_NATIVE_MAP_MIN_NODES` target nodes (default 20 000; 0 = always; never fails the solve) | `server/src/native/mapField.ts`, `server/src/fea/{feaSolve,transports}.ts` |

**Fix found on the way:** `mapNodalField` and the field check spread every node into `Math.min(...)` / `Math.max(...)`: above ≈ 120k nodes V8
throws `RangeError: Maximum call stack size exceeded`, so the TS mapping could not run at the §8 size. Both are loops now (same numbers).

**VC-TMC-10.** Element per node, distance, temperature, outside count, `maxMappingDistance` and coincident error are bit-identical (not only
1e-9) on C3D4 / C3D10 sources, offset (partly outside) and coincident targets (`solver/crates/llull-post/tests/reference.rs`) and end to end
with the binary (`server/tests/nativeTransports.test.ts`). Measured (4 vCPU): 202 776 target nodes on a 201 600-element source: TS 30.0 s,
native 1.44 s (1.64 s with job I/O) — §8 budget (≤ 5 s) met; building the request in TS (node hash, value map) takes 3.4 s at that size.

**Remote hosts (2026-10-19).** `fea_map_field` runs in `runExchangeTool` (`server/src/exchangeResult.ts`) like the FE transports, so
`llull --app` / `--server` reach it through `POST /exchange`: the job runs on the host of the live document and stores the field in that host's
`LLULL_FEA_CACHE`; same report and stored field as a local run (`server/tests/nativeExchange.test.ts`).

**Deviation:** the artifact is bound to the hash of the mechanical mesh NODES (ids + coordinates, all the mapping reads), not to the canonical
mesh artifact hash: the canonical hash of a 200k-node mesh costs 8 s in TS, the node hash 0.4–3 s.

## 16. M4b: transient coupled step, orthotropic CTE, stack-ups at temperature, bimetal FE (2026-10-19)

Built in `packages/domain-cae` (plugin `cae`, toolset `analysis`); core is touched only by additive model types (`model/analysis.ts`) and the optional
`direction` argument of `materialCteProvider`. No Gmsh, CalculiX or `llull-kernel` was available on the build host: the deck writers are proved by text
assertions, the FRD readers by hand-built fixtures, and the FE runs (`server/tests/feaThermomechTransient.test.ts`) skip with a logged reason.
**None of the FE numbers below has been measured yet**; the first run on a machine with the tools is the validation (see "Unverified").

| Item | What | Where |
| ---- | ---- | ----- |
| Transient coupled step (TR-TMC-22 transient) | A `coupled_temperature_displacement` case is transient when `set_thermal_step` gives `endTimeS` (the existing PHY-03 step: initial / min / max increment, `fixedIncrements`, `DELTMX` as `maxTemperatureChangePerIncrement`, `outputTimesS` / `outputEveryS`). Deck: `*TIME POINTS` (or `FREQUENCY=`), `*AMPLITUDE` blocks of the thermal BCs that name one (time-dependent BC amplitudes), `*STEP, INC=` + `*COUPLED TEMPERATURE-DISPLACEMENT[, DELTMX=][, DIRECT]` + the increment row, the 05 mechanical lines, the thermal BCs, `*NODE FILE[, TIME POINTS=] U, NT`, `*EL FILE S, HFL`. Conductivity **and specific heat** come from PHY-01 (`propertiesNeeded`: k, cp); density is the 05 mechanical `*DENSITY` (`Material.density`), not written twice | `thermomech/coupledDeck.ts`, `thermal/{deckStep,deckAmplitude,material,access,check,stepCommands}.ts` |
| Initial temperature | `set_initial_temperature` on the coupled case; absent = T_ref (warning `TMC_TRANSIENT_START_DEFAULTED`). CalculiX treats `*INITIAL CONDITIONS` as the stress-free state, so a start different from T_ref first runs a `*STATIC` pre-heating step (period 1, mechanical lines, `*TEMPERATURE` on every node = the start temperature), then the coupled step with `*TEMPERATURE, OP=NEW` removing that load; `TMC_TRANSIENT_PREHEAT` warns. A uniform start only: a non-uniform initial field (`set_temperature_field` source on a coupled case) stays `THM_CASE_TYPE` | `thermomech/{coupledDeck,transientCheck}.ts` |
| Results per increment | `ResultsSummary.thermomechTransient`: `series[{ timeS, maxVonMises, maxDisplacement, maxTemperature, minTemperature }]` over every written increment of the last CalculiX step that has `DISP`, `STRESS` and `NDTEMP` (the FRD reader already returns one set per increment), `peakVonMises` and `peakDisplacement` with time, position and part. `timeS` is measured from the start of the coupled step (increment total time minus the end time, so the pre-heating step does not shift it). The single `loadCases` entry (name = `loadCaseName`, category `limit`) carries the PEAK over time, so `compute_margins` uses the worst increment. `fea_report` prints `; transient: N increment(s) to t=.. s, peak von Mises .. at t=.. s`; the summary is recomputed from the artifact, so the trust path (`FEA_SUMMARY_MISMATCH`, staleness) is the existing one and the input hash moves with the time period, amplitudes and orientation (they are part of `thermomech`) | `thermomech/transientSummary.ts`, `results/summary.ts`, `commands/report.ts` |
| Refusals | `TMC_COUPLED_UNSUPPORTED` stays for cavity radiation, thermal contact conductance, h(T) film tables, and now for amplitudes on a **steady-state** step; `THM_STEP_INVALID` (more than 20000 result times, bad step); `THM_MATERIAL_NO_CP` | `thermomech/coupledDeck.ts` |
| Orthotropic CTE (TR-TMC-25) | A material whose `cte` / `thermalStrain` models name the directions `1` / `2` / `3` gets one secant table per direction on one temperature grid, written `*EXPANSION, TYPE=ORTHO, ZERO=<T_ref>` with rows `a1, a2, a3[, T]` (a constant direction repeats on the grid of the others); provenance (source, basis, model sha256) per direction in comments. PHY-01 / CTE basis rules are unchanged: `thermalStrain` first, a `cte` model needs `cteBasis[material]` (one basis per material, all three directions), else `TMC_CTE_BASIS_UNKNOWN`; a missing direction is `TMC_CTE_ORTHO_INCOMPLETE`. Both `thermo_static` and coupled cases. Elasticity stays isotropic (05 cards): `TMC_CTE_ORTHO_ELASTIC_ISOTROPIC` warning | `thermomech/{orthoCte,orthoCheck,deck}.ts`, `model/materialCte.ts` (`direction`) |
| Material orientation | `set_material_orientation { analysisId, entityId, axis1, axis2 }` (document frame; Gram-Schmidt stored; no axes removes it) -> `ThermoMechSetup.orientations`; deck `*ORIENTATION, NAME=OR_<part>, SYSTEM=RECTANGULAR` (`a_x, a_y, a_z, b_x, b_y, b_z`) and `ORIENTATION=` on that part's `*SOLID SECTION` (`DisciplineTable.orientation`). Default directions are the document X, Y, Z; an orthotropic part with a non-zero rotation and no orientation is `TMC_ORIENTATION_REQUIRED` (as the orthotropic conductivity of PHY-03). Bad input `TMC_ORIENTATION_INVALID` | `thermomech/orientation.ts`, `decks/deckBuilder.ts` |
| Fit stack-ups at temperature | `stackup_at_temperature` (query, read-only): one-dimensional chain of contributors `{ name, nominal, upper, lower, sensitivity, material or cte, verified? }` at `specTemperature` (never defaulted) and `temperatures` (1 to 50). Every limit dimension scales `D(T) = D_spec (1 + a_sec (T - T_spec))` (so the spec row reproduces the typed limits); gap = sum of sensitivity x dimension; worst case = sum of |s| half tolerance, RSS = sqrt(sum (s half)^2) with sigma = half / k (`sigmaPerHalfTolerance`, named default 3, `defaulted` in the provenance); optional `lowerSpecLimit` / `upperSpecLimit` give `within_worst_case`, `within_rss_only` (`TMC_STACKUP_WC_EXCEEDED`, pending human) or `outside` (`TMC_STACKUP_OUT_OF_SPEC`); `shiftFromSpec`, contribution percentages, `unverified` (explicit CTE, typed limits unless `verified: true`), `reviewRequired: true`, assumptions | `thermomech/stackup.ts` |
| Lame in fits | Already built in M1: `fit_at_temperature { lame }` (TR-TMC-21, VC-TMC-09.a-c); nothing missing | `commands/thermomech/fitAtTemperature.ts` |
| Bimetal FE (VC-TMC-04, TR-TMC-13) | Plan `validation/plans/tmc_bimetal_cantilever.plan.json` (copy in `server/tests/fixtures/thermomech/`): two 50 x 1 x 0.5 mm boxes stacked at z = 0.5 (E 200 / 100 GPa, alpha 12 / 19 ppm per K via `thermalStrain`, reference 20 degC, uniform field 120 degC), each clamped at x = 0, `set_mesh_controls bonding: conformal` (shared interface nodes), two probes at the tip interface corners. Judged: tip = -mean(uz) against VC-TMC-04.b (1.27273 mm, 3 %) and kappa = 2 tip / L^2 against VC-TMC-04.a (1.018182e-3 1/mm, 2 %). The plan, its pack inputs and its deck (one material per layer, `*EXPANSION, ZERO=20` 1.2e-5 / 1.9e-5, `*ELASTIC` 200000 / 100000, interface nodes shared by both element blocks) are proved without a solver | `tests/unit/cae/thermomech/bimetal.test.ts`, `server/tests/feaThermomechTransient.test.ts` |

**Deviations and dependencies (recorded, not silent):**

- **03 GDT is not built.** There is no `analyze_stackup`, no `add_size_dimension` and no PMI: the stack-up of this pack is a self-contained command with typed limits
  (the 03 contributor shape `{ name, nominal, upper, lower, sensitivity, verified }` is kept so a later `analyze_stackup` can take over the at-temperature scaling by
  passing the scaled limits, or the command can delegate to it). It has worst case and RSS only: no Monte Carlo, no expression mode, no PMI link, and every typed
  contributor is `unverified` by default (03 TR-GDT-21). Open: when 03 lands, decide between delegating to `analyze_stackup` and keeping this command as the
  thermal front end.
- **Transient set-up lives in `set_thermal_step`.** A coupled case is transient iff `thermal.step.endTimeS` is set; there is no command that returns it to steady
  state (create a new case). The thermal BC amplitudes drive the temperatures; mechanical loads and constraints are not amplitude-controlled (CalculiX default
  step / ramp behaviour of `*BOUNDARY` / `*CLOAD` in a coupled step; the thermal deck of PHY-03 makes the same choice).
- **Density.** A transient coupled step writes the 05 mechanical `*DENSITY` only; PHY-01 `density` models are not used (a `density` model that differs from
  `Material.density` is ignored for the heat capacity).
- **Result time.** The series time is `increment time - end time of the coupled step`, which assumes only that the last increment of the step is the end time;
  it holds whether CalculiX writes total or step time to the FRD.
- **Orthotropic cases are not covered by `fit_at_temperature` / `thermal_stress_check`:** their material directions are not selectable there (an orthotropic
  material gives the PHY-01 ambiguity refusal).
- **Unverified (no solver on the build host).** (1) the pre-heating step: that the temperatures of a `*STATIC` + `*TEMPERATURE` step carry over as the initial
  state of the next `*COUPLED TEMPERATURE-DISPLACEMENT` step and that `*TEMPERATURE, OP=NEW` without data lines is accepted; (2) `*EXPANSION, TYPE=ORTHO` with an
  isotropic `*ELASTIC` and `*ORIENTATION` through `ORIENTATION=` on the solid section; (3) the bimetal and transient-bar numbers. The server tests assert them
  when Gmsh, CalculiX and `llull-kernel` are present; a failure there is a defect of the written deck to fix, not a tolerance to widen.

**Still open:** a non-uniform initial temperature field for a transient; orthotropic stiffness (E1/E2/E3, `*ELASTIC, TYPE=ORTHO` from 06 laminates); amplitudes on
mechanical loads; the `llull guide` section; a signing implementation (09 PLM).

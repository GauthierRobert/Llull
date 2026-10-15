# PHY-14 — Moisture, outgassing & space environment — Technical spec

Gap id **ENV** · Status: specification (no implementation) · Written 2026-10-15
Functional: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

---

## 1. Current state in llull

| Area | File(s) | Today / after aerospace | Limit |
| ---- | ------- | ----------------------- | ----- |
| Material (today) | `packages/core/src/model/types.ts` `Material { name, density, color, metalness, roughness, finish? }` | density only | no environmental property |
| Mass (today) | `packages/core/src/commands/inspect/measureSolid.ts` `mass_properties` | volume × density per part / instance child | feeds the mass-loss budget |
| 08 MAT record | `model/material.ts` `PropertyValue` with `MaterialPropertyName` = density, E, Ec, G, nu, Ftu, Fty, Fcy, Fsu, Fbru, Fbry, elongation, cte, k, cp; temperature tables; `unverified` | the place for new property names | no TML/CVCM/WVR/D/Mm/β/Ey |
| 06 CMP | `LaminaMaterial { E1, E2, G12, nu12, …, density, basis, source }`; V2 hygrothermal CTE/CME loads; `analyze_laminate` summary says "no hygrothermal" | lamina β not yet a field | PHY-14 must not duplicate the V2 load path |
| PHY-01 | `model/propertyModel.ts` (owned by PHY-01): table / fit with valid range | D(T), Mm(RH) evaluation | — |
| PHY-03 / PHY-04 | CalculiX heat transfer; sequential thermal → static with thermal strain | receives an equivalent ΔT field | — |

`grep -rliw "outgassing\|TML\|CVCM\|moisture" packages src server/src` → nothing.

## 2. Target architecture

### 2.1 Placement (proposal, pending README §5.1)

| Concern | Layer | Why |
| ------- | ----- | --- |
| Property names `TML`, `CVCM`, `WVR`, `RML`, `moistureDiffusivity`, `moistureSaturation`, `cme`, `aoErosionYield` (+ COULD `radiationDoseLimit`, `uvExposureLimit`) | **additions to the 08 MAT `MaterialPropertyName` list**; `PropertyValue` gains an optional `testMethod` qualifier (08 owns the shape); temperature / humidity dependence through PHY-01 `PropertyModel` | README §6.2 |
| Lamina directional CME β1, β2 | **addition to 06 CMP `LaminaMaterial`** (V2 hygrothermal fields), not redefined here | 06 owns lamina data |
| Limit profiles, AO reference data | `packages/domain-physics/data/environment/*.json` (from `validation/environment_rules.json`) | AF-30 |
| Mission environment | plugin slice `physics.environment` via `DocumentExtension` | plugin data |
| Fick solver, hygro strain, AO arithmetic | `@phys/environment/fick.ts`, `hygro.ts`, `atomicOxygen.ts` (pure) | L2 |
| Commands | `@phys/environment/commands/`, `CadPlugin { name: 'spaceEnvironment', toolset: 'environment' }` | L10 |
| Mass for budgets | `mass_properties` via `ctx.registry` + `execute` | plugin composes core commands |
| NASA CSV import | host transport `register_material_library file=…` (08) + a pure converter `outgassingCsvToLibrary` in `@phys` | files are host side (L6) |

### 2.2 Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-ENV-01 | MUST | Units: % for TML/CVCM/WVR/RML/M (mass fraction × 100); D in length²/time (mm²/s, m²/s, in²/h via `lib/quantity.ts`); β in 1/% (or 1/(mass fraction)); Ey in cm³/atom; fluence in atoms/cm² | FR-ENV-01, 06, 10 |
| TR-ENV-02 | MUST | Profiles evaluated with the stored operator (`<` or `≤`); equality handled with an absolute guard 1e-12 % | FR-ENV-02 |
| TR-ENV-03 | MUST | RML resolution: measured `RML` → TML − WVR (`derived: true`) → missing | FR-ENV-01 |
| TR-ENV-04 | SHOULD | Budget: `massLoss = TML/100 × mass`, `condensable = CVCM/100 × mass`, mass from `mass_properties` (unit from 08 TR-MAT-02) | FR-ENV-04 |
| TR-ENV-05 | MUST | Fick plane sheet §5.1: series until a term < 1e-17, inverse by bisection to rel 1e-12 in τ; one face sealed ⇔ two faces with 2h | FR-ENV-06 |
| TR-ENV-06 | SHOULD | D(T) / Mm(RH,T) evaluated by PHY-01; out of range ⇒ PHY-01 `PROP_OUT_OF_RANGE` forwarded | FR-ENV-07 |
| TR-ENV-07 | SHOULD | `hygro_strain` equivalent-temperature analogy only when βᵢ/αᵢ is equal in all directions within rel 1e-9 | FR-ENV-08 |
| TR-ENV-08 | SHOULD | AO: recession = Ey·F (cm → µm); mass loss = ρ·A·Ey·F; every input carries source | FR-ENV-10 |
| TR-ENV-09 | MUST | Check items with code, values, profile/rule source, `unverified`, `reviewRequired: true` | FR-ENV-12, 13 |
| TR-ENV-10 | MUST | `set_mission_environment` pure, one FeatureStep; human-gated `approve_environment_deviation` through the 09 signature port | FR-ENV-09, 13 |
| TR-ENV-11 | SHOULD | CSV converter maps each row to one record, property values with `testMethod: 'ASTM_E595'`, provenance `{ sourceId: 'nasa-outgassing', locator: <sample id>, note: <dataset version> }`; unknown columns ignored with a warning list | FR-ENV-15 |

## 3. Data model

### 3.1 Property payloads (08 shape, PHY-14 names)

```ts
// PropertyValue.property additions (08 MaterialPropertyName):
//   'TML' | 'CVCM' | 'WVR' | 'RML' | 'moistureDiffusivity' | 'moistureSaturation' | 'cme' | 'aoErosionYield'
// PropertyValue gains (08-owned optional qualifiers):
interface EnvironmentQualifiers {
  readonly testMethod?: 'ASTM_E595' | 'ECSS_Q_ST_70_02';
  readonly relativeHumidity?: number;          // % RH for moistureSaturation points (or via PHY-01 model inputs)
  readonly direction?: 'isotropic' | '1' | '2' | '3';   // cme for orthotropic solids (lamina β stays in 06)
}
```

### 3.2 Profiles and mission environment

```ts
export interface OutgassingProfile {
  readonly id: string; readonly label: string;
  readonly limits: readonly { readonly quantity: 'TML' | 'CVCM' | 'RML' | 'WVR'; readonly op: '<' | '<='; readonly value: number; readonly unit: '%' }[];
  readonly testMethod: 'ASTM_E595' | 'ECSS_Q_ST_70_02';
  readonly source: string; readonly status: 'verified' | 'secondary' | 'company';
}
export interface MissionEnvironment {                    // CadDocument.physics.environment
  readonly outgassingProfile?: string | OutgassingProfile;   // id of a shipped profile or a custom one
  readonly humidityExposure?: { readonly relativeHumidity: number; readonly temperature: { value: number; unit: string };
    readonly duration: { value: number; unit: string }; readonly faces: 'both' | 'one'; readonly source: string };
  readonly aoFluence?: { readonly value: number; readonly unit: 'atoms/cm^2'; readonly source: string };
  readonly exposedFaces?: Readonly<Record<string /* entityId */, readonly number[] /* face indices */>>;   // V1, AO area
  readonly deviations: Readonly<Record<string, { readonly itemKey: string; readonly justification: string; readonly signatureId: string }>>;
}
```

Document version: optional `physics` slice, an addition to the aerospace v3 envelope (`migrate2to3`: absent ⇒
empty). PHY-13 and PHY-14 share the `physics` top-level key with distinct sub-keys (`corrosion`,
`environment`); the `DocumentExtension` of each plugin validates only its sub-key.

### 3.3 Results

```ts
export interface UptakeResult {
  readonly model: 'fick_plane_sheet'; readonly faces: 'both' | 'one'; readonly mode: 'absorption' | 'desorption';
  readonly tau: number; readonly fraction: number; readonly moisturePercent: number;
  readonly timesToFraction: readonly { readonly fraction: number; readonly tau: number; readonly time: { value: number; unit: string } }[];
  readonly curve: readonly { readonly t: number; readonly fraction: number }[];   // AF-21, 50 log-spaced samples
  readonly inputs: Record<string, { value: number; unit: string; source?: string }>; readonly unverified: boolean;
}
export interface HygroStrainResult { readonly strain: number | readonly number[]; readonly equivalentDeltaT?: { value: number; unit: 'K' };
  readonly handOff: 'phy04_equivalent_temperature' | 'cmp06_laminate' | 'none'; readonly unverified: boolean }
export interface AoErosionResult { readonly recessionUm: number; readonly massLossG?: number; readonly inputs: Record<string, unknown>; readonly unverified: boolean }
```

## 4. Commands (plugin `spaceEnvironment`, toolset `environment`)

| Command | Kind | Params sketch | Tags |
| ------- | ---- | ------------- | ---- |
| `set_mission_environment` | mutating | `{ outgassingProfile?: string \| OutgassingProfile, humidityExposure?, aoFluence?, exposedFaces? }` | `@affects physics.environment` `@invariant replaces only the given keys` `@failure unknown profile id → ENV_PROFILE_UNKNOWN; fluence without source → ENV_SOURCE_MISSING` |
| `check_space_environment` | query (AF-20) | `{ entityIds?: string[], profile?: string }` | `@affects none; data = { status, profile, items[], budget: { perPart[], totalMassLossG, totalCondensableG } }` `@failure no profile in params or document → ENV_PROFILE_UNSET (exit 1)` |
| `moisture_uptake` | query (pure math; optional `material` resolves D, Mm from 08/PHY-01) | `{ thickness: {value,unit}, diffusivity?: {value,unit}, saturation?: {value,unit}, initial?: {value,unit}, exposure?: {value,unit}, faces: 'both'\|'one', mode?: 'absorption'\|'desorption', targets?: number[], material?: string, temperature?, relativeHumidity? }` | `@affects none; data = UptakeResult` `@failure thickness/D ≤ 0 → ENV_PARAM_INVALID; neither D nor material → ENV_PROPERTY_MISSING; target ∉ (0,1) → ENV_PARAM_INVALID` |
| `hygro_strain` | query | `{ beta: {value,unit} \| { material }, deltaMoisture: {value,unit}, alpha?: {value,unit} }` | `@affects none; data = HygroStrainResult` `@failure orthotropic with unequal β/α → ENV_EQUIVALENT_TEMPERATURE_INVALID (strain still returned)` |
| `ao_erosion` | query | `{ material?: string, erosionYield?: {value,unit,source}, fluence?: {value,unit,source}, area?: {value,unit}, density?: {value,unit,source}, entityId? }` | `@affects none; data = AoErosionResult` `@failure no Ey → ENV_PROPERTY_MISSING; no fluence (param or mission) → ENV_FLUENCE_UNSET` |
| `approve_environment_deviation` | mutating, **human gate** | `{ itemKey, justification, signature }` | `@affects physics.environment.deviations` `@failure agent caller / invalid signature → ENV_HUMAN_GATE` |

## 5. Algorithms

### 5.1 Fick plane sheet

Plate of thickness h, both faces held at Mm from t = 0, uniform initial Mi, constant D (Crank plane sheet; used
by Shen & Springer for composites [S14][S15]):

G(τ) = (M − Mi)/(Mm − Mi) = 1 − (8/π²) Σ_{j≥0} exp(−(2j+1)² π² τ)/(2j+1)², τ = D t/h².

- Terms are summed until a term < 1e-17 (named numeric default); at τ = 1e-3 this needs ~10³ terms, which
  is cheap. For τ < 1e-4 the short-time form G = (4/√π)·√τ is used (relative difference to the series < 1e-6
  from 1e-6 ≤ τ ≤ 1e-3, VC-ENV-03).
- Inverse (time to fraction g): bisection on τ in [1e-12, 10]; τ₅₀ = 0.0491826848809, τ₉₀ = 0.212021352012,
  τ₉₉ = 0.445321998467 (VC-ENV-01).
- **One face sealed** (`faces: 'one'`): equivalent to both faces exposed on a plate of thickness 2h (the sealed
  face is the symmetry plane), so τ = D t/(2h)² (VC-ENV-16).
- **Desorption**: same G with Mm replaced by the dry boundary value (Mm = 0 for vacuum dry-out).
- **Edge effects** of finite plates (Shen & Springer edge correction) are not applied; the result states
  `assumption: "1D, edges sealed or h ≪ width"`.

### 5.2 Outgassing screening and budget

For each material in use: resolve TML, CVCM, WVR (preferred PropertyValue, 08); RML per TR-ENV-03; compare with
each profile limit using its operator. Example (synthetic): TML 1.20, CVCM 0.02, WVR 0.40 ⇒ NASA fail (TML),
ECSS pass (RML 0.80) (VC-ENV-06.2); TML 1.00, CVCM 0.10, WVR 0 ⇒ NASA pass (≤), ECSS fail (RML and CVCM, <)
(VC-ENV-06.4). Budget per part: TML × mass and CVCM × mass (200 g, 0.95 %, 0.05 % ⇒ 1.9 g, 0.1 g, VC-ENV-07).

### 5.3 Hygroscopic strain and the hand-off

ε = β·ΔM (β per %). Equivalent temperature for a thermal-strain solver: α·ΔT_eq = β·ΔM ⇒ ΔT_eq = β ΔM/α. This
reproduces the strain field exactly only if β_i/α_i is the same in every principal direction (isotropic, or a
proportional orthotropic material); otherwise `ENV_EQUIVALENT_TEMPERATURE_INVALID` and the laminate path of 06
V2 applies (06 owns β1/β2 on `LaminaMaterial` and the hygrothermal load resultants). Example: β 0.001 /%,
ΔM 1.2266 %, α 30e-6 /K ⇒ ε = 1.2266e-3, ΔT_eq = 40.887 K (synthetic, VC-ENV-05). The moisture state passed
on is uniform-average M (1D model); through-thickness gradients are a V2 FE item (PHY-03 heat-transfer analogy).

### 5.4 Atomic oxygen

Recession d = Ey·F; mass loss Δm = ρ·A·Ey·F. Kapton H Ey = 3.0e-24 cm³/atom (grade A, S9 + S10; with the S9/S11
caveat that Ey depends on exposure conditions). F = 1e21 atoms/cm² ⇒ 3.0e-3 cm = 30.0 µm (VC-ENV-08);
MISSE 2 fluence 8.43e21 (B) ⇒ 252.9 µm (VC-ENV-09). Exposed area: user value, or (V1) the area of faces listed
in `exposedFaces` from the kernel topology.

### 5.5 Tolerances

| Quantity | Tolerance |
| -------- | --------- |
| G(τ), τ inverse | rel 1e-9 |
| Short-time form vs series (τ ≤ 1e-3) | rel 1e-6 |
| Budget, AO arithmetic | rel 1e-12 (closed form) |

## 6. Interop & persistence

- NASA outgassing CSV → `*.llull-matlib.json` via the converter (TR-ENV-11); one record per sample row (the
  database is per tested sample/lot), `licence` from the dataset metadata (`us-pd` per mirror tag; confirm,
  OQ-ENV-03). Stored `embedded` or `private` per 08 rules.
- Check report: `--save space_env.csv` (part, material, profile, TML, CVCM, RML, status, code, budget).
- No STEP mapping.

## 7. Surfaces and codes

CLI: registry commands (AF-01); `llull guide` gains a space-environment section (profiles, what E595 is, why
budgets are screening). MCP: toolset `environment`. UI: materials table and uptake curve (review).

### 7.1 Stable codes (AF-11)

| Code | Severity | When | Ids | Remediation |
| ---- | -------- | ---- | --- | ----------- |
| `ENV_PROFILE_UNSET` | error | check without profile | — | `set_mission_environment outgassingProfile=…` |
| `ENV_PROFILE_UNKNOWN` | error | unknown profile id | param | `list` profiles in `llull describe` / custom profile |
| `ENV_SOURCE_MISSING` | error | fluence, Ey, density or custom limit without source | param path | add `source` |
| `ENV_OUTGASSING_DATA_MISSING` | unknown (item) | material in use lacks TML/CVCM (or RML/WVR for ECSS) | material, entities | `set_material_property` from a test report or the NASA data |
| `ENV_OUTGASSING_FAIL` | fail (item) | a limit is exceeded | material, quantity | choose another material or obtain a deviation (human) |
| `ENV_TEST_METHOD_MISMATCH` | warning | data from E595 judged by an ECSS profile or vice versa | material | use data from the profile's method |
| `ENV_RML_DERIVED` | info | RML computed as TML − WVR | material | — |
| `ENV_PARAM_INVALID` | error | non-positive thickness/D, fraction outside (0,1) | param | fix the value |
| `ENV_PROPERTY_MISSING` | error | D, Mm, β or Ey not given and not on the material | material, property | add the property |
| `ENV_FLUENCE_UNSET` | error | AO query without fluence | — | pass `fluence` or set it in the mission |
| `ENV_EQUIVALENT_TEMPERATURE_INVALID` | warning | β/α not proportional | material | use the 06 V2 laminate hygrothermal path |
| `ENV_MODEL_ASSUMPTION` | info | 1D Fick, edges ignored | — | — |
| `ENV_VALUE_UNVERIFIED` | warning (not suppressible) | synthetic / typical / secondary input | material, property | replace with sourced data |
| `ENV_HUMAN_GATE` | error | deviation approval by an agent or without a valid signature | item | ask the qualified reviewer |

### 7.2 Agent-first compliance

AF-01–05 registry commands with `{value, unit}` params and plans; AF-10/12/13 `data` shapes §3.3, CSV via `--save`,
deterministic; AF-11 §7.1; AF-20 `check_space_environment`; AF-21 `curve` samples; AF-30 profiles as data;
AF-31 no defaults for limits or environment; AF-32/33 flags on items; AF-34 `approve_environment_deviation`;
AF-35/36 inputs and sources in data, plain summary; AF-41 offline (the CSV is a local file).

## 8. Performance budgets

| Operation | Budget |
| --------- | ------ |
| `moisture_uptake` with 3 targets + 50-point curve | ≤ 5 ms |
| `check_space_environment` 500 parts / 100 materials (mass cached) | ≤ 500 ms |
| NASA CSV conversion, ~13,000 rows | ≤ 3 s |

## 9. Test strategy

| Level | Location | Covers |
| ----- | -------- | ------ |
| Unit | `tests/unit/physics/environment/fick.test.ts` | VC-ENV-01…04, 16 from `expected_results.json` |
| Unit | `…/hygro.test.ts`, `…/atomicOxygen.test.ts` | VC-ENV-05, 08…10, 13 |
| Unit | `…/checkSpaceEnvironment.test.ts` | VC-ENV-06, 07, 11, 12, 14; `is pure` for `set_mission_environment` |
| Unit | `…/outgassingCsv.test.ts` | VC-ENV-15 with a 3-row fixture written by the test (no NASA data committed) |
| Contract | `tests/unit/contract/` | toolset, schema snapshot, `DocumentExtension` round trip of `physics.environment` |
| Golden | `tests/golden/plans.ts` | `outgassing_check` plan |
| Quality gate | `npm run quality` | `generate_environment_reference.py --check` |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 | 08 property additions (TML, CVCM, WVR, RML), profiles data, `set_mission_environment`, `check_space_environment` outgassing + budget | 08 M2 | 4 d |
| M2 | `moisture_uptake`, `hygro_strain` (+ PHY-01 D/Mm models) | PHY-01 | 3 d |
| M3 | `ao_erosion`, exposed faces from topology | 01 KRN topology | 2 d |
| M4 | NASA CSV converter, deviation human gate | 08 M3, 09 | 3 d |
| M5 | Hand-off contract with PHY-04 and 06 V2 (equivalent ΔT field / laminate moisture state) | PHY-04, 06 M6 | 2 d |

MVP (M1) ≈ 4 d; V1 (M2–M5) ≈ 10 d.

## 11. Open questions

| Id | Question | Proposed default |
| -- | -------- | ---------------- |
| OQ-ENV-01 | NASA screening operator: "maximum 1.0 %" (database, ≤) vs PD-1410 "< 1.0 %" | ≤ for `nasa_gsfc_screening` (database wording); a strict profile can be added |
| OQ-ENV-02 | Should ECSS RML criteria accept E595 data with WVR (no 55 % RH preconditioning)? | No: `ENV_TEST_METHOD_MISMATCH` warning, computed anyway |
| OQ-ENV-03 | Licence of the NASA outgassing dataset (mirror tag `us-pd`): may llull bundle a converted copy? | Not until confirmed on data.nasa.gov; user imports the CSV |
| OQ-ENV-04 | Where does lamina β live: 06 V2 `LaminaMaterial` fields (proposed) or 08 `cme` with direction? | 06 for laminae, 08 `cme` for isotropic/orthotropic solids |
| OQ-ENV-05 | 2D/3D moisture diffusion via the PHY-03 heat-transfer analogy (CalculiX) | V2 |
| OQ-ENV-06 | UV / radiation limits (COULD): which data source? | Defer; no source searched |

## 12. References

See FUNCTIONAL_SPEC §11 [R1]–[R13] and `validation/sources.md` [S1]–[S17]. Additionally:

- [T1] 06 CMP TECHNICAL_SPEC §3 `LaminaMaterial`, §5.3 ("no hygrothermal") — `docs/aerospace/06-composites/TECHNICAL_SPEC.md`
- [T2] Physics gap list and pack conventions — `docs/physics/README.md` §6

# PHY-15: Electrical, magnetic, optical & radiative properties — technical specification

Gap id **EOP** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit |
| ---- | ----------- | ---- | ----- |
| Today's material | `Material { name, density, color, metalness, roughness, finish? }`; `finish` is a procedural render texture (`carbon_twill`, `brushed`, …) | `packages/core/src/model/types.ts` (`Material`, `FINISH_PATTERNS`) | Visual only; no physical surface property |
| Today's code | `grep -ril "emissiv\|resistivity"` over `packages/*/src`, `server/src` finds nothing | — | — |
| After 08 MAT (spec) | `MaterialPropertyName = 'density' \| 'E' \| … \| 'cte' \| 'k' \| 'cp'`; `PropertyValue` with basis, direction, temperature, provenance; `finish` code on the render material; private libraries | 08 TECHNICAL_SPEC §3.1 | No electrical / optical names |
| After PHY-01 (spec) | `PropertyModel` on `MaterialRecord.propertyModels?` (`model/propertyModel.ts`), catalogue `model/propertyCatalog.ts`, consumer API `resolvePropertyModel` / `evaluatePropertyModel` / `tabulatePropertyModel` | `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3 | Owner of storage and evaluation; this pack appends catalogue rows |
| After 05 / PHY-03 (spec) | `FeaTarget.facesNear`; radiation BC with `emissivity: number \| { fromProperty: 'emissivityIr' }` | PHY-03 TECHNICAL_SPEC §3.1 | Needs a face-level ε source |
| Bundled CalculiX | `*ELECTRICAL CONDUCTIVITY`, `*MAGNETIC PERMEABILITY`, `*ELECTROMAGNETICS` | [R12] | V2 only |

## 2. Target architecture

```
packages/core/src/model/
   propertyCatalog.ts (PHY-01) + the PHY-15 rows of §3.1;  propertyModel.ts (PHY-01) + requested variables / condition fields
   surface.ts (new, data only) SurfaceCoatingAssignment, BondPath, LightningZoneLabel   (like model/building.ts)
packages/domain-physics/src/electroOptical/   CadPlugin "electro_optical", toolset "analysis"
   commands/ assign_surface_coating, remove_surface_coating, define_bond_path, delete_bond_path, set_lightning_zone (V1),
             dispose_bond_check (human gate), (queries) electrical_resistance, check_bonding, shield_absorption,
             optical_balance, normal_reflectance, check_surface_properties
   conversions.ts (IACS, S/m ↔ Ω·m, temperature models)   formulas.ts (pure, = generator)
   surfaceResolve.ts  face → coating → property (used by PHY-03's thermal extension through core types only)
```

Placement and laws as PHY-03 §2.1 (`@phys` sees core only). The PHY-03 thermal extension resolves `emissivity: 'material'`
through a pure core-level helper over `model/surface.ts` and PHY-01 `resolvePropertyModel` / `evaluatePropertyModel` (no plugin-to-plugin import).
L9: face resolution (`facesNear`) and V1 part-path geometry use `ctx.kernel` (`requiresKernel`).

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-EOP-01 | MUST | The §3.1 rows are appended to PHY-01's `PROPERTY_CATALOG` (`model/propertyCatalog.ts`); values are stored as PHY-01 `PropertyModel`s (`define_property_model`) or 08 scalars, and read only through `resolvePropertyModel` / `evaluatePropertyModel`. This pack owns their semantics and validation. |
| TR-EOP-02 | MUST | Validation on `set_material_property` / `define_property_model` (PHY-01 / 08 validation hook, catalogue `positive` flag plus the §3.1 ranges) per §5.1; refusal leaves the document unchanged with the code. |
| TR-EOP-03 | MUST | `CadDocument.surface?: SurfaceModel` (§3.2), optional, plugin `document.validate` checks ids, targets and record references. No version bump (aerospace v3 envelope). |
| TR-EOP-10 | MUST | IACS conversions with the constant 1.7241e-8 Ω·m (100 % IACS, 20 °C) named in `data`; S/m ↔ Ω·m reciprocal; conversion recorded in provenance. |
| TR-EOP-11 | MUST | `electrical_resistance` DC: R = ρ(T)L/A; ρ(T) from a PHY-01 model, or linear `temperatureCoefficientOfResistivity` model ρ20(1 + αR(T − 20 °C)), or constant (then `temperatureModel: 'none'` reported). |
| TR-EOP-12 | MUST | Skin depth δ = √(ρ / (π f μ0 μr)) with μ0 = 4π × 10⁻⁷ N/A² named; round-wire AC ratio r/(2δ) returned with `validity { rOverDelta, approximate: rOverDelta < 5 }`; for r/δ < 1 the ratio is reported as 1 (DC regime) and flagged. |
| TR-EOP-13 | SHOULD | `shield_absorption`: A = 20 log10(e) · t/δ dB; result states "absorption term only". |
| TR-EOP-20 | MUST | `check_bonding`: per path Σ element resistances (joint values as given; strap = ρ(T)L/A; V1 part = ρ · straight-line length / mean cross-section from the kernel, flagged `approximate`), share per element, status vs limit; CFRP detection (record `productForm` / a `composite` flag) ⇒ `EOP_CFRP_IN_PATH`. |
| TR-EOP-21 | MUST | Bond limits are rule entries `{ value, unit, ruleId, source, unverified }`; a limit given without `source` is refused; no default limit exists. |
| TR-EOP-22 | MUST | `dispose_bond_check` verifies a human-held signature through the 09 signing port; agents get `EOP_HUMAN_GATE`. |
| TR-EOP-30 | MUST | `optical_balance`: T = (α S / (n ε σ))^(1/4) with σ from exact SI constants (PHY-03 VC-THM-13), α at the requested BOL/EOL condition, ε hemispherical total; S required (`EOP_SOLAR_FLUX_MISSING`); returns α/ε, T in K and °C, formula, assumptions (flat plate, no conduction, no albedo / planet IR). |
| TR-EOP-31 | COULD | `normal_reflectance`: R = ((n1 − n2)/(n1 + n2))², slab T = (1 − R)/(1 + R) (lossless, incoherent), n at the requested wavelength. |
| TR-EOP-32 | MUST | Surface resolution for PHY-03: face → assigned coating (side matching the BC face) → `emissivityIr` evaluated at the face's temperature range (table / model) → value + provenance + `unverified`; no coating ⇒ the part's bulk record ε; none ⇒ `EOP_SURFACE_PROPERTY_MISSING`. |
| TR-EOP-40 | MUST | Stable codes §7.1; agent-first fields (units, provenance, `unverified`, `reviewRequired`). |

## 3. Data model

### 3.1 Property catalogue rows, variables and conditions (PHY-01 `model/propertyCatalog.ts`)

PHY-01 owns storage (`MaterialRecord.propertyModels?: PropertyModel[]` in `model/propertyModel.ts`) and evaluation
(`resolvePropertyModel` / `evaluatePropertyModel` / `tabulatePropertyModel` in `model/propertyModelEval.ts`, never
extrapolating: `PROP_OUT_OF_RANGE`). PHY-01 TECHNICAL_SPEC §3.2 says each pack appends its own `PROPERTY_CATALOG` rows;
this pack appends (`ownerPack: 'PHY-15'`):

| `name` | `dimension` (08 grammar) / `canonicalUnit` | `positive` | Valid range (checked by this pack, TR-EOP-02) | Variables (`PropertyVariable`) | Condition / direction |
| ------ | ------------------------------------------ | ---------- | --------------------------------------------- | ------------------------------ | --------------------- |
| `electricalResistivity` | `M L^3 T^-3 I^-2` / `ohm*m` | true | > 0 | `T` | `direction`: PHY-01 `PropertyDirection` (`L`, `LT`, `ST`, `1`, `2`, `3`, `normal`) for anisotropic laminates; input aliases `electricalConductivity` (S/m) and `percentIacs` (%), converted and recorded in provenance |
| `temperatureCoefficientOfResistivity` | `Θ^-1` / `1/K` | false | finite | — (constant form) | `condition.note` must name the reference temperature (`referenceTemperature=…`) |
| `relativePermeability` | `1` / `1` | true | > 0; < 1 only with `condition.note` containing `diamagnetic` | `T`, **`frequency`** (new variable, requested from PHY-01) | — |
| `emissivityIr` | `1` / `1` | false (0 allowed) | [0, 1] | `T` | **`condition.opticalKind`**: `'hemispherical_total' \| 'normal_total'` (new `PropertyCondition` field, mandatory) |
| `absorptivitySolar` | `1` / `1` | false | [0, 1] | — | **`condition.lifeState`**: `'BOL' \| 'EOL'` (new field, mandatory); exposure described in `condition.environment` |
| `refractiveIndex` | `1` / `1` | true | ≥ 1 | **`wavelength`** (new variable, mandatory) | — |

Additions requested from PHY-01 (it owns the unions): `PropertyVariable` gains `'wavelength'` and `'frequency'`;
`PropertyCondition` gains `opticalKind?` and `lifeState?`. Each model keeps the 08 `basis` and `provenance`; basis
`typical` is `unverified` (08 / PHY-01 rule), and every result here ORs the evaluations' `unverified` flags (PHY-01 §3.3).

### 3.2 Surface model (core `model/surface.ts`, data only)

```ts
export interface SurfaceCoatingAssignment {           // id 'sc-<step>.<k>'
  readonly id: string; entityId: EntityId; facesNear: readonly Vec3[];   // re-resolved on replay (05 TR-FEA-03 rules)
  coatingRecordId: string;                            // 08 MaterialRecord with productForm 'coating'
  side?: 'outer';                                     // MVP: the exposed side of the face; reserved for shells (two sides)
}
export type BondElement =
  | { kind: 'joint'; resistance: Q; source: { citation: string; locator?: string } }
  | { kind: 'strap'; material: string /* record id */; length: Q; crossSection: Q }
  | { kind: 'part'; entityId: EntityId; fromNear: Vec3; toNear: Vec3 };          // V1
export interface BondLimit { value: number; unit: string; ruleId: string; source: { citation: string; locator?: string }; unverified: boolean }
export interface BondPath {                           // id 'bp-<step>.<k>'
  readonly id: string; name: string;
  from: { entityId: EntityId; pointNear: Vec3 }; to: { entityId: EntityId; pointNear: Vec3 };
  elements: readonly BondElement[]; limit?: BondLimit; temperature?: Q;
}
export interface LightningZoneLabel { readonly id: string; entityId: EntityId; facesNear: readonly Vec3[]; zone: string; source: { citation: string } }  // V1
export interface SurfaceModel {
  coatings: Record<string, SurfaceCoatingAssignment>; coatingOrder: string[];
  bondPaths: Record<string, BondPath>; bondOrder: string[];
  zones: Record<string, LightningZoneLabel>;
  bondDispositions: Record<string /* pathId */, { decision: 'accepted' | 'rejected' | 'redesign'; justification: string; inputsHash: string; signer: string; signatureId: string }>;
}
export interface CadDocument { /* existing */ surface?: SurfaceModel }
```

### 3.3 Query result shapes (excerpt)

```ts
interface BondRow { pathId: string; name: string; totalOhm: number; totalMilliohm: number;
  elements: ReadonlyArray<{ kind: string; ohm: number; share: number; provenance: string; approximate?: boolean }>;
  limit?: BondLimit; status?: 'pass' | 'fail'; code?: 'EOP_BOND_RESISTANCE_EXCEEDED' | 'EOP_BOND_LIMIT_MISSING' | 'EOP_CFRP_IN_PATH';
  unverified: boolean; unverifiedReasons: readonly string[]; reviewRequired: true; reviewReason: string;
  disposition: 'none' | 'pending_human' | 'accepted' | 'rejected' | 'redesign' }
interface OpticalBalance { alpha: number; eps: number; alphaOverEps: number; temperatureK: number; temperatureDegC: number;
  solarFluxW_m2: number; radiatingFaces: 1 | 2; sigma: { value: number; source: string; defaulted: true };
  formula: 'alpha S = n eps sigma T^4'; assumptions: readonly string[]; provenance: readonly string[]; unverified: boolean }
```

## 4. Commands

Plugin `electro_optical`, toolset `analysis`.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| (08 / PHY-01) `set_material_property`, `define_property_model` | mutating | + names of §3.1, PHY-01 `condition` / `variables` | @failure `EOP_PROPERTY_RANGE`, `EOP_CONDITION_MISSING`, `EOP_UNITS_MISMATCH` (validation hook, TR-EOP-02) |
| `assign_surface_coating` / `remove_surface_coating` | mutating | `{ entityId, facesNear: Vec3[], coating: recordId }` | @affects surface.coatings · @invariant record exists with productForm `coating`; faces resolve (kernel) · @failure `EOP_COATING_NOT_FOUND`, `FEA_TARGET_UNRESOLVED` / `_AMBIGUOUS`, `EOP_FACE_ALREADY_COATED` |
| `define_bond_path` / `delete_bond_path` | mutating | `{ name, from, to, elements[], limit?, temperature? }` | @affects surface.bondPaths · @invariant ≥ 1 element; joint has source; limit has source · @failure `EOP_BOND_ELEMENT_INVALID`, `EOP_LIMIT_SOURCE_REQUIRED` |
| `set_lightning_zone` (V1) | mutating | `{ entityId, facesNear, zone, source }` | @failure missing source |
| `check_bonding` | query | `{ pathIds? }` → `data { rows: BondRow[], reviewRequired: true, summary }` | AF-20 for bonding |
| `electrical_resistance` | query | `{ material? \| resistivity?: Q, length: Q, crossSection: Q, temperature?: Q, frequency?: Q, radius?: Q, mur? }` → `{ dcOhm, rho, temperatureModel, skinDepthM?, acOverDc?, validity?, formula, provenance }` | pure (record read) |
| `shield_absorption` | query | `{ material \| resistivity, thickness: Q, frequency: Q, mur? }` → `{ dB, skinDepthM, formula, note }` | pure |
| `optical_balance` | query | `{ entityId?, facesNear? \| coating? \| alpha?, eps?, solarFlux: Q, radiatingFaces: 1 \| 2, state?: 'BOL' \| 'EOL' }` → `OpticalBalance` | @failure `EOP_SOLAR_FLUX_MISSING`, `EOP_SURFACE_PROPERTY_MISSING` |
| `normal_reflectance` | query | `{ n1?: 1, n2 \| material, wavelength? }` → `{ R, slabT, formula }` | COULD |
| `check_surface_properties` | query | `{ entityIds? }` → pass / warn / fail items (radiating faces without ε, α without BOL/EOL, unverified values, coatings on unresolved faces) | AF-20 |
| `dispose_bond_check` | mutating, **human gate** | `{ pathId, decision, justification, signature }` | @failure `EOP_HUMAN_GATE`, `EOP_BOND_INPUTS_CHANGED` |

Description sketch, `check_bonding` (AF-02): *"Sum the series resistance of every bond path (joints as given with their
source, straps from resistivity × length / cross-section) and compare each with its limit rule entry. Results in ohm and
milliohm with each element's share. A path above its limit fails and needs a qualified engineer's disposition
(dispose_bond_check, human only). llull has no default bond limit; the 2.5 mΩ figure is a programme rule the owner must
supply with its source."*

## 5. Algorithms

### 5.1 Validation (TR-EOP-02)

Ranges of §3.1; dimension check through `lib/quantity.ts` (Ω·m vs S/m vs %); `percentIacs` must be in (0, 200] (a
sanity bound — pure silver is ~ 105 % IACS; bound is a llull rule, named in the error); conditions mandatory as listed.

### 5.2 Formulas

Exactly `validation/generate_eop_reference.py` (IACS, R = ρL/A, linear ρ(T), δ, r/(2δ), 8.68589 t/δ dB, series sum,
L/(σtw), αS = nεσT⁴, Fresnel). μ0 = 4π × 10⁻⁷ (named; the CODATA 2018 value differs by 5.5e-10 relative). σ from the exact
SI constants.

### 5.3 Part path resistance (V1)

R ≈ ρ · |toNear − fromNear| / A_mean, A_mean = solid volume / straight length along the segment's bounding slab
(kernel `massProperties` on the part clipped to the slab). Flagged `approximate: true` and `reviewRequired`; a resolved FE
current-flow solution (CalculiX electromagnetics or the heat-transfer analogy with σ in place of k) is a V2 option.

### 5.4 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Formulas vs generator | 1e-12 relative |
| Unit conversions | 1e-12 relative |
| AC approximation | flagged when r/δ < 5 |

## 6. Interop & persistence

| Item | Format |
| ---- | ------ |
| Properties | PHY-01 `PropertyModel`s / 08 scalars on `MaterialRecord` (library JSON, private libraries allowed) |
| Surface model | `surface` slice in `.llull` JSON |
| Coatings to STEP | not exported in MVP (AP242 has no agreed optical-property entity used by llull); open question |
| CalculiX (V2) | `*ELECTRICAL CONDUCTIVITY`, `*MAGNETIC PERMEABILITY` from the same records |

## 7. CLI / MCP / UI surfaces and codes

CLI: registry commands; `llull guide` section: property names and conditions, the rule-entry pattern for bond limits,
"no default solar flux". MCP: toolset `analysis`. UI: bond-path overlay, coating labels, disposition dialog.

### 7.1 Stable codes (AF-11)

| Code | Severity | When | Remediation |
| ---- | -------- | ---- | ----------- |
| `EOP_PROPERTY_RANGE` | error | value outside §3.1 range | correct the value / add `diamagnetic` |
| `EOP_CONDITION_MISSING` | error | mandatory condition absent (wavelength, ε kind, α state, reference temperature) | add the condition |
| `EOP_UNITS_MISMATCH` | error | wrong dimension (e.g. S/m for `electricalResistivity`) | use the alias name or the right unit |
| `EOP_COATING_NOT_FOUND` | error | coating record missing / not `productForm: 'coating'` | define the record |
| `EOP_FACE_ALREADY_COATED` | error | face already has a coating | `remove_surface_coating` first |
| `EOP_BOND_ELEMENT_INVALID` | error | element without resistance / material / length / area, or joint without source | complete the element |
| `EOP_LIMIT_SOURCE_REQUIRED` | error | limit without source | add the rule citation |
| `EOP_BOND_LIMIT_MISSING` | warning | path without limit | add a sourced limit |
| `EOP_BOND_RESISTANCE_EXCEEDED` | fail | total > limit | improve the bond, or human disposition |
| `EOP_CFRP_IN_PATH` | warning | composite part as a path element | add a metallic path / expanded foil |
| `EOP_LIGHTNING_ZONE_NO_PATH` | warning (V1) | CFRP face in a labelled zone without a bond path | add a path |
| `EOP_SURFACE_PROPERTY_MISSING` | error | ε (or α) needed and absent | assign a coating / add the property |
| `EOP_SOLAR_FLUX_MISSING` | error | `optical_balance` without flux | give the flux with its source |
| `EOP_PROPERTY_UNVERIFIED` | warning (not suppressible) | a used value is `unverified` | verified sourced value |
| `EOP_BOND_INPUTS_CHANGED` | error | disposition on changed inputs | re-check, then disposition |
| `EOP_HUMAN_GATE` | error | `dispose_bond_check` by an agent / no valid signature | hand over to the reviewer |

### 7.2 Agent-first compliance

AF-01–05 (registry, units, guide, plans) · AF-10/11/13 (§3.3 shapes, §7.1, deterministic) · AF-20/21 (`check_bonding`,
`check_surface_properties`; numbers only) · AF-30/31 (rule entries; no default limit / flux / ε) · AF-32–36 (`unverified`,
`reviewRequired`, `dispose_bond_check`, provenance with formula and constants, owner summary) · AF-41 (no network; no solver).

## 8. Performance

All queries are closed-form: ≤ 1 ms per path / face; `check_surface_properties` over 10 000 faces ≤ 200 ms (face
resolution cached per recipe key).

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/electroOptical/*`) | conversions, formulas vs `expected_results.json`, validation codes, commands happy / failure / `is pure` | 01–10, 12 |
| Golden | `validation/plans/eop_*.plan.json` | 06, 08 |
| Integration (with PHY-03) | radiation BC `emissivity: 'material'` → deck value and flags | 11 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Property names / conditions / validation (with PHY-01), conversions, `electrical_resistance`, `shield_absorption`, `normal_reflectance` | PHY-01 M1, 08 M1 | 1 w |
| M2 | Surface model, coatings, bond paths, `check_bonding`, `dispose_bond_check`, `optical_balance`, `check_surface_properties` | M1, 09 signing port, 01 KRN faces | 1.5 w |
| M3 | PHY-03 link (TR-EOP-32), golden plans, guide section | M2, PHY-03 M2 | 0.5 w |
| V1 | part paths, lightning zone labels, BOL/EOL selection, seed coating library import (human-checked) | M3 | 1.5 w |
| V2 | Joule / induction with CalculiX, permittivity | PHY-03 V1 | — |

## 11. Open questions / decisions needed

1. **PHY-01 additions**: accept the requested variables `wavelength`, `frequency` and condition fields `opticalKind`, `lifeState` (TECHNICAL §3.1), or propose another encoding.
2. **Coatings as 08 records** (`productForm: 'coating'`) or a separate coating record type?
3. **Seed data**: import Henninger RP-1121 (public domain) after a human reads it? Which NIST electrical data are
   licence-clear for redistribution?
4. **Bond rule tables**: ship an empty rule-table schema (like 03's customer rule tables) only, or a commented entry for
   the 2.5 mΩ figure marked `unverified`?
5. **STEP / AP242 export** of surface properties: not planned; confirm.

## 12. References

- [R1]–[R12]: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md).
- llull: `packages/core/src/model/types.ts`, `.dependency-cruiser.cjs`, `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`,
  `docs/physics/03-thermal-analysis/TECHNICAL_SPEC.md`, `docs/physics/README.md`.

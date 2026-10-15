# PHY-02 — Constitutive model library + material-point driver — Technical spec

Gap id **MATL** · Status: specification (no implementation) · Written 2026-10-15
Functional: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

This pack **owns** `packages/core/src/model/materialModel.ts`: the one `MaterialModel` union that PHY-05 (nonlinear),
PHY-07 (fatigue), PHY-08 (fracture), PHY-11 (creep), PHY-19 (explicit) and the 05 deck writers consume. Packs that need
a new law add a variant here (their TECHNICAL_SPEC §3 lists it); nobody stores material behaviour elsewhere.

---

## 1. Current state in llull

Verified in the repository on 2026-10-15:

| Area | File(s) | Today | Limit |
| ---- | ------- | ----- | ----- |
| Material | `packages/core/src/model/types.ts` (`Material { name; density; color; metalness; roughness; finish? }`) | Density + PBR | No mechanical law at all |
| Material commands | `packages/core/src/commands/document/materials.ts` | `create_material`, `assign_material` | — |
| Only consumer | `packages/core/src/commands/inspect/measureSolid.ts` (`mass_properties`) | mass = V × density | — |
| Query pattern | `annotations: { readOnly: true }`, `data` (`.claude/context/command-layer.md`) | — | Reused |

Baseline after the aerospace packs and PHY-01 (README §1): 08 `MaterialRecord` with `PropertyValue`s (E, ν, G …),
05 `FeaMaterialView { E, nu, G?, density, allowables }` and `*MATERIAL / *ELASTIC / *DENSITY`, `MAT1` writers;
06 `LaminaMaterial` (plane-stress plies, plugin data) with `CMP_MATERIAL_NOT_POSITIVE_DEFINITE` (ν12² < E1/E2); PHY-01
`PropertyModel` + evaluator. Nothing describes plastic, hyperelastic, viscoelastic, creep or rate behaviour.

## 2. Target architecture

### 2.1 Layer placement (proposal, pending README §5 decision 1)

| Concern | Layer | Why |
| ------- | ----- | --- |
| `MaterialModel` union, `ConstitutiveSet`, law catalogue | `packages/core/src/model/materialModel.ts`, `model/materialLawCatalog.ts` (new) | Core document data on the 08 record (`materialModels?`, `constitutiveSets?`); plugins read types only (L10) |
| Pure law kernels (stress update, hyperelastic stresses and Hessian, Prony recursion, creep rate) | `packages/core/src/model/materialLaws/*.ts` (new, pure) | Shared by the check (core) and the driver (`@phys`); no I/O |
| Stability checks (elastic PD, Drucker scan, parameter bounds) | `model/materialLaws/stability.ts` | Used by `add_material_model` validation and `check_material_models` |
| Commands `add_material_model`, `remove_material_model`, `define_constitutive_set`, `check_material_models` | `packages/core/src/commands/document/materialModels.ts`, registered in `document/catalog.ts`, toolset `materials` (08) | Generic material capability |
| `fit_material_model`, `material_point_response`, `export_material_cards` | `packages/domain-physics/src/materials/` (`@phys`), `CadPlugin { name: 'physMaterials', toolset: 'material-lab' }` | Numerics-heavy queries; plugin per discipline (README §6.2) |
| Solver card writers | `@phys/materials/writers/{calculix,nastran}.ts`, registered with the 05 `@cae` deck writer through a `MaterialCardWriter` extension point | 05 owns decks; PHY-02 owns material cards |
| Least squares / LM | `packages/core/src/lib/leastSquares.ts` (PHY-01) + `@phys/materials/fit/levenbergMarquardt.ts` (V2) | Reuse |
| MFront/MTest backend (V2) | `server/` host transport `mtest_run` (spawns a bundled executable), result fed back as query data | L2/L6: processes live in server/desktop |

Laws: L1 (only commands change the record), L2 (no I/O in core or `@phys`), L3 (pure, `is pure` tests), L4, L5 (zod
schemas → MCP), L8 (`add_material_model` is a recorded step; fits and driver runs are queries), L9 (no kernel needed),
L10 (`@phys` uses core public API only).

### 2.2 Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-MATL-01 | MUST | Types §3 with zod schemas; `MaterialRecord.materialModels?`, `constitutiveSets?`, `defaultConstitutiveSet?`; ids unique per record; combination rules §3.4 | FR-MATL-01, 24 |
| TR-MATL-02 | MUST | Elastic conversions and PD test in exact-enough arithmetic (§5.1); Voigt order fixed (§3.2) | FR-MATL-02, 03 |
| TR-MATL-03 | MUST | Linear hardening requires `modulusKind`; tangent → plastic conversion `H = E·Et/(E − Et)`; curves stored as true stress vs equivalent plastic strain with recorded input measure (§5.2) | FR-MATL-05 |
| TR-MATL-04 | MUST | Ramberg-Osgood canonical CalculiX form; engineering-form conversion α = 0.002 E/σ0.2 (§5.4) | FR-MATL-04 |
| TR-MATL-05 | MUST | Driver §5.3: small-strain J2 backward-Euler radial return, closed form for linear isotropic + linear kinematic, local Newton otherwise; mixed control by global Newton; deterministic | FR-MATL-06, 10 |
| TR-MATL-06 | MUST | Hyperelastic stresses for incompressible homogeneous modes and compressible general F (V2) §5.6; Ogden canonical convention 2μ/α² | FR-MATL-07 |
| TR-MATL-07 | SHOULD | Fits §5.7: linear forms by QR on exact model rows; LM (V2) deterministic | FR-MATL-08 |
| TR-MATL-08 | MUST | Drucker scan §5.6: Hessian of W in principal log strains, grid λ = 1 ± 0.01k on [0.10, 10.00] | FR-MATL-09 |
| TR-MATL-09 | SHOULD | Prony exponential recursion, WLF / Arrhenius shift, Norton / Garofalo, Johnson-Cook and Cowper-Symonds kernels §5.8 | FR-MATL-11, 12, 13 |
| TR-MATL-10 | MUST | CalculiX writer mapping §6.1, exact number formatting §6.3 | FR-MATL-15 |
| TR-MATL-11 | SHOULD | Nastran writer mapping §6.2 verified by pyNastran `read_bdf` in the server test suite | FR-MATL-15 |
| TR-MATL-12 | MUST | Law parameters referencing PHY-01 models are evaluated through `evaluatePropertyModel`; refusal codes pass through | FR-MATL-14 |
| TR-MATL-13 | MUST | `unverified` / `reviewRequired` rules §5.9 propagate into driver results, export headers and `FeaConstitutiveView` | FR-MATL-17, 20 |
| TR-MATL-14 | MUST | Codes §7.1; named defaults §5.10 | FR-MATL-16, 18, 19 |
| TR-MATL-15 | MUST | Durability variants of PHY-07/08 included verbatim in the union (§3.3); their validation rules live in those packs and are called by `check_material_models` through the law catalogue | FR-MATL-24 |

## 3. Data model

### 3.1 Envelope (`packages/core/src/model/materialModel.ts`)

```ts
import type { Basis, Provenance } from './material';                       // 08 MAT
import type { FitRecord, ValidRange } from './propertyModel';               // PHY-01

export interface Quantity { readonly value: number; readonly unit: string }  // 08 grammar (re-exported from ./material)
/** A scalar law parameter: a constant with unit, or a PHY-01 property model of the same record (temperature, rate …). */
export type LawParameter = Quantity | { readonly propertyModelId: string };

export interface MaterialModel {
  readonly id: string;                         // unique in the record, e.g. "plastic.iso", "sn1"
  readonly model: MaterialLaw;                 // discriminated by `kind` (snake_case, §3.2/§3.3)
  readonly validity?: readonly ValidRange[];   // REQUIRED for constitutive laws (T plus strain/stretch, rate, time as relevant);
                                               // durability variants keep the conditions fields their packs define
  readonly basis: Basis;
  readonly provenance: Provenance;
  readonly parametersSha256: string;           // canonical JSON of `model` (PHY-01 TR-PROP-09 rule)
  readonly conversion?: { readonly from: string; readonly note: string };   // e.g. "ogden1972 → calculix", "engineering curve → true"
  readonly fit?: FitRecord;                    // PHY-01 FitRecord (dataset hash, residuals, method)
  readonly reviewedBy?: { readonly signatureId: string };   // 09 human gate only
  readonly preferred?: true;                   // one preferred per kind family + condition (durability packs use it)
}

/** Which behaviour slot a law fills; derived from `kind` through MATERIAL_LAW_CATALOG (not stored). */
export type MaterialBehaviour = 'elastic' | 'plastic' | 'hyperelastic' | 'viscoelastic' | 'creep' | 'rate' | 'fatigue' | 'crack_growth' | 'toughness';

export interface ConstitutiveSet {             // what an analysis references (05 AnalysisCase part → recordId + setId)
  readonly id: string;                         // e.g. "iso_hardening"
  readonly elastic?: string;                   // model ids; exactly one of elastic / hyperelastic, unless plastic is ramberg_osgood
  readonly hyperelastic?: string;
  readonly plastic?: string;
  readonly viscoelastic?: string;
  readonly creep?: string;
  readonly rate?: string;
}
// 08 MaterialRecord gains (optional, no migration):
//   readonly materialModels?: readonly MaterialModel[];
//   readonly constitutiveSets?: readonly ConstitutiveSet[];
//   readonly defaultConstitutiveSet?: string;
```

### 3.2 Constitutive variants (owned by PHY-02)

Voigt order everywhere: `[11, 22, 33, 12, 13, 23]` with **engineering** shear strains (γ = 2ε). For CalculiX this gives
`D1212 = C44` etc. directly (manual: `S_IJ = D_IJKL E_KL` summed over all nine terms) [R3]; Nastran `MAT9` uses order
`xx, yy, zz, xy, yz, zx` (writer swaps 13/23) [R7].

```ts
type Q = Quantity; type P = LawParameter;

export type ConstitutiveLaw =
  // ---- elastic
  | { kind: 'elastic_isotropic'; E: P; nu: P }
  | { kind: 'elastic_orthotropic'; E1: P; E2: P; E3: P; nu12: P; nu13: P; nu23: P; G12: P; G13: P; G23: P }  // material axes 1-2-3
  | { kind: 'elastic_transversely_isotropic'; isotropyPlane: '12' | '23'; Ep: P; Et: P; nuP: P; nuPT: P; Gt: P }  // expands to orthotropic
  | { kind: 'elastic_anisotropic'; stiffness: readonly number[]; unit: string }   // 21 values, upper triangle row-wise in Voigt order
  // ---- plastic (incremental J2) and deformation plasticity
  | { kind: 'j2_plasticity'; isotropic: IsotropicHardening; kinematic: KinematicHardening }
  | { kind: 'ramberg_osgood'; E: P; nu: P; sigma0: P; n: number; alpha: number;   // E·ε = σ + α(|σ|/σ0)^(n−1)σ, true stress / log strain [R3][R9]
      theory: 'deformation' }                                                     // monotonic loading only
  // ---- hyperelastic (stress unit in each Q; D in 1/stress; D = 0 ⇒ incompressible)
  | { kind: 'hyper_neo_hooke'; C10: Q; D1: Q }
  | { kind: 'hyper_mooney_rivlin'; C10: Q; C01: Q; D1: Q }
  | { kind: 'hyper_polynomial'; order: 1 | 2 | 3; C: Partial<Record<'C10' | 'C01' | 'C20' | 'C11' | 'C02' | 'C30' | 'C21' | 'C12' | 'C03', number>>;
      D: readonly number[]; stressUnit: string }
  | { kind: 'hyper_reduced_polynomial'; order: 1 | 2 | 3; Ci0: readonly number[]; D: readonly number[]; stressUnit: string }
  | { kind: 'hyper_yeoh'; C10: Q; C20: Q; C30: Q; D: readonly [number, number, number]; compliance: string }
  | { kind: 'hyper_ogden'; terms: ReadonlyArray<{ mu: number; alpha: number }>;   // canonical: W = Σ 2μ_i/α_i² (λ̄1^α_i + λ̄2^α_i + λ̄3^α_i − 3)
      D: readonly number[]; stressUnit: string }                                  // input convention 'ogden1972' converted: μ_i = μ_p α_p / 2
  | { kind: 'hyper_arruda_boyce'; mu: Q; lambdaM: number; D: Q }                  // 5-term series [R3][R12]
  // ---- viscoelastic (applies to the elastic or hyperelastic slot of the same set; moduli there are INSTANTANEOUS)
  | { kind: 'visco_prony'; shear: ReadonlyArray<{ g: number; tau: Q }>; bulk?: ReadonlyArray<{ k: number; tau: Q }>;
      shift?: { kind: 'wlf'; C1: number; C2: Q; referenceTemperature: Q; referenceIsTg: boolean }
            | { kind: 'arrhenius'; activationEnergy: Q; referenceTemperature: Q } }
  // ---- creep (definitions; structural creep analysis is PHY-11)
  | { kind: 'creep_norton'; A: number; n: number; m: number; stressUnit: string; timeUnit: string; hardening: 'time' | 'strain' }  // ε̇ = A σ^n t^m
  | { kind: 'creep_garofalo'; A: Q; alpha: Q; n: number; activationEnergy: Q }   // ε̇ = A [sinh(ασ)]^n exp(−Q/(R T))
  // ---- rate (multiplies the plastic flow stress; explicit analysis is PHY-19)
  | { kind: 'rate_johnson_cook'; C: number; referenceRate: Q }                  // pairs with isotropic.kind 'johnson_cook' (CalculiX *RATE DEPENDENT)
  | { kind: 'rate_cowper_symonds'; D: Q; q: number };

export type IsotropicHardening =
  | { kind: 'perfect'; yieldStress: P }
  | { kind: 'linear'; yieldStress: P; modulus: P; modulusKind: 'plastic' | 'tangent' }   // no default for modulusKind
  | { kind: 'multilinear'; stressUnit: string;
      curves: ReadonlyArray<{ temperature?: Q; points: ReadonlyArray<readonly [trueStress: number, eqPlasticStrain: number]> }> }
  | { kind: 'voce'; yieldStress: P; Q: P; b: number }                             // σ = σy + Q(1 − e^(−b εp))
  | { kind: 'johnson_cook'; A: Q; B: Q; n: number; m: number; meltTemperature: Q; transitionTemperature: Q };
export type KinematicHardening =
  | { kind: 'none' }
  | { kind: 'linear'; C: P }                                                    // Prager; uniaxial plastic modulus
  | { kind: 'chaboche'; backstresses: ReadonlyArray<{ C: P; gamma: number }> };  // Armstrong-Frederick terms
```

### 3.3 Durability variants (fields specified by the consumer packs, hosted here)

Included verbatim from PHY-07 TECHNICAL_SPEC §3.1 (`FatigueTestConditions`, `FatigueMaterialModel`) and PHY-08 TECHNICAL_SPEC
§3.1 (`CrackGrowthConditions`, `CrackGrowthMaterialModel`). Kinds: `sn_basquin`, `sn_power_law`, `sn_table`,
`sn_equivalent_stress`, `en_coffin_manson`, `cyclic_ramberg_osgood`, `haigh_table`, `da_dn_paris`, `da_dn_walker`,
`da_dn_forman`, `da_dn_nasgro`, `da_dn_table`, `fracture_toughness`.

```ts
export type MaterialLaw = ConstitutiveLaw | FatigueMaterialModel | CrackGrowthMaterialModel;
```

Alignment notes: (1) `cyclic_ramberg_osgood { Kprime, nPrime, E }` (PHY-07) is the cyclic curve `ε_a = σ_a/E + (σ_a/K′)^(1/n′)`;
it is a separate kind from the monotonic `ramberg_osgood` above (different parameterisation, different use), and
`check_material_models` warns `MATL_RO_FORMS_DIFFER` if both exist with inconsistent E. (2) Durability variants use
`Quantity` fields; constitutive variants use `LawParameter` (a `Quantity` is a valid `LawParameter`), so the two are
compatible. (3) Their field names are frozen by their packs; PHY-08's NASGRO fields stay provisional (OQ-FRC-02).

### 3.4 Law catalogue and combination rules (`model/materialLawCatalog.ts`)

```ts
export interface MaterialLawCatalogEntry {
  readonly kind: MaterialLaw['kind']; readonly behaviour: MaterialBehaviour; readonly ownerPack: string;
  readonly validate: (law: MaterialLaw) => readonly MatlIssue[];     // structural + bounds (§5.1–5.8); durability packs supply theirs
  readonly targets: { readonly calculix: 'native' | 'unsupported' | 'mfront_v2'; readonly nastran: 'native' | 'unsupported' | 'tbd' };
}
```

| Rule | Code |
| ---- | ---- |
| A set has exactly one of `elastic` / `hyperelastic`, except `plastic = ramberg_osgood`, which carries E, ν and forbids `elastic` (CalculiX `*DEFORMATION PLASTICITY` holds E, ν) | `MATL_COMBINATION_INVALID` |
| `plastic` (`j2_plasticity`) requires `elastic_isotropic`, or `elastic_orthotropic` with at most linear hardening (CalculiX infinitesimal orthotropic model) [R3] | `MATL_COMBINATION_INVALID` |
| `creep` requires `elastic` (isotropic or orthotropic) [R3 *CREEP] | `MATL_COMBINATION_INVALID` |
| `viscoelastic` requires `elastic` or `hyperelastic` | `MATL_COMBINATION_INVALID` |
| `rate_johnson_cook` requires `isotropic.kind = 'johnson_cook'` and isotropic elasticity [R3 *PLASTIC] | `MATL_COMBINATION_INVALID` |
| Durability kinds are never members of a set | `MATL_COMBINATION_INVALID` |

### 3.5 Consumer view (extends 05 `FeaMaterialView`)

```ts
export interface FeaConstitutiveView {                       // built by @phys from a record + set at an analysis state
  readonly recordId: string; readonly setId: string; readonly unitSystem: string;   // 05 UnitSystem
  readonly laws: Partial<Record<'elastic' | 'hyperelastic' | 'plastic' | 'viscoelastic' | 'creep' | 'rate', MaterialModel>>;
  readonly temperatureTablesK?: readonly number[];          // where temperature-dependent parameters were tabulated (PHY-01 §5.8)
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[]; readonly reviewRequired: boolean;
}
```

### 3.6 Document version

All new fields are optional on the 08 record: no migration in the v3 envelope. 08 library files carrying material
models use `schemaVersion: 2` (shared with PHY-01).

## 4. Commands

| Command | Kind / toolset | Params sketch | Tags |
| ------- | -------------- | ------------- | ---- |
| `add_material_model` | mutating · `materials` | `{ material, id, model: MaterialLaw (input conventions allowed: hyper_ogden `convention?: 'calculix'\|'ogden1972'`, ramberg_osgood `form?: 'calculix'\|'engineering'` with sigma02, multilinear `inputMeasure: { stress: 'true'\|'engineering', strain: 'plastic'\|'total', strainKind: 'true'\|'engineering' }`), validity?, basis, source: { citation, locator?, url?, accessed? }, fit?, preferred?, replace? }` | `@affects materialRecords[material].materialModels` · `@invariant model stored in canonical convention with `conversion` recorded; parametersSha256 recomputed; catalogue validate() passes; elastic laws PD` · `@failure unknown record → MAT_RECORD_NOT_FOUND; MATL_LAW_PARAMS_INVALID; MATL_ELASTIC_NOT_POSITIVE_DEFINITE; MATL_POISSON_BOUND; MATL_HARDENING_MODULUS_KIND_MISSING; MATL_CURVE_MEASURE_MISSING; MATL_HARDENING_CURVE_INVALID; MATL_HYPERELASTIC_INITIAL_MODULUS; MATL_HYPERELASTIC_UNSTABLE (inside declared validity); MATL_PRONY_INVALID; MATL_MODEL_EXISTS — all no-op` |
| `remove_material_model` | mutating · `materials` | `{ material, id }` | `@invariant others untouched` · `@failure MATL_MODEL_NOT_FOUND; MATL_MODEL_IN_USE (sets or analyses listing it)` |
| `define_constitutive_set` | mutating · `materials` | `{ material, set: ConstitutiveSet, makeDefault?: boolean, replace?: boolean }` | `@affects constitutiveSets, defaultConstitutiveSet` · `@invariant §3.4 rules hold` · `@failure MATL_COMBINATION_INVALID; MATL_MODEL_NOT_FOUND` |
| `check_material_models` | query · `materials` | `{ material?: string[], target?: 'calculix'\|'nastran', usedBy?: 'analyses'\|'all' }` | readiness check (AF-20) → `data { status, items: [{ code, severity, ids[], message, remediation }], stability: { [modelId]: DruckerReport \| ElasticReport } }` |
| `fit_material_model` | query · `material-lab` (`@phys`) | `{ kind, tests: [{ mode: 'uniaxial'\|'equibiaxial'\|'planar'\|'uniaxial_plastic'\|'relaxation'\|'creep_rate', rows: [x, y][], xMeasure, yMeasure, units, weight? }], objective?: 'absolute'\|'relative', fixed?: {…} (e.g. Prony τ), start?: {…}, validity?, basis?, dataSource? }` | `@invariant read-only; deterministic; returns a model add_material_model accepts unchanged; includes stability` · `@failure MATL_FIT_INSUFFICIENT_DATA, MATL_FIT_ILL_CONDITIONED, MATL_FIT_DID_NOT_CONVERGE (V2), MATL_FIT_INSUFFICIENT_MODES (warning: hyperelastic from one mode)` → `data { model, fit: FitRecord, residualsPerTest, stability, defaults[], warnings[] }` |
| `material_point_response` | query · `material-lab` | `{ material, set?, model?: MaterialLaw (ad-hoc, not stored), kinematics: 'small'\|'finite', preset?: 'uniaxial_stress'\|'uniaxial_strain'\|'plane_strain'\|'equibiaxial'\|'pure_shear'\|'simple_shear', steps: [{ duration?: Q, temperature?: Q, increments?: number, control: { xx?: { strain: number } \| { stress: Q }, yy?: …, zz?: …, xy?: …, xz?: …, yz?: … } }], output?: 'increments'\|'steps' }` | `@invariant read-only; deterministic; components not controlled by the preset or the step are stress-free (σ = 0)` · `@failure MATL_PATH_INVALID; MATL_PATH_DIVERGED (local/global Newton); MATL_STRAIN_OUT_OF_RANGE (warning, beyond validity); PROP_OUT_OF_RANGE (from a referenced property model)` → `data { rows: [{ step, increment, time, T, strain[6], stress[6], eqPlasticStrain, vonMises, backStress[6], energyDensity }], units, defaults[], unverified, unverifiedReasons }` (≤ 10 000 rows; larger via `--save`) |
| `export_material_cards` | query · `material-lab` | `{ material, set, target: 'calculix'\|'nastran', name?, mid?: integer, temperatures?: Q[] }` | `@invariant same text as the deck writer emits (single implementation)` · `@failure MATL_EXPORT_UNSUPPORTED (law and target named), MATL_COMBINATION_INVALID` → `data { lines: string[], header, unverified }` |

**Describe text (AF-02), `material_point_response`:** "Drive one material point of a constitutive set along a path and
return stress-strain history without a mesh. Each step imposes strain (dimensionless) or stress ({value, unit}) per
component xx…yz; uncontrolled components stay stress-free. Use presets for common states (plane_strain for NAFEMS NL1).
Give increments per step (default 100, named). Small strain for plasticity, viscoelasticity and creep; finite
homogeneous modes for hyperelastic. Next: compare with test data, then check_material_models."

## 5. Algorithms

### 5.1 Elasticity and stability

- Orthotropic compliance `S` (Voigt, engineering shear): `S11 = 1/E1`, `S12 = −ν12/E1`, `S13 = −ν13/E1`, `S23 = −ν23/E2`,
  `S22 = 1/E2`, `S33 = 1/E3`, `S44 = 1/G12`, `S55 = 1/G13`, `S66 = 1/G23` (symmetric; ν21 = ν12 E2/E1). `C = S⁻¹`.
- **PD test**: symmetric LDLᵀ without pivoting; all pivots > 0 ⇔ positive definite. The 2×2 leading minor of S gives
  `ν12² < E1/E2` (Lempriere bound [R6]); the generator verifies both directions on fixtures (VC-MATL-03). Isotropic:
  `E > 0`, `−1 < ν < 0.5` (`K = E/(3(1 − 2ν)) > 0`, `G = E/(2(1 + ν)) > 0`); ν within 1e-6 of 0.5 → warning
  `MATL_NEAR_INCOMPRESSIBLE` (locking risk for PHY-05).
- Arithmetic: double precision LDLᵀ with a relative pivot floor 1e-12 · max|S_ii| (pivots below the floor count as
  non-positive); the generator uses exact fractions.

### 5.2 Plasticity input conversions

- Engineering curve → true: `σ_t = σ_e (1 + ε_e)`, `ε_t = ln(1 + ε_e)`; total → plastic: `ε_p = ε_t − σ_t/E`; first point
  shifted to ε_p = 0 at the declared yield; ε_p strictly increasing, else `MATL_HARDENING_CURVE_INVALID`; decreasing
  stress → warning `MATL_HARDENING_SOFTENING` (localisation risk). Valid only up to the uniform elongation (necking): the
  conversion records the last point used; beyond it `validity` ends.
- Linear hardening: plastic modulus `H` (slope of σ vs ε_p, as Nastran MATS1 H [R7] and CalculiX *PLASTIC curves [R3]) or
  tangent modulus `Et` (slope of σ vs total ε): `H = E·Et/(E − Et)`, requires `Et < E`. VC-MATL-02 shows the two readings
  of 62.5 GPa give 5.862 vs 6.087 MPa at NL1 point 2.

### 5.3 Driver: small-strain J2 (`@phys/materials/driver/j2.ts`, reference: generator `nl1_run`)

Per increment with strain increment Δε (6, engineering shear):

```
trial:   σ_tr = σ_n + C_e : Δε ;  s_tr = dev(σ_tr) − X_n ;  q_tr = √(3/2 s_tr:s_tr) ;  σ_y = σ_y(ε̄p_n)
elastic: q_tr ≤ σ_y(ε̄p_n) (1 + 1e-12)       → accept trial
plastic: solve for Δλ ≥ 0:  q_tr − 3GΔλ − ΔX_eq(Δλ) − σ_y(ε̄p_n + Δλ) = 0
         linear isotropic H and linear kinematic C:  Δλ = (q_tr − σ_y,n)/(3G + H + C)     (closed form)
         otherwise: scalar Newton, |r| ≤ 1e-10 σ_y, ≤ 50 iterations, else MATL_PATH_DIVERGED
         n̂ = s_tr / ‖s_tr‖ ;  σ = σ_tr − 2G Δλ √(3/2) n̂ ;  ε̄p += Δλ ;  X update (linear: ΔX = (2/3) C Δε_p ;
         Armstrong-Frederick term i: X_i = (X_i,n + (2/3) C_i Δε_p) / (1 + γ_i Δλ)   (backward Euler)
```

- Mixed control: unknown strain components found by Newton on the controlled stress residuals with the consistent
  tangent (finite-difference fallback, step 1e-8 relative); tolerance `|Δσ| ≤ 1e-9 · max(σ_y, 1 Pa equivalent)`.
- Plane strain preset: εzz = γxz = γyz = 0 controlled (strain), σzz output. NL1 path: (εxx, εyy) ×1e-4 =
  (0.25,0) (0.5,0) (0.5,0.25) (0.5,0.5) (0.25,0.5) (0,0.5) (0,0.25) (0,0) with N equal increments per segment.
  Reproduced values: N = 10 gives 3.8235 MPa (perfect) and 4.1141 MPa (hardening) at point 7, equal to the Abaqus CPE4R
  values 3.824 / 4.114 [R1] to four digits, and 5.4821 at point 3 (Abaqus and target 5.482) — strong evidence that the
  path above is the NNB path (VC-MATL-01/02).
- Ramberg-Osgood (deformation theory): uniaxial stress inverse by safeguarded Newton/bisection on `E ε = σ + α(|σ|/σ0)^(n−1)σ`;
  multiaxial by the J2 deformation-theory generalisation (secant, proportional loading); non-proportional path → warning
  `MATL_DEFORMATION_THEORY_PATH`.

### 5.4 Ramberg-Osgood conversions

Engineering form `ε = σ/E + 0.002 (σ/σ0.2)^n` ⇔ CalculiX form with `σ0 = σ0.2`, `α = 0.002·E/σ0.2` (identical curve:
divide CalculiX form by E). VC-MATL-04: E 72 GPa, σ0.2 400 MPa, n 15 → α 0.36; ε(σ0.2) = 0.00755556; σ(ε = 0.01) =
420.054211273 MPa. CalculiX applies the law to true stress / logarithmic (Eulerian) strain [R3][R9]; the define command
records which measure the input used.

### 5.5 Kinematic hardening checks (closed forms used as VCs)

Armstrong-Frederick, uniaxial monotonic: `σ = σ_y + (C/γ)(1 − exp(−γ ε_p))`, saturation `σ_y + C/γ`. Prager, uniaxial:
loading to σ_max then reversing gives reverse yield at `σ_max − 2σ_y`. VC-MATL-05.

### 5.6 Hyperelasticity

Incompressible homogeneous modes with stretch λ (nominal = first Piola-Kirchhoff stress P in the loading direction),
`W(I1, I2)` laws: `W1 = ∂W/∂I1`, `W2 = ∂W/∂I2`:

| Mode | I1 | I2 | P |
| ---- | -- | -- | - |
| uniaxial (UT) | λ² + 2/λ | 2λ + 1/λ² | 2(λ − λ⁻²)(W1 + W2/λ) |
| equibiaxial (ET) | 2λ² + λ⁻⁴ | λ⁴ + 2λ⁻² | 2(λ − λ⁻⁵)(W1 + λ² W2) |
| planar / pure shear (PS) | λ² + 1 + λ⁻² | same | 2(λ − λ⁻³)(W1 + W2) |

Ogden (canonical, CalculiX [R3]): UT `P = Σ (2μ_i/α_i)(λ^(α_i−1) − λ^(−α_i/2−1))`, ET with `λ^(−2α_i−1)`, PS with `λ^(−α_i−1)`;
initial shear modulus `μ0 = Σ μ_i` (canonical) = `½ Σ μ_p α_p` (Ogden 1972). Arruda-Boyce:
`W = μ Σ_{i=1..5} c_i/λm^(2i−2) (Ī1^i − 3^i)`, `c = 1/2, 1/20, 11/1050, 19/7000, 519/673750` [R3][R12].

**Drucker scan** (TR-MATL-08): write `Ŵ(ε1, ε2) = W(λ1 = e^ε1, λ2 = e^ε2, λ3 = e^(−ε1−ε2))`. The incompressible true-stress
differences are `σ_i − σ_3 = ∂Ŵ/∂ε_i`, so the tangent is the Hessian `H = ∂²Ŵ/∂ε_i∂ε_j` (symmetric); Drucker
stability dσ:dε > 0 for isochoric increments ⇔ H positive definite. For `W(I1, I2)`:
`H = W1 ∂²I1 + W2 ∂²I2 + W11 ∇I1∇I1ᵀ + W12(∇I1∇I2ᵀ + ∇I2∇I1ᵀ) + W22 ∇I2∇I2ᵀ`, with (a = λ1, b = λ2, p = a⁻²b⁻²)
`∇I1 = (2a² − 2p, 2b² − 2p)`, `∂²I1 = [[4a² + 4p, 4p], [4p, 4b² + 4p]]`, `∇I2 = (−2a⁻² + 2a²b², −2b⁻² + 2a²b²)`,
`∂²I2 = [[4a⁻² + 4a²b², 4a²b²], [4a²b², 4b⁻² + 4a²b²]]`. Ogden: `H11 = Σ μα(e^(αε1) + e^(−α(ε1+ε2)))`,
`H12 = Σ μα e^(−α(ε1+ε2))` (Ogden-1972 convention; canonical uses 2μ/α). Modes: UT (ln λ, −½ ln λ), ET (ln λ, ln λ),
PS (ln λ, 0); grid λ = 1 + 0.01k (k = 1…900) and 1 − 0.01k (k = 1…90), i.e. nominal strain −0.9…9 as the Abaqus check
range quoted in [R5]. Report the first unstable λ per mode and side. Results for the Treloar fits: VC-MATL-08/09.

### 5.7 Fitting

- **Linear in parameters** (V1): polynomial / reduced polynomial / Yeoh / Mooney-Rivlin / Neo-Hooke (P linear in C_ij for
  each mode, rows from §5.6), Prony with fixed τ (relaxation linear in g_i), Ramberg-Osgood (log(ε − σ/E) vs log σ),
  multilinear (direct conversion §5.2, no fit). Solve by PHY-01 scaled QR; objective `absolute` (named default) or
  `relative`. VC-MATL-08 compares against exact rational normal-equation solutions on the Treloar table.
- **Non-linear** (V2): Levenberg-Marquardt with geodesic-free classic damping, λ0 = 1e-3, ×10 / ÷10, stop on relative
  cost change < 1e-12 or 500 iterations; deterministic multi-start from a fixed grid (Ogden α ∈ {−2, 1, 2, 3, 5} combos)
  in a fixed order; best by cost, ties by lower parameter norm.
- Every fit returns stability (§5.6 or §5.1), residuals per test (RMS, max), and `FitRecord`. Hyperelastic fit from a
  single mode → warning `MATL_FIT_INSUFFICIENT_MODES` (the neo-Hooke UT-only fit of Treloar has 0.27 / 0.65 MPa RMS in
  ET / PS against 0.79 in UT, VC-MATL-08).

### 5.8 Viscoelastic, creep, rate kernels

- Prony: `G(t) = G0 (1 − Σ g_i (1 − e^(−t/τ_i)))`, `0 < g_i`, `Σ g_i < 1`, `τ_i > 0` (`MATL_PRONY_INVALID`); driver uses the
  exponential recursion `h_i,n+1 = e^(−Δt/τ_i) h_i,n + g_i (1 − e^(−Δt/τ_i))/(Δt/τ_i) Δs` (exact for piecewise-linear strain).
  Shift: reduced time `Δξ = Δt / aT`; WLF `log10 aT = −C1 (T − Tr)/(C2 + T − Tr)`; refused if `C2 + T − Tr ≤ 0`, and
  below Tr when `referenceIsTg` (`MATL_SHIFT_OUT_OF_RANGE`) [R13]; Arrhenius `ln aT = (Q/R)(1/T − 1/Tr)`.
- Norton (CalculiX form [R3]): `ε̇ = A σ^n t^m`; constant stress, time hardening: `ε = A σ^n t^(m+1)/(m+1)` (m > −1);
  strain hardening option (V1) integrates `ε̇ = A^(1/(m+1)) σ^(n/(m+1)) ((m+1)ε)^(m/(m+1))`. Garofalo:
  `ε̇ = A [sinh(ασ)]^n exp(−Q/(RT))`. Driver integrates creep implicitly (backward Euler, local Newton) — V1.
- Johnson-Cook: `σ = (A + B ε_p^n)(1 + C ln(ε̇/ε̇0))(1 − T*^m)`, `T* = (T − T_tr)/(T_m − T_tr)` clamped to [0, 1]; rate term
  clamped to ≥ 1 below ε̇0 (named, PHY-01 OQ-PROP-08). CalculiX names the reference temperature "transition temperature"
  [R3]. Cowper-Symonds factor `1 + (ε̇/D)^(1/q)`.

### 5.9 Unverified and review flags

`unverified` = basis ∈ {typical, supplier_unstated, unspecified} ∨ source not verified (08) ∨ any referenced PHY-01 model
unverified ∨ (`fit` ∧ (no `dataProvenance` ∨ no `reviewedBy`)) ∨ driver state outside `validity` (warning
`MATL_STRAIN_OUT_OF_RANGE`). `reviewRequired` = `forCertification` ∨ (`fit` ∧ no `reviewedBy`) ∨ the set feeds a margin
(05 `compute_margins`). Reasons concatenate into every result and the export header comment
`** llull material <record>/<set> sha256=<h> unverified=<reasons>`.

### 5.10 Named defaults (AF-31)

| Default | Value | Source |
| ------- | ----- | ------ |
| Increments per step (driver) | 100 | llull choice |
| Local / global Newton tolerances | 1e-10 σ_y / 1e-9 relative, 50 iterations | llull choice |
| Drucker scan | λ ∈ [0.10, 10.00], step 0.01 | nominal strain −0.9…9 (Abaqus range, [R5] search extract) |
| Incompressible hyperelastic (D = 0) | CalculiX substitutes a small compressibility [R3] | solver behaviour; warning `MATL_INCOMPRESSIBLE_DEFAULT` |
| Fit objective | `absolute` nominal-stress residual | llull choice (Treloar VCs use it) |
| Linear law extended for a writer table | up to the model's `validity` max strain | llull rule; no validity ⇒ `MATL_VALIDITY_MISSING` |
| J-C rate term below ε̇0 | 1 | llull rule |

Never defaulted: `modulusKind`, curve measures, Ogden input convention, Ramberg-Osgood input form, stress and time units.

## 6. Interop & persistence

### 6.1 CalculiX mapping (manual 2.23 [R3], parsers at the 05 commit [R4])

| Law | Cards (in order) | Data line(s) |
| --- | ---------------- | ------------ |
| `elastic_isotropic` | `*ELASTIC` | `E, ν, T` per temperature |
| `elastic_orthotropic` | `*ELASTIC,TYPE=ENGINEERING CONSTANTS` | pair: `E1,E2,E3,ν12,ν13,ν23,G12,G13` / `G23,T` |
| `elastic_anisotropic` | `*ELASTIC,TYPE=ANISO` | three lines: `D1111,D1122,D2222,D1133,D2233,D3333,D1112,D2212` / `D3312,D1212,D1113,D2213,D3313,D1213,D1313,D1123` / `D2223,D3323,D1223,D1323,D2323,T` (reordered from Voigt) |
| `j2_plasticity` isotropic | `*ELASTIC` then `*PLASTIC[,HARDENING=ISOTROPIC]` | `σ_vM, ε̄p, T` rows, ascending ε̄p, first row ε̄p = 0 |
| kinematic linear | `*PLASTIC,HARDENING=KINEMATIC` | same layout (kinematic curve) |
| combined | `*PLASTIC,HARDENING=COMBINED` (kinematic curve) + `*CYCLIC HARDENING` (isotropic curve) | as above |
| Johnson-Cook | `*PLASTIC,HARDENING=JOHNSON COOK` + `*RATE DEPENDENT,TYPE=JOHNSON COOK` | `A, B, n, m, T_m, T_tr` / `C, ε̇0` |
| Chaboche (multi back stress) | — | `MATL_EXPORT_UNSUPPORTED` (native ccx kinematic hardening takes one curve; route: MFront V2) |
| `ramberg_osgood` | `*DEFORMATION PLASTICITY` (no `*ELASTIC`) | `E, ν, σ0, n, α, T` |
| hyperelastic | `*HYPERELASTIC,<ARRUDA-BOYCE\|MOONEY-RIVLIN\|NEO HOOKE\|OGDEN\|POLYNOMIAL\|REDUCED POLYNOMIAL\|YEOH>[,N=n]` | manual field order, e.g. Ogden N=3 pair `μ1,α1,μ2,α2,μ3,α3,D1,D2` / `D3,T`; Yeoh `C10,C20,C30,D1,D2,D3,T` |
| `creep_norton` | `*ELASTIC` (+ `*PLASTIC` if any) then `*CREEP[,LAW=NORTON]` | `A, n, m, T`; `*VISCO` step owned by PHY-11 |
| `creep_garofalo` | `*CREEP,LAW=USER` needs `creep.f` | `MATL_EXPORT_UNSUPPORTED` (V2 user routine / MFront) |
| `visco_prony` | none found in the manual index or the source tree (code search for `VISCOELASTIC` in the pinned repo: no hit) | `MATL_EXPORT_UNSUPPORTED`; informs PHY-11 (OQ-MATL-04) |

The parser strips blanks and upper-cases keywords (`REDUCEDPOLYNOMIAL`, `ENGINEERINGCONSTANTS` in the source), so the
writer emits the manual spelling with single spaces.

### 6.2 Nastran mapping (pyNastran card definitions [R7])

| Law | Cards |
| --- | ----- |
| `elastic_isotropic` | `MAT1 MID E G NU RHO …` (G blank, Nastran derives it; 05 convention) |
| `elastic_anisotropic` / orthotropic solids | `MAT9 MID G11 G12 … G66 RHO …` (order xx, yy, zz, xy, yz, zx) |
| `j2_plasticity` | `MATS1 MID TID TYPE=PLASTIC H YF=1 HR (1 isotropic, 2 kinematic, 3 combined) LIMIT1=σ_y`; multilinear via `TID → TABLES1` stress-strain table (H blank) |
| hyperelastic | `MATHE MID Model (MOONEY default; OGDEN; ABOYCE) K RHO …` with C_ij / μ_i, α_i rows |
| creep, Prony | `CREEP` / `MATEV` exist in pyNastran but their fields were not verified → `tbd` in the catalogue, `MATL_EXPORT_UNSUPPORTED` until verified |

### 6.3 Number formatting (both writers)

Shortest round-trip decimal of the double; integers written with a trailing `.` in CalculiX (`72000.`), plain integers for
Nastran integer fields (MID, YF, HR). Nastran small field: 8 characters, left-justified, value must fit (else large-field
format, V1). Expected text: VC-MATL-13/14.

### 6.4 Files

| File | Schema |
| ---- | ------ |
| `*.llull-matlib.json` | 08 `MaterialLibrary` `schemaVersion: 2` with `materialModels`, `constitutiveSets` |
| Test-data files for fits | CSV `x,y` with `# measure` / `# unit` header lines, read by the host and passed as `rows` (bounded) |

## 7. CLI / MCP / UI surfaces

- **CLI:** no new verbs. `llull guide` gains a "material laws" section: conventions (true vs engineering, plastic vs
  tangent modulus, Ogden μ), presets, the minimal plan (AF-03).
- **MCP:** core commands in `materials`; plugin commands in `material-lab`; all queries read-only.
- **UI:** review only (FUNCTIONAL_SPEC §6.3).

### 7.1 Stable error and check codes (AF-11)

Exit code 1 on every refusal; `data.code`, `data.ids` / `data.path`, `data.remediation` always set. 08 and PHY-01 codes keep
their meaning when passed through.

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `MATL_MODEL_NOT_FOUND` | error | unknown model id | material, id | `get_material` lists models |
| `MATL_MODEL_EXISTS` | error | duplicate id without `replace` | material, id | `replace: true` or a new id |
| `MATL_MODEL_IN_USE` | error | removing a model referenced by a set or analysis | set / analysis ids | edit the set first |
| `MATL_LAW_PARAMS_INVALID` | error | missing/negative/non-finite parameter, wrong count, bad unit dimension | `model.<path>` | follow `llull describe add_material_model` |
| `MATL_ELASTIC_NOT_POSITIVE_DEFINITE` | error | stiffness not PD | model, failing pivot, bound | check ν_ij against √(E_i/E_j) and E/G signs |
| `MATL_POISSON_BOUND` | error | isotropic ν ∉ (−1, 0.5) | `model.nu` | give −1 < ν < 0.5 |
| `MATL_NEAR_INCOMPRESSIBLE` | warning | ν within 1e-6 of 0.5 | model | use a hybrid formulation in PHY-05 or a hyperelastic law |
| `MATL_HARDENING_MODULUS_KIND_MISSING` | error | linear hardening without `modulusKind` | `model.isotropic.modulusKind` | say `plastic` (slope vs plastic strain) or `tangent` (slope vs total strain) |
| `MATL_CURVE_MEASURE_MISSING` | error | curve without input measure | `model.isotropic.inputMeasure` | state true/engineering stress and plastic/total strain |
| `MATL_HARDENING_CURVE_INVALID` | error | ε̄p not increasing, first point ≠ 0, < 2 points | `model.isotropic.curves[i].points[j]` | fix the curve |
| `MATL_HARDENING_SOFTENING` | warning | stress decreases along the curve | model, point | expect localisation; confirm with the source |
| `MATL_HYPERELASTIC_INITIAL_MODULUS` | error | initial shear modulus ≤ 0 | model | check signs of C10 / μ_i |
| `MATL_HYPERELASTIC_UNSTABLE` | error inside validity / warning outside | Drucker scan fails | model, mode, side, first λ | refit (e.g. Yeoh), add test modes, or narrow validity |
| `MATL_INCOMPRESSIBLE_DEFAULT` | warning | D = 0 written to a solver that substitutes a value | model | give D explicitly if bulk behaviour matters |
| `MATL_PRONY_INVALID` | error | g ≤ 0, Σg ≥ 1, τ ≤ 0 | `model.shear[i]` | fix the series |
| `MATL_SHIFT_OUT_OF_RANGE` | error | WLF denominator ≤ 0 or T < Tg | temperature | stay at or above Tg / Tr |
| `MATL_CREEP_PARAMS_INVALID` | error | A ≤ 0, n ≤ 0, m ≤ −1 | model | fix parameters |
| `MATL_COMBINATION_INVALID` | error | §3.4 rule broken | set id, rule | change the set |
| `MATL_VALIDITY_MISSING` | error (writer) / warning (check) | constitutive law without validity ranges | model | add validity (strain, T) |
| `MATL_STRAIN_OUT_OF_RANGE` | warning | driver state beyond validity | step, increment | results are extrapolated: `unverified` |
| `MATL_DEFORMATION_THEORY_PATH` | warning | non-proportional path on `ramberg_osgood` | step | use `j2_plasticity` for non-proportional loading |
| `MATL_PATH_INVALID` | error | over/under-determined control, zero increments | `steps[i]` | control each component by strain or stress, once |
| `MATL_PATH_DIVERGED` | error | local or global Newton failed | step, increment | more increments; check the law |
| `MATL_FIT_INSUFFICIENT_DATA` | error | rows ≤ parameters | `tests` | add data or a simpler law |
| `MATL_FIT_INSUFFICIENT_MODES` | warning | hyperelastic fit from one mode | tests | add equibiaxial / planar data |
| `MATL_FIT_ILL_CONDITIONED` | error | condition > 1e12 | law | simpler law |
| `MATL_FIT_DID_NOT_CONVERGE` | error | LM stop without convergence (V2) | law, iterations | other start / law |
| `MATL_RO_FORMS_DIFFER` | warning | monotonic and cyclic Ramberg-Osgood with inconsistent E | model ids | align E |
| `MATL_EXPORT_UNSUPPORTED` | error | target cannot represent the law | law kind, target | other law / target, or the V2 MFront route |
| `MATL_BACKEND_MISSING` | error | `engine: 'mtest'` without the bundled executable (V2) | — | install the bundle; use the built-in driver |

### 7.2 Agent-first compliance

| AF | Where satisfied |
| -- | --------------- |
| AF-01…03 | Registry commands; descriptions with units and conventions; `llull guide` section |
| AF-04 | Quantities `{value, unit}`; conventions explicit |
| AF-05 | `validation/plans/*.json`; `--validate` runs `add_material_model` validation incl. stability |
| AF-10 | Driver rows, fit residuals, stability reports as data with units |
| AF-11 | §7.1 |
| AF-12 | Driver capped at 10 000 rows; cards via `--save` |
| AF-13 | Deterministic integrators and fits |
| AF-20 | `check_material_models` (+ items in 08 `check_materials`) |
| AF-21 | Drucker limits, residuals, stress-strain rows instead of plots |
| AF-23 | Validation harness |
| AF-30 | Stability rules, combination rules, solver support in the law catalogue |
| AF-31 | §5.10 |
| AF-32, 33 | §5.9 |
| AF-34 | Reviewer acceptance of fits via 09 signing (`reviewedBy`) |
| AF-35 | `parametersSha256`, `conversion`, `fit`, provenance in every result |
| AF-40, 41 | Millisecond queries; offline; MFront optional and reported missing |
| AF-42 | `--dry-run` on mutating commands |

## 8. Performance & robustness budgets

| Operation | Budget (desktop) |
| --------- | ---------------- |
| `add_material_model` incl. Drucker scan (1 980 grid points × 3 modes) | ≤ 20 ms |
| `material_point_response`, 8 steps × 1 000 increments, J2 closed form | ≤ 50 ms |
| same with Chaboche (3 back stresses, local Newton) | ≤ 200 ms |
| `fit_material_model` linear, 100 rows | ≤ 20 ms; LM (V2) ≤ 2 s |
| `export_material_cards` | ≤ 5 ms |

## 9. Test strategy (→ VC ids)

| Level | Location | Covers |
| ----- | -------- | ------ |
| Unit (laws) | `tests/unit/materials/laws/*.test.ts` | Elastic conversions and PD (VC-MATL-03), RO (04), AF/Prager (05), hyperelastic stresses (06), Ogden conversion (07), Drucker (09), Prony/WLF (10), creep (11), J-C (12) — driven by `validation/expected_results.json` |
| Unit (commands) | `tests/unit/materials/materialModels.test.ts` | add/remove/set happy + failure, `is pure`, combination rules, codes (VC-MATL-15) |
| Unit (plugin) | `tests/unit/phys/materials/{driver,fit,writers}.test.ts` | NL1 N10/N1000 (VC-MATL-01/02), Treloar fits (08), card text (13/14) |
| Contract | `tests/unit/contract/` | toolsets, `toToolSchemas()` snapshot, persistence round trip, private-library non-serialization, durability variants accepted |
| Server | `server/tests/physMaterials.ccx.test.ts` | ccx reads every emitted card (single-element decks); pyNastran `read_bdf` round trip of MAT1/MATS1/MAT9 |
| Golden | `tests/golden/plans.ts` | `nl1_material_point_proposed` plan |
| Quality gate | `npm run quality` | `python3 -I validation/generate_matl_reference.py --check` |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 Types + core commands | `materialModel.ts`, catalogue, add/remove/set/check, elastic stability, persistence | PHY-01 M1, 08 M2 | 5 d |
| M2 Driver J2 | small-strain J2, presets, mixed control, RO deformation theory | M1 | 6 d |
| M3 Hyperelastic | stresses, Ogden conversion, Drucker scan | M1 | 4 d |
| M4 CalculiX writers | §6.1 + extension point in 05 deck writer + ccx read tests | M1, 05 M1 | 4 d |
| M5 Linear fits | hyperelastic polynomial family, RO, Prony fixed τ | M3, PHY-01 M4 | 3 d |
| M6 V1 laws | Chaboche, combined, Prony + shift, Norton/Garofalo, J-C/C-S in driver; Nastran writers | M2 | 7 d |
| M7 V2 | LM fits, compressible hyperelastic, Hill-48, MFront/MTest transport (legal review) | M5, M6 | 10 d |

MVP (M1–M4) ≈ 19 d; V1 (M5, M6) ≈ 10 d; V2 ≈ 10 d. PHY-05 needs M1–M4; PHY-07/08 need M1 only (variants + storage).

## 11. Open questions / decisions needed

| Id | Question | Proposed default |
| -- | -------- | ---------------- |
| OQ-MATL-01 | NAFEMS NL1 targets differ from the converged exact radial return by up to 0.95 % (hardening, point 7: 4.230 vs 4.1896 MPa) and 0.12 % (point 6) | Gate on the generator's converged values; keep NAFEMS values as grade B until the NNB original is read |
| OQ-MATL-02 | Treloar primary (1944) not reached; the pinned table is Steinmann 2012's | Keep grade B; re-pin if the primary is found |
| OQ-MATL-03 | The commonly cited Ogden "1972" set fits Treloar UT with 0.29 MPa RMS (worst at λ > 6); is the set mis-quoted? | Report only, no gate (VC-MATL-08) |
| OQ-MATL-04 | CalculiX has no native Prony viscoelasticity; PHY-11 assumed `*VISCO` covers it | Tell PHY-11: `*VISCO` is a step procedure; Prony needs MFront/UMAT (V2) or another solver |
| OQ-MATL-05 | MFront distribution (GPL-3 + linking exception or CeCILL-A) inside the desktop installer | Separate executable, legal review before V2 |
| OQ-MATL-06 | Nastran `CREEP` / `MATEV` / `TABLES1` semantics (total vs plastic strain) not verified | Mark `tbd`; verify with the MSC/NX QRG under licence |
| OQ-MATL-07 | Should `cyclic_ramberg_osgood` (PHY-07) become `ramberg_osgood` with a `cyclic` flag? | Keep two kinds (different parameterisations) and the consistency warning |
| OQ-MATL-08 | Where do test-data CSVs live (document, artifact store, library)? | Inline rows ≤ 10 000; larger via the 05 artifact store hash (V2) |

## 12. References

See FUNCTIONAL_SPEC §11 [R1]–[R15] and `validation/sources.md` [S1]–[S14]. Additionally:

- [T1] llull command layer — `.claude/context/command-layer.md`; `packages/core/src/model/types.ts`; `packages/core/src/commands/document/materials.ts`
- [T2] 08 MAT TECHNICAL_SPEC §3.1, §7.1 — `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`
- [T3] 05 FEA TECHNICAL_SPEC §3 (`FeaMaterialView`), §5.6 (deck writers) — `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`
- [T4] 06 CMP TECHNICAL_SPEC §3 (`LaminaMaterial`), Q2 — `docs/aerospace/06-composites/TECHNICAL_SPEC.md`
- [T5] PHY-01 TECHNICAL_SPEC §3 (`PropertyModel`, `FitRecord`, evaluator) — `docs/physics/01-property-models/TECHNICAL_SPEC.md`
- [T6] PHY-07 / PHY-08 TECHNICAL_SPEC §3.1 (durability variants) — `docs/physics/07-fatigue/`, `docs/physics/08-fracture-damage-tolerance/`

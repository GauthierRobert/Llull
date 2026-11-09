# PHY-06: Nonlinear contact, friction and bolt preload — technical specification

Gap id **PHY-06** · prefix **CNT** · status: M1 + M2 + M3 + M4 built (2026-11-09, §13) · written 2026-10-15 · functional spec:
[`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area                        | What exists                                                                                                                                                                          | Path                                                                               | Limit for this gap                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Assemblies (today)          | `create_component`, `insert_instance`; kinematic joints and `motion_study` without forces                                                                                            | `packages/core/src/commands/assembly/`, `commands/motion/`                         | No contact mechanics                            |
| Interference check (today)  | `motion_study` returns per-step AABB interference pairs between instances                                                                                                            | `packages/core/src/commands/motion/motionStudy.ts`                                 | Bounding-box overlap only, no contact mechanics |
| Aerospace 05 FEA (baseline) | Analysis model, targets (`facesNear` …), `llull-mesh` (Netgen), INP writer, ccx, FRD/DAT readers, margins, `check_analysis`; **V2 hook only**: linear tied contact and bolted joints | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §4, §10                      | This pack supersedes the V2 hook                |
| Aerospace 08 MAT (baseline) | Fastener catalogue (`FastenerFamily`, `FastenerSize` dims), `FastenerStack { axis, layers, fastener, washers, nut, holeStepRef, checks }` in the `@aero` plugin; V2 `joint_capacity` | `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md` §3.3–3.4, §4.2 | No preload, separation or slip                  |
| PHY-05 (baseline)           | `nonlinear_static`, steps with load / displacement control, curve probes, increment parsing, `check_nonlinear`                                                                       | `docs/physics/05-nonlinear-structural/TECHNICAL_SPEC.md` §3–§5                     | No contact                                      |
| PHY-02 (baseline)           | `ConstitutiveSet` per part; material cards through the `MaterialCardWriter`                                                                                                          | `docs/physics/02-constitutive-models/TECHNICAL_SPEC.md` §2–§3                      | —                                               |

A grep of `packages/` for `contact pair`, `friction`, `pretension` and `preload` finds no structural-contact code today.

**CalculiX capabilities relied on** (manual at commit `fd588701…` [R1]):

- `*CONTACT PAIR, INTERACTION=…, TYPE=NODE TO SURFACE | SURFACE TO SURFACE | MORTAR | MASSLESS`, optional `SMALL SLIDING`
  (node-to-face only; face-to-face is small sliding by default) and `ADJUST` (node set or clearance value). **All pairs in
  one deck must be of the same type.** Slave surface may be nodal (node-to-surface, linear elements) or element-face;
  master must be element-face; quadratic elements or face-to-face need element-face slaves.
- `*SURFACE INTERACTION` + `*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE = EXPONENTIAL (c0, p0) | LINEAR (slope K, σ∞, c0) |
TABULAR | TIED (slope K) | HARD`. HARD is reduced to LINEAR with defaults (slope = first elastic constant × 50 for
  node-to-face; σ∞ default E/70 000); for MORTAR true hard contact = omit `*SURFACE BEHAVIOR`. TIED applies to
  face-to-face penalty only and requires a stick slope on `*FRICTION`.
- `*FRICTION` (μ > 0, stick slope λ > 0; λ default = first elastic constant / 2; "about 100 times smaller than the spring
  constant").
- `*PRE-TENSION SECTION, SURFACE=… | ELEMENT=…, NODE=…` with optional normal; reference node DOF 1 carries `*CLOAD` force
  or `*BOUNDARY` differential displacement; the surface must be element faces, must not touch edges of elements without a
  face on it, and must not be adjacent to quadratic elements whose faces belong to a contact surface. Positive force =
  tension.
- `*MODEL CHANGE, TYPE=CONTACT PAIR, ADD | REMOVE` (activate / deactivate pairs per step).
- `*CONTACT PRINT` / `*CONTACT FILE` (CDISP, CSTRESS …), `*CONTROLS, PARAMETERS=CONTACT` (delcon, alea, kscalemax, itf2f).
- Test decks with reference output: `contact1`, `contact2`, `friction1`, `friction2`, `bolt`, `pret1` … `pret7`,
  `hueeber1_mortar` … `hueeber4_mortar` (Hüeber thesis examples), `beamcontact`.

## 2. Target architecture

```
packages/core/src/model/analysis.ts       (05) AnalysisCase.contact?: ContactSettings     (types owned here)
packages/domain-physics/src/contact/      CadPlugin 'contact', toolset 'analysis'  (@phys; PHY-05 §2.1 Proposal A)
   extension.ts contributes contact / pretension deck sections and result summaries to 'nonlinear_static' (pure)
   commands/  add_contact_pair, update_contact_pair, delete_contact_pair, add_bolt_pretension, delete_bolt_pretension,
              contact_report, check_contact, hertz_contact, interference_fit, bolted_joint_check,
              joint_from_fastener_stack (V1), joint_stiffness_from_fe (V1)
   decks/     contactInp.ts (pure: surfaces, interactions, pairs, pretension sections, *MODEL CHANGE per step)
   results/   contactReader.ts (CONTACT PRINT / CONTACT FILE parse), boltForces.ts, separation.ts
   checks/    hertz.ts, lame.ts, nasa5020.ts   (pure; identical to validation/generate_cnt_reference.py)
```

Placement follows PHY-05 §2.1 and PHY-03 §2.1, pending README §5.1: Proposal A — core analysis extension port
(`AnalysisTypeExtension` / `CadPlugin.analysisExtensions`; contact contributes sections to the `nonlinear_static` extension);
Proposal B fallback — the discipline lives inside the 05 FEA package (`packages/domain-cae/src/contact/`). The fastener link reads 08 stacks
through `execute` of an 08 query (never by importing `@aero`, L10) — see §11 q3.

**Laws respected:** L1 (commands only; solving through 05 transports), L2, L3, L4 (contact results in the 05 artifact
store, summaries in the document), L5, L8 (ids `cp-<step>.<k>`, `bp-…`; targets re-resolved by `facesNear`), L9 (section
imprint uses the 05 `intersectPlane` mechanism through an OCCT general fuse in `llull-mesh`, not a new kernel op), L10.

### 2.1 Technical requirements

| Id        | Pri  | Requirement                                                                                                                                                                                                                                                                                        |
| --------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-CNT-01 | MUST | `AnalysisCase.contact?: ContactSettings` only on `nonlinear_static` cases (PHY-05); plugin `validate` enforces one `formulation` per case.                                                                                                                                                         |
| TR-CNT-02 | MUST | Contact surfaces are element-face sets built from 05 `FeaTarget`s (physical groups); a nodal slave is used only for `node_to_surface` with linear elements.                                                                                                                                        |
| TR-CNT-03 | MUST | Pretension section: plane (point, normal) intersected with the bolt part in `llull-mesh` (OCCT general fuse, as 05 `intersectPlane`), element faces on one side collected; the deck writer refuses a section adjacent to quadratic contact faces (ccx rule) with `CNT_PRETENSION_SECTION_INVALID`. |
| TR-CNT-04 | MUST | Preload step order: (1) pretension force applied, external loads at 0; (2) reference DOF locked at its step-1 value (`*BOUNDARY, FIXED` on the reference node; the FIXED parameter is in the manual, its effect on a pretension node is verified in VC-CNT-50); (3) PHY-05 load steps.             |
| TR-CNT-10 | MUST | `contactReader.ts` parses `*CONTACT PRINT` tables and `*CONTACT FILE` frd blocks per increment; bolt force = reaction on the pretension reference node (`*NODE PRINT … RF`). Formats are taken from pinned `.dat.ref` fixtures, not prose.                                                         |
| TR-CNT-20 | MUST | `checks/hertz.ts`, `lame.ts`, `nasa5020.ts` match the generator at 1e-9 relative.                                                                                                                                                                                                                  |
| TR-CNT-30 | MUST | `bolted_joint_check` carries the standard edition (`"NASA-STD-5020 (2012)"`) in every result; a later edition is a new rule-table version, never a silent change.                                                                                                                                  |
| TR-CNT-40 | MUST | Agent contract on every query (AF-10/11/31–36).                                                                                                                                                                                                                                                    |

## 3. Data model

```ts
// packages/core/src/model/analysis.ts — additions owned by PHY-06
export type ContactFormulation = 'node_to_surface' | 'surface_to_surface' | 'mortar';
export type ContactBehaviour =
  | { readonly kind: 'hard' } // ccx HARD (penalty defaults, named) / mortar: no *SURFACE BEHAVIOR
  | { readonly kind: 'linear'; readonly slope: number; readonly tensionAtLargeClearance?: number; readonly c0?: number }
  | { readonly kind: 'exponential'; readonly c0: number; readonly p0: number }
  | { readonly kind: 'tied'; readonly slope: number; readonly stickSlope: number }; // surface_to_surface only
export interface ContactPair {
  readonly id: string;
  name: string;
  slave: FeaTarget;
  master: FeaTarget;
  behaviour: ContactBehaviour;
  friction?: { readonly mu: number; readonly stickSlope?: number }; // absent stickSlope => ccx default, returned named
  adjust?: { readonly kind: 'clearance'; readonly value: number } | { readonly kind: 'none' };
  smallSliding?: boolean; // node_to_surface only
  activeSteps?: readonly string[]; // PHY-05 step ids; absent = all (=> *MODEL CHANGE)
}
export type PreloadSpec =
  | { readonly kind: 'force'; readonly value: number } // analysis force unit
  | {
      readonly kind: 'torque';
      readonly torque: number;
      readonly nutFactor: number;
      readonly diameter: number;
      readonly nutFactorSource: string;
    }; // P = T / (K D), NASA-STD-5020 A.2-1
export interface BoltPretension {
  readonly id: string;
  name: string;
  entityId: EntityId; // the bolt part
  section: { readonly point: Vec3; readonly normal: Vec3 };
  preload: PreloadSpec;
  preloadStepId: string; // PHY-05 step in which the force is applied
  lockAfter: boolean; // TR-CNT-04 (default true, returned named)
}
export interface ContactSettings {
  formulation: ContactFormulation;
  pairs: Record<string, ContactPair>;
  pairOrder: string[];
  pretensions: Record<string, BoltPretension>;
  pretensionOrder: string[];
  penetrationTolerance?: { value: number; source: string }; // for check_contact; no default (AF-31)
  results?: ContactResultsSummary;
}
export interface ContactResultsSummary {
  readonly resultsHash: string;
  readonly inputHash: string;
  readonly perPairStep: readonly {
    pairId: string;
    stepId: string;
    closedAreaFraction: number;
    slidingAreaFraction: number;
    maxPressure: { value: number; at: Vec3 };
    meanPressure: number;
    maxPenetration: number;
    maxSlip: number;
  }[];
  readonly bolts: readonly { pretensionId: string; stepId: string; axialForce: number }[];
  readonly separated: readonly { pairId: string; stepId: string; pretensionId?: string }[];
}

// Read-only joint check input (bolted_joint_check), all quantities explicit with units
export interface BoltedJointInput {
  standard: 'NASA-STD-5020 (2012)';
  control: 'torque' | 'turn' | 'stretch';
  separationCritical: boolean;
  torque?: { nominal: Q; tolerance: Q; runningTorqueMax?: Q; breakawayMin?: Q; aboveRunning: boolean };
  nutFactor?: { value: number; source: string; tested: boolean }; // required for torque control
  nominalDiameter: Q;
  preloadNominal?: Q; // alternative to torque × nut factor
  gamma?: { value: number; source: string; statisticalBasis?: '90/95' }; // absent => standard default (named) unless separationCritical
  lubricated: boolean;
  fastenerCount: number;
  metallicJoint: boolean; // Table 1: 5 % relaxation vs test value
  relaxation?: Q;
  creepLoss?: Q;
  thermalIncrease?: Q;
  thermalDecrease?: Q;
  stiffness: { phi: number; source: string } | { boltStiffness: Q; clampedStiffness: Q };
  loadingPlaneFactor: { value: number; source: string }; // n, no default
  allowableTensile: Q; // Ptu-allow
  limitLoads: { tensionPerFastener: Q; shearJoint?: Q; tensionJoint?: Q; shearPerFastener?: Q };
  factors: { separation: number; ultimate: number; slip: number; fitting: number; source: string }; // no defaults
  friction?: { mu: number; surface: 'uncoated_clean_metal' | 'other'; testRecord?: string };
}
```

Document version: the `contact` field rides the 05 `analysis` slice (aerospace v3 envelope); no migration.

## 4. Commands

Plugin `contact`, toolset `analysis`. Pure `defineCommand`, snake_case; units in every `.describe()` (AF-04).

| Name                                                               | Kind   | Params sketch                                                                                                                                                                                                                         | Tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_contact_pair` / `update_contact_pair` / `delete_contact_pair` | M      | `{ analysisId, name, slave: FeaTarget, master: FeaTarget, formulation?, behaviour, friction?, adjust?, smallSliding?, activeSteps? }`                                                                                                 | @affects case.contact (created on first pair; `formulation` fixed by the first pair) · @invariant one formulation per case; `tied` only with surface_to_surface; `smallSliding` only with node_to_surface · @failure case not nonlinear → `NLS_CASE_NOT_NONLINEAR`; different formulation → `CNT_MIXED_CONTACT_TYPES`; tied with other formulation → `CNT_BEHAVIOUR_FORMULATION_MISMATCH`; μ ≤ 0 → `CNT_FRICTION_INVALID`; targets unresolved → `FEA_TARGET_UNRESOLVED`; slave = master face → `CNT_SELF_PAIR` |
| `add_bolt_pretension` / `delete_bolt_pretension`                   | M      | `{ analysisId, name, entityId, section: { point, normal }, preload: PreloadSpec, preloadStepId, lockAfter? }`                                                                                                                         | @affects case.contact.pretensions · @invariant the plane cuts the bolt part in one closed section; torque preload needs `nutFactor` + `nutFactorSource` · @failure no / multiple section loops → `CNT_PRETENSION_SECTION_INVALID`; missing nut factor → `CNT_NUT_FACTOR_MISSING`; step unknown → `NLS_LOAD_CASE_UNKNOWN`-style `CNT_STEP_UNKNOWN`                                                                                                                                                              |
| `contact_report`                                                   | Q      | `{ analysisId, pair?, step?, increments?: 'summary' \| 'all' }`                                                                                                                                                                       | → per pair / step status, pressures, penetration, slip, bolt forces, separation events, `provenance`, `reviewRequired` · @failure stale → `FEA_RESULTS_STALE`                                                                                                                                                                                                                                                                                                                                                  |
| `check_contact`                                                    | Q      | `{ analysisId }`                                                                                                                                                                                                                      | → pass / warn / fail items (§7.1) including PHY-05 `check_nonlinear` items                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `hertz_contact`                                                    | Q      | `{ inputs: { pair: 'sphere_sphere' \| 'sphere_plane' \| 'cylinder_cylinder' \| 'cylinder_plane', R1_mm, R2_mm?, E1_MPa, nu1, E2_MPa, nu2, load_N? \| loadPerLength_N_per_mm? \| approach_mm? }, units?: 'mm-N-MPa' \| 'in-lbf-psi' }` | → `{ a \| b, p0, approach, force?, subsurface: { tauMaxOverP0, depthOverA, unverified: true } }` + formula and source                                                                                                                                                                                                                                                                                                                                                                                          |
| `interference_fit`                                                 | Q      | `{ inner: { innerRadius, outerRadius, E, nu }, outer: { outerRadius, E, nu }, radialInterference, plane: 'stress' \| 'strain' }` (lengths in mm, moduli in MPa)                                                                       | → contact pressure, radial / hoop stresses at both bores; Lamé                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bolted_joint_check`                                               | Q      | `BoltedJointInput` (§3)                                                                                                                                                                                                               | → `data` §5.3; status pass / warn / fail with codes · @failure separation-critical without test-derived Γ → `CNT_GAMMA_TEST_DATA_REQUIRED`; torque control without nut factor → `CNT_NUT_FACTOR_MISSING`; factors absent → `CNT_FACTORS_UNSET`                                                                                                                                                                                                                                                                 |
| `joint_from_fastener_stack`                                        | M (V1) | `{ analysisId, stackId, preload: PreloadSpec, preloadStepId, friction? }`                                                                                                                                                             | composes `add_contact_pair` / `add_bolt_pretension` through `execute` from the 08 stack geometry · @failure stack not found → `CNT_STACK_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                            |
| `joint_stiffness_from_fe`                                          | Q (V1) | `{ analysisId, pretensionId, loadProbe, stepId }`                                                                                                                                                                                     | → `nPhi` = Δ(bolt force)/Δ(applied load) over the unseparated part of the step, range used; refuses if separated throughout (`CNT_SEPARATED`)                                                                                                                                                                                                                                                                                                                                                                  |

Every description follows AF-02, e.g. `bolted_joint_check`: "Computes preload range, separation and slip margins of a
preloaded threaded joint with the NASA-STD-5020 (2012) equations. All forces in N (or lbf with units=in-lbf-psi), torque in
N·m. Needs nut factor (torque control), stiffness factor φ and loading-plane factor n, factors of safety and limit loads;
Γ defaults to the standard's 25 % / 35 % only for non-separation-critical joints and is reported as defaulted. Refuses
separation-critical joints without test-derived Γ. Next: compute_margins or the FE route (add_bolt_pretension)."

## 5. Algorithms

### 5.1 Deck extension (pure)

```
*SURFACE, NAME=CS_<pair>_S (element faces) | TYPE=NODE (node_to_surface, linear elements)
*SURFACE, NAME=CS_<pair>_M
*SURFACE INTERACTION, NAME=SI_<pair>
*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=HARD|LINEAR|EXPONENTIAL|TIED   (omitted for mortar + hard)
*FRICTION  mu, lambda
*CONTACT PAIR, INTERACTION=SI_<pair>, TYPE=<formulation>[, SMALL SLIDING][, ADJUST=<value>]
CS_<pair>_S, CS_<pair>_M
*SURFACE, NAME=PS_<bolt>  (section faces)      *NODE  <ref node, not attached to any element>
*PRE-TENSION SECTION, SURFACE=PS_<bolt>, NODE=<ref>   nx, ny, nz
*STEP ... (PHY-05)   *CLOAD  <ref>, 1, <preload>   |   next step: *BOUNDARY, FIXED <ref>, 1  (TR-CNT-04)
*MODEL CHANGE, TYPE=CONTACT PAIR, REMOVE|ADD  (activeSteps)
*CONTACT PRINT  CSTRESS, CDISP     *CONTACT FILE  CDIS, CSTR     *NODE PRINT, NSET=<ref>  RF, U
```

### 5.2 Hertz and Lamé (identical to the generator)

| Quantity                         | Formula                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| Effective modulus / radius       | 1/E\* = (1 − ν1²)/E1 + (1 − ν2²)/E2; 1/R = 1/R1 + 1/R2 (plane: 1/R2 = 0)                                                                                                                    |
| Line contact, load P′ per length | b = √(4 P′ R / (π E\*)); p0 = 2 P′/(π b)                                                                                                                                                    |
| Point contact, force P           | a = (3 P R / (4 E\*))^(1/3); p0 = 3 P/(2π a²); δ = a²/R                                                                                                                                     |
| Point contact, approach δ        | a = √(R δ); p0 = (2E*/π) √(δ/R); P = (4/3) E* √R δ^(3/2)                                                                                                                                    |
| Subsurface (axis)                | sphere: σz = −p0/(1 + ζ²), σr = −p0[(1 + ν)(1 − ζ atan(1/ζ)) − 1/(2(1 + ζ²))]; line: σx = −p0[(1 + 2ζ²)/√(1 + ζ²) − 2ζ], σz = −p0/√(1 + ζ²); τ = ½                                          | σ1 − σ3 | maximised numerically — **unverified** (Johnson 1985 not fetched) |
| Lamé                             | u(r) = A r + B/r, σr = E/(1 − ν²)[(1 + ν)A − (1 − ν)B/r²] (plane stress; plane strain by E → E/(1 − ν²), ν → ν/(1 − ν)); contact pressure p solves u_hub(b) − u_shaft(b) = δ_r by bisection |

Reference reproductions (generator): SSNP154 b = 6.21463 mm, p0 = 3585.362 MPa (code_aster prints 6.21 / 3585.37; rel.
diff −2.2e-6); SSNV104 p0 = 2798.329 MPa (code_aster 2798.3; 1.0e-5).

### 5.3 NASA-STD-5020 (2012) joint check

```
Ppi-nom = T / (K D)                                          (A.2-1)      [or preloadNominal]
Tmax, Tmin from spec ± tolerance; minus running / breakaway torque unless "above running" (A.2-4…7)
Ppi-max = (1 + Γ) Tmax / (K D)                               (A.2-2, 6-4)
Ppi-min = (1 − Γ) Tmin / (K D)       separation-critical / fatigue          (A.2-3a, 6-5a)
Ppi-min = (1 − Γ/nf) Tmin / (K D)    slip, non-critical separation          (A.2-3b, 6-5b)
Pp-max = Ppi-max + PΔt-max                                   (6-2)
Pp-min = Ppi-min − Ppr − Ppc − PΔt-min; Ppr = 5 % Ppi-min (all-metal) else test value   (6-3, Table 1)
φ = kb/(kb + kc)                                             (6-8);   Pt,bolt = Pp + nφ Pt   (6-7)
P′tu = (Ptu-allow − Pp-max)/(nφ)  (6-9);  P′sep = Pp-max/(1 − nφ)  (6-10)
if P′sep < P′tu: separation before rupture → ultimate MS without preload (6-6; equation text not extracted, §11 q5)
else MSu = P′tu/(FF · FSu · PtL) − 1                          (6-11)
MSsep = Pp-min(sep)/(FF · FSsep · PtL) − 1                    (6-23)
MSslip = nf μ Pp-min(slip)/(FS (PsL-joint + μ PtL-joint)) − 1 (A.10-4; A.10-5 without tension; A.10-6 per fastener)
```

Named defaults (AF-31), applied only when the input is absent and reported with `defaulted: true`:

| Value                      | Default                                                    | Applies                                                           | Source                        |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| Γ torque control           | 0.25 lubricated, 0.35 non-lubricated / as received         | max preload always; min preload only when not separation-critical | NASA-STD-5020 §6.1.d(1)A [R2] |
| Γ turn-of-nut / turn-angle | 0.25 (or test variation if greater)                        | same                                                              | §6.1.d(2)A                    |
| Γ bolt stretch control     | 0.10 (or test variation if greater)                        | same                                                              | §6.1.d(3)A                    |
| Short-term relaxation      | 5 % of minimum initial preload, all-metallic clamped parts | Pp-min                                                            | Table 1                       |
| Friction cap               | 0.2 clean uncoated metal; 0.1 all other surfaces           | maximum allowed μ without test substantiation                     | §6.4                          |

No default for: nut factor, φ, n, factors of safety, fitting factor, μ itself, limit loads. The separation factor of safety
logic of the standard's Figure 1 could not be read from the text extract, so `factors.separation` is always an input
(§11 q4).

`data` shape:

```json
{
  "standard": "NASA-STD-5020 (2012)",
  "units": { "force": "N", "torque": "N*m" },
  "preload": {
    "nominalN": 7874.01574803,
    "maxN": 10334.6456693,
    "minSeparationN": 5329.72440945,
    "minSlipN": 6662.15551181,
    "gamma": { "value": 0.25, "source": "NASA-STD-5020 6.1.d(1)A", "defaulted": true },
    "relaxation": { "value": 0.05, "source": "NASA-STD-5020 Table 1 (all-metallic)", "defaulted": true }
  },
  "linearTheory": { "nPhi": 0.125, "PsepPrimeN": 11811.023622, "PtuPrimeN": 77322.8346457, "separationBeforeRupture": true },
  "margins": [
    { "criterion": "joint_separation", "ms": 1.22071850394, "equation": "6-23" },
    { "criterion": "joint_slip", "ms": 0.168799212598, "equation": "A.10-4" }
  ],
  "status": "pass",
  "items": [{ "code": "CNT_DEFAULT_GAMMA_USED", "severity": "warning" }],
  "unverified": true,
  "unverifiedReasons": ["nut factor without test record"],
  "reviewRequired": true,
  "summary": "Separation MS 1.22, slip MS 0.17 (Γ defaulted 25 %). Computed by llull, not approved — needs a qualified engineer."
}
```

(The numbers are the worked example of `validation/bolted_joint_nasa5020.json`.)

### 5.4 Separation and slip from FE

- **Separation**: for each pretension, the clamped contact pairs whose master or slave faces lie within the bolt's
  clamp zone (contact faces intersecting a cylinder of 3 × bolt diameter around the axis — llull rule, named) report
  `closedAreaFraction`; separation = fraction reaches 0 in a step (first increment recorded).
- **Slip**: `slidingAreaFraction` > 0 on a pair with friction; reported per step with max slip.
- **nφ extraction (V1)**: linear regression of bolt force vs applied-load probe over increments with no separation.

### 5.5 Tolerances

| Item                         | Value                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Analytic checks vs generator | 1e-9 relative                                                                        |
| Penetration warning          | `penetrationTolerance` input (no default); unset → `CNT_PENETRATION_TOLERANCE_UNSET` |
| FE benchmarks                | per case (2–5 %, README)                                                             |

## 6. Interop & persistence

| Format                                             | Direction | Implementation                         |
| -------------------------------------------------- | --------- | -------------------------------------- |
| CalculiX INP contact / pretension keywords         | out       | `decks/contactInp.ts` (pure)           |
| CalculiX `.dat` CONTACT PRINT, `.frd` CONTACT FILE | in        | `results/contactReader.ts`             |
| Joint check report                                 | out       | JSON / CSV via `--save`                |
| Nastran (SOL 400 contact, BCTSET / BCPROP)         | —         | not in scope (no verified QRG; §11 q6) |

## 7. CLI / MCP / UI surfaces

- **CLI**: `llull <command>`; `llull guide` gains a joints section: minimal bolted-joint check, which inputs have no
  default, separation-critical rule, contact set-up order (pretension step → lock → loads), end with `check_contact`.
- **MCP**: toolset `analysis`; prompt `bolted_joint_review`.
- **UI (review)**: contact overlay fields `cstatus`, `cpress`, `cslip` (05 overlay), joint table panel.

### 7.1 Stable codes (AF-11)

| Code                                 | Severity       | When                                                                             | Offending ids / path     | Remediation                                                |
| ------------------------------------ | -------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `CNT_MIXED_CONTACT_TYPES`            | error          | second pair with another formulation                                             | pair id                  | use one formulation per analysis (CalculiX rule)           |
| `CNT_BEHAVIOUR_FORMULATION_MISMATCH` | error          | `tied` not surface-to-surface, `smallSliding` not node-to-surface                | pair id                  | change formulation or behaviour                            |
| `CNT_SELF_PAIR`                      | error          | slave and master resolve to the same faces                                       | pair id                  | pick distinct faces                                        |
| `CNT_FRICTION_INVALID`               | error          | μ ≤ 0 or stick slope ≤ 0                                                         | param path               | positive values                                            |
| `CNT_INITIAL_OVERCLOSURE`            | warning        | slave nodes penetrate the master at start beyond `adjust`                        | pair id, max overclosure | set `adjust` or fix geometry                               |
| `CNT_RIGID_BODY_BY_CONTACT_ONLY`     | warning        | a part is restrained only through contact                                        | entity id                | add a weak support or a displacement-controlled first step |
| `CNT_PRETENSION_SECTION_INVALID`     | error          | section plane misses the bolt, cuts it twice, or touches quadratic contact faces | pretension id            | move the plane to a plain shank region                     |
| `CNT_NUT_FACTOR_MISSING`             | error          | torque preload without nut factor / source                                       | param path               | give the tested nut factor with its source                 |
| `CNT_STEP_UNKNOWN`                   | error          | pretension step id not in the case                                               | pretension id            | add the PHY-05 step first                                  |
| `CNT_CONTACT_NOT_CONVERGED`          | error          | contact iterations fail (ccx)                                                    | step, increment          | smaller increments, `adjust`, check pair orientation       |
| `CNT_PENETRATION_EXCESSIVE`          | warning        | max penetration > `penetrationTolerance`                                         | pair id, value           | raise penalty slope or use mortar                          |
| `CNT_PENETRATION_TOLERANCE_UNSET`    | warning        | no tolerance given                                                               | analysis id              | give a tolerance with a source                             |
| `CNT_SEPARATED`                      | fail           | a preloaded joint separates in a load step                                       | pretension id, step      | raise preload or redesign; reviewer decides                |
| `CNT_SLIP`                           | warning / fail | sliding on a pair marked `noSlipRequired`                                        | pair id, step            | raise preload or add shear pins                            |
| `CNT_GAMMA_TEST_DATA_REQUIRED`       | error          | separation-critical joint without test-derived Γ (90/95)                         | `gamma`                  | torque-tension tests per the standard §6.1.b/c             |
| `CNT_DEFAULT_GAMMA_USED`             | warning        | Γ defaulted from the standard                                                    | `gamma`                  | supply test data when available                            |
| `CNT_FRICTION_ABOVE_CAP`             | fail           | μ above 0.2 (clean uncoated metal) / 0.1 (other) without a test record           | `friction.mu`            | use the cap or a test-substantiated value                  |
| `CNT_FACTORS_UNSET`                  | error          | factors of safety / fitting factor not given                                     | `factors`                | ask the owner / programme for the factors                  |
| `CNT_MS_NEGATIVE`                    | fail           | a joint margin < 0                                                               | criterion                | redesign; only a qualified reviewer can disposition (05)   |
| `CNT_STACK_NOT_FOUND`                | error          | V1 stack id unknown                                                              | stack id                 | check `check_fastener_layout` (08)                         |
| `CNT_SUBSURFACE_UNVERIFIED`          | warning        | Hertz subsurface values returned                                                 | —                        | formula source not yet verified                            |

Reused: `NLS_*` (PHY-05), `FEA_*` (05), `VNV_NO_CONVERGENCE_STUDY` (PHY-00), `MATL_EXPORT_UNSUPPORTED` (PHY-02).

### 7.2 Agent-first compliance

| AF             | Where                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- |
| AF-01…05       | registry commands, unit descriptions, guide section, plans                                      |
| AF-10/12/13    | `contact_report`, `bolted_joint_check` shapes; paged increments; deterministic                  |
| AF-11          | §7.1                                                                                            |
| AF-20/21       | `check_contact`; pressures, areas, margins as numbers                                           |
| AF-30/31       | 5020 rule table with sources; named defaults §5.3; no defaults for safety factors               |
| AF-32/33/35/36 | `unverified` for untested nut factors / μ; `reviewRequired`; equations in `provenance`; summary |
| AF-34          | negative joint margins → 05 `dispose_margin` (human gate)                                       |
| AF-40/41/42    | PHY-05 progress; ccx bundled; `--dry-run`                                                       |

## 8. Performance & robustness budgets

| Budget                                            | Target                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Analytic queries                                  | < 10 ms each                                                                                           |
| SSNP154-size FE (plane-strain slice, ≈ 20k nodes) | ≤ 3 min (TBD — measure)                                                                                |
| Contact convergence                               | ≥ 90 % of the validation plans converge with `ccx_default` and documented increments (production gate) |

## 9. Test strategy

| Layer             | Tests                                                                                                                                                                                      | VC                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Unit              | commands happy / failure / pure; deck golden text for each formulation and pretension; `hertz`, `lame`, `nasa5020` vs JSON; reader on pinned `contact1` / `friction1` / `pret1` `.dat.ref` | 10–13 (analytic), 20, 30, 40, 60–63 |
| Integration (ccx) | SSNP154 and SSNV104 plans, interference fit, friction block, pretension bar, pinned ccx decks                                                                                              | 10, 11, 20, 30, 50, 51              |
| Harness           | PHY-00 `run_benchmarks`                                                                                                                                                                    | all A-grade                         |
| Production gate   | US-1 and US-3 unattended                                                                                                                                                                   | —                                   |

## 10. Delivery plan

| M       | Content                                                                                                    | Depends on          | Effort |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------------------- | ------ |
| M1      | `hertz_contact`, `interference_fit`, `bolted_joint_check` (pure), codes, guide section                     | PHY-05 M1 types     | 1.5 w  |
| M2      | Contact pairs, friction, deck writer, contact reader, `contact_report`, `check_contact`, VC-10/11/20/30/50 | PHY-05 M2           | 3 w    |
| M3      | Pretension (section imprint, lock), bolt forces, separation detection, VC-51                               | M2, 05 face imprint | 2 w    |
| M4 (V1) | `joint_from_fastener_stack`, pin-in-hole template, `joint_stiffness_from_fe`, joint margins in 05          | M3, 08 M6 stacks    | 2 w    |

## 11. Open questions / decisions needed

1. **Edition**: equations and defaults come from the 2012 baseline of NASA-STD-5020 (fetched). 5020B (2021, revalidated
   2026 per search) could not be opened; a human must diff the two before the rule table is frozen.
2. **Lock keyword**: the manual documents `*BOUNDARY, FIXED` ("freezes the deformation from the previous step"); confirm
   on a `pret*`-style deck that applying it to the pretension reference node holds the bolt length (VC-CNT-50).
3. **08 stack access**: `joint_from_fastener_stack` needs an 08 query returning stack geometry (none is specified in 08
   §4.2 beyond `check_fastener_layout`); add `list_fastener_stacks` to 08 or extend `check_fastener_layout` data.
4. **Separation factor of safety**: the standard's Figure 1 logic flow was not readable; `factors.separation` stays an
   input until a human transcribes it.
5. **Eq. 6-6** (ultimate MS when separation precedes rupture) text was not captured in the extract; implement after a
   transcription check. As built: no ultimate margin, warning `CNT_ULTIMATE_MARGIN_PENDING` until transcribed (§13.1 D9).
6. **Lug analysis method**: AFFDL stress manual / ESDU 91008 not verified; keep FE template only.
7. **Subsurface Hertz formulas**: fetch Johnson (1985) or an equivalent open source to lift `CNT_SUBSURFACE_UNVERIFIED`.

## 12. References

- [R1] CalculiX User's Manual and test suite — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R2] NASA-STD-5020 (2012-03-12) — NASA — https://imlive.s3.amazonaws.com/Federal%20Government/ID22733872581604231767905658536785766455/NASA-STD-5020.pdf (accessed 2026-10; sha256 ea1b5b03e9a1c00ba166715fe88c493c58a7d8ef35a44d1dbf09623acb41100a)
- [R3] code_aster SSNP154 — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnp154a.comm (accessed 2026-10)
- [R4] code_aster SSNV104 — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnv104a.comm (accessed 2026-10)
- [R6] K. L. Johnson, Contact Mechanics (1985) — not fetched
- Repo: `.dependency-cruiser.cjs`, `docs/aerospace/05-fea-cae-handoff/`, `docs/aerospace/08-materials-standards-libraries/`, `docs/physics/05-nonlinear-structural/`, `docs/physics/02-constitutive-models/`.

## 13. As built (M1 + M2, 2026-11-07; M3, 2026-11-08, §13.3)

Placement: Proposal B of §2 (the discipline lives in the 05 package, `packages/domain-cae/src/contact/`, plugin `cae`, toolset `analysis`).
Types: `packages/core/src/model/contact.ts` (`ContactSettings`, `ContactPair`, `ContactBehaviour`, `ContactFormulation`), `AnalysisCase.contact?`;
the 05 `FeaTarget` moved to `packages/core/src/model/feaTarget.ts` (shared by `analysis.ts` and `contact.ts`).
Pretension (`add_bolt_pretension`, `BoltPretension`, `PreloadSpec`) is M3, built in §13.3; it lives in `AnalysisCase.pretension`, not in `ContactSettings` (D15).

| Command                                                            | Kind | File                                                                                     |
| ------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------- |
| `hertz_contact`                                                    | Q    | `contact/hertzCommand.ts` (formulas `contact/hertz.ts`)                                  |
| `interference_fit`                                                 | Q    | `contact/interferenceCommand.ts` (`contact/lame.ts`)                                     |
| `bolted_joint_check`                                               | Q    | `contact/boltedJointCommand.ts` (schema `boltedJointSchema.ts`, equations `nasa5020.ts`) |
| `add_contact_pair` / `update_contact_pair` / `delete_contact_pair` | M    | `contact/pairCommands.ts` (rules `pairRules.ts`, schema `pairSchema.ts`)                 |
| `contact_report` / `check_contact`                                 | Q    | `contact/queries.ts` (reader `reader.ts`, items `check.ts`, `overclosure.ts`)            |

Deck (`contact/deck.ts`, called by `nonlinear/deck.ts`): model data before the first `*STEP`: per pair (n = its 1-based position in `pairOrder`, so deck names can never collide)
`*SURFACE, NAME=CPS_<n> | CPM_<n>, TYPE=ELEMENT` from the mesh face sets `CP_<pairId>_S|M` (new mesh target keys, `hash/targets.ts`), `*SURFACE INTERACTION, NAME=CPI_<n>`,
`*SURFACE BEHAVIOR` (HARD / LINEAR `slope[, σ∞][, c0]` / EXPONENTIAL `c0, p0` / TIED `slope`; none for mortar + hard), `*FRICTION mu[, λ]`
(tied: `1, stickSlope`), `*CONTACT PAIR, INTERACTION=…, TYPE=…[, SMALL SLIDING][, ADJUST=<analysis length>]`. Per step: `*MODEL CHANGE,
TYPE=CONTACT PAIR, REMOVE | ADD` where `activeSteps` changes (a pair starts active), `*CONTACT FILE[, FREQUENCY=n]` `CDIS, CSTR`. The pair
set-up is part of the full input hash (pair names and `noSlipRequired`, a check judgement, excluded), its targets of the mesh hash; the analysis guard keeps referenced entities.
Load validation: `contact/validate.ts` (zod shape + ids / order / names / reserved keys / entity refs / steps / pair rules).

Reader (`contact/reader.ts`): the frd `CONTACT` block (COPEN, CSLIP1, CSLIP2, CPRESS, CSHEAR1, CSHEAR2), last stored increment per step (or
all), integrated over the slave faces with tributary corner areas: closed = CPRESS > 0, sliding = |shear| ≥ 0.99 μ p (llull rule),
penetration = max(0, −COPEN), normal / shear force = Σ p A / Σ |τ| A, `closedBox` of the closed nodes.

### 13.1 Decisions (open points decided while building)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rejected option                                             | Why                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Contact results are recomputed from the trusted artifacts on every `contact_report` / `check_contact`; no `ContactSettings.results` summary is stored.                                                                                                                                                                                                                                                                                                      | Store `ContactResultsSummary` (§3)                          | 05 TR-FEA-05: a stored summary is a claim that must be re-verified against its artifact anyway; a second claim doubles the trust surface.                                                                                                                       |
| D2  | Read source = frd `*CONTACT FILE` (CDIS, CSTR); `*CONTACT PRINT` is not requested.                                                                                                                                                                                                                                                                                                                                                                          | Parse `.dat` CONTACT PRINT tables (TR-CNT-10)               | The frd block layout was pinned on real CalculiX 2.21 output (fixture `tests/unit/cae/fixtures/ccx221_contact_excerpt.frd`); `*CONTACT PRINT, CF` was refused by ccx 2.21 on our decks ("no existing contact pair defined") and its table layout is not pinned. |
| D3  | The first pair must state `formulation` (`CNT_FORMULATION_UNSET`), later pairs inherit it.                                                                                                                                                                                                                                                                                                                                                                  | Default `surface_to_surface`                                | The three formulations differ in accuracy and convergence; AF-31 forbids a silent default for a modelling choice.                                                                                                                                               |
| D4  | Tied pairs take no `friction`; the deck writes `*FRICTION 1, stickSlope` (μ on the card, tied does not slide).                                                                                                                                                                                                                                                                                                                                              | Accept a friction μ on tied pairs                           | ccx needs the stick slope on `*FRICTION` for TIED; a μ there has no meaning for glued faces. Deck accepted and solved by ccx 2.21 (§13.2).                                                                                                                      |
| D5  | `penetrationTolerance` is a `check_contact` input, not stored.                                                                                                                                                                                                                                                                                                                                                                                              | `ContactSettings.penetrationTolerance`                      | It is a reviewer judgement, not a model input: storing it would make it part of the input hash and stale the results.                                                                                                                                           |
| D6  | `hertz_contact` takes unit-suffixed keys (mm, N, MPa) only; no `units` switch.                                                                                                                                                                                                                                                                                                                                                                              | `units: 'in-lbf-psi'`                                       | A switch would change the meaning of `R1_mm` etc.; same convention as `hand_check`.                                                                                                                                                                             |
| D7  | `bolted_joint_check` uses Ppi-min = (1 − Γ) Tmin/(K D) (A.2-3a) for the separation margin of every joint; (1 − Γ/n_f) only for slip.                                                                                                                                                                                                                                                                                                                        | (1 − Γ/n_f) for non-critical separation (FR-CNT-05 wording) | VC-CNT-40.a/d bind the conservative form for the worked (non-critical) example; it is stated in `data.assumptions`.                                                                                                                                             |
| D8  | `bolted_joint_check.status` is pass / fail / incomplete: fail = a fail item (negative margin, friction above cap); incomplete = the check could not be completed (D9); warnings (defaulted Γ) are items.                                                                                                                                                                                                                                                    | pass / warn / fail                                          | §5.3 shows `status: pass` with a warning item; warnings stay visible in `items`; an incomplete check must never read as pass. `check_contact` keeps pass / warn / fail.                                                                                         |
| D9  | Separation before rupture: no ultimate margin, warning `CNT_ULTIMATE_MARGIN_PENDING` and `status: incomplete` (review round 1). Eq. 6-6 is not transcribed: the archived PDF ([R2], sha256 ea1b5b03…) is not in the repo or on this machine, and its text was not captured in the extract (§11 q5). The reviewer's reading (MS_u = Ptu-allow / (FF · FSu · PtL) − 1, preload ignored once separated) is plausible but unverified, so it is not implemented. | Compute MS_u from 6-11, or from the unverified reading      | 6-11 is the rupture-first case; implementing an equation from memory would state an unsupported margin. The worked example (VC-CNT-40) separates first, so it reports `incomplete`.                                                                             |
| D10 | `noSlipRequired?: boolean` on a pair feeds `CNT_SLIP` (fail).                                                                                                                                                                                                                                                                                                                                                                                               | No slip flag in M2                                          | §7.1 names `noSlipRequired`; without it CNT_SLIP could never fire.                                                                                                                                                                                              |
| D12 | `noSlipRequired` needs friction (`CNT_FRICTION_INVALID`); it is excluded from the input hash (toggling it keeps results current).                                                                                                                                                                                                                                                                                                                           | Hash it with the pair                                       | A frictionless pair always slides; like D5 it is a judgement of the check, not a model input.                                                                                                                                                                   |
| D11 | Contact `unverified` flag dropped from `contact_report`: layout and COPEN sign are pinned on ccx 2.21 output.                                                                                                                                                                                                                                                                                                                                               | Keep `unverified` until VC-CNT-50 `.dat.ref` decks          | The real runs (§13.2) confirmed the six components and penetration = p / slope = −COPEN for surface_to_surface.                                                                                                                                                 |

New codes beyond §7.1: `CNT_FORMULATION_UNSET`, `CNT_BEHAVIOUR_INVALID`, `CNT_ADJUST_INVALID`, `CNT_PAIR_NOT_FOUND`, `CNT_PAIR_NAME_TAKEN`,
`CNT_NOTHING_TO_UPDATE`, `CNT_CONTACT_RESULTS_MISSING`, `CNT_HERTZ_INPUT_INVALID`, `CNT_LAME_INPUT_INVALID`, `CNT_INPUT_INVALID`,
`CNT_ULTIMATE_MARGIN_PENDING`.

### 13.2 Validation status

Solver runs: CalculiX 2.21 (Windows build), Netgen 6.2.2604 through `llull-mesh`, on 2026-11-07.

| VC                     | Status                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VC-CNT-01              | pass (plan)                                                          | `tests/unit/cae/contact/plans.test.ts`: `cnt_ssnp154_cylinder_block` replays (tet in place of hex*dominant, which is not built), pair recorded, `CP*` mesh targets requested; replay keeps the slice (`pairs.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| VC-CNT-10.a/b analytic | pass                                                                 | `hertz_contact` = generator at 1e-9 (`analytic.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| VC-CNT-10 FE           | half-width pass, p0 **fail** (ccx, plan as written with tet order 1) | `cnt_ssnp154_cylinder_block` with tet in place of hex_dominant: 18 451 nodes, 54 700 C3D4, solved in 2 min 14 s (7 increments, 79 iterations). `contact_report`: closed nodes span x −6.06 … 6.55 mm → half-width **6.31 mm** vs 6.2146 (+1.5 %, within 2 %); max pressure **5512 MPa** vs 3585.36 (+54 %); normal force 39 746 N vs 35 000 N (+13.6 %, nodal integration). The 1 mm slice holds ~0.4 linear tets through its thickness: the peak pressure needs quadratic elements or a finer slice. A C3D10 run of the same plan did not finish within 35 min on this machine. Not gated in a test (runtime); re-measure after hex_dominant (planned plan mesh) or a refined slice. |
| VC-CNT-11.a–c, 12      | pass (analytic)                                                      | 1e-9 vs generator; FE sphere model is V1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| VC-CNT-13.a/b          | pass (grade B)                                                       | subsurface τmax/p0 and depth reproduce the generator (1e-9 / 1e-6); still `unverified` (Johnson not fetched)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| VC-CNT-20.a/b          | pass (analytic)                                                      | p 39.375 MPa, hub bore hoop 65.625 MPa at 1e-9; FE shrink-fit check not built (needs interference geometry, V1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| VC-CNT-30.a            | **pass (ccx)**                                                       | `server/tests/feaContact.test.ts`: 10 mm steel cube on an equal cube, 10 MPa, μ 0.2, slid 0.05 mm: ground reaction plateau **199.85 N** vs μN = 200 N (−0.07 %); pressing step normal force 1000.16 N (+0.02 %), whole face closed and sticking; sliding step τ/p = 0.2000 at every slave node, sliding fraction 1                                                                                                                                                                                                                                                                                                                                                                    |
| VC-CNT-40.a–i          | pass                                                                 | `analytic.test.ts` (1e-9 vs `bolted_joint_nasa5020.json`, cap, defaults 25 / 35 %, separation-critical refusal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| VC-CNT-50              | partial (ccx)                                                        | All deck variants accepted and solved by ccx 2.21 on the block model: surface_to_surface LINEAR / HARD, MORTAR (no behaviour card), NODE TO SURFACE + SMALL SLIDING, TIED with `*FRICTION 1, λ`; EXPONENTIAL and `*MODEL CHANGE … REMOVE` are read without error (the free block then diverges, as expected). frd CONTACT layout pinned. Pending: reproduction of the CalculiX test decks `contact1`, `friction1`, `hueeber1_mortar` against their `.dat.ref` (not available offline).                                                                                                                                                                                                |
| VC-CNT-51              | **pass (ccx)**                                                       | M3, §13.3: `server/tests/feaPretension.test.ts`: section force 9974 N (-0.26 %, tolerance 0.5 %), each end reaction exactly 10 000 N                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| VC-CNT-60              | pass                                                                 | `CNT_MIXED_CONTACT_TYPES` (`pairs.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| VC-CNT-61              | pass                                                                 | stick slope default reported `{ value: E1/2 = 105000 MPa/mm, source: "CalculiX *FRICTION default …", defaulted: true }` (`add_contact_pair` summary, `contact_report.pairs`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| VC-CNT-62              | pass                                                                 | `reviewRequired: true` and "not approved" on every contact / joint / Hertz result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| VC-CNT-63              | pass                                                                 | untested nut factor → `unverified: true` on every margin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| VC-CNT-65              | pass                                                                 | `CNT_INITIAL_OVERCLOSURE` (mesh-based measurement beyond adjust), `CNT_RIGID_BODY_BY_CONTACT_ONLY`, `CNT_BEHAVIOUR_FORMULATION_MISMATCH` (refused by the commands and on load; re-checked by `check_contact`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Measured accuracy note: forces integrate the nodal (extrapolated) contact pressures. Exact for a uniform pressure (1000.16 N for 1000 N); where
the pressure peaks at an edge the integral is high: +4.4 % on the sliding cube (1043.9 N for 1000 N), +5.7 % for a 10 mm punch on a 20 mm
base. Use reactions (curve probes) for absolute forces.

Not built in M2: `*CONTACT PRINT` parsing, the guide section of `llull guide` (CLI lane), contact overlay fields in the UI, margins
integration (FR-CNT-12) of `bolted_joint_check`.

### 13.3 As built, M3: bolt pretension (2026-11-08)

Types: `packages/core/src/model/contact.ts` (`PreloadSpec`, `BoltPretension`, `PretensionSettings`), `AnalysisCase.pretension?: { bolts, order }`.

| Command / piece                                                                     | Kind | File                                                                                                  |
| ----------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `add_bolt_pretension` / `delete_bolt_pretension`                                    | M    | `contact/pretensionCommands.ts` (rules `pretensionRules.ts`, load validation `pretensionValidate.ts`) |
| mesh cut (section imprint)                                                          | pure | `contact/pretensionSection.ts`                                                                        |
| deck: duplicate nodes, equations, preload / lock steps                              | pure | `contact/pretensionDeck.ts` (called by `decks/deckBuilder.ts` and `nonlinear/deck.ts`)                |
| bolt forces, shortening, clamp zone, separation                                     | pure | `contact/pretensionResults.ts`, `contact/boltReport.ts`                                               |
| `contact_report` (+ `bolts`, `clamp`, `separated`) / `check_contact` (+ bolt items) | Q    | `contact/queries.ts`, `contact/check.ts`                                                              |

`add_bolt_pretension { analysisId, name, entityId, section { point, normal }, preload, preloadStepId, lockAfter? }`, preload = `{ kind: "force", value }` (analysis force unit)
or `{ kind: "torque", torque, diameter, nutFactor, nutFactorSource }` with P = T / (K D) (torque in analysis force x analysis length, diameter in document length units;
nut factor and source required, `CNT_NUT_FACTOR_MISSING` otherwise). Ids `bp-<step>.<k>`; affected `[analysisId, boltId]`.

Deck (`contact/pretensionDeck.ts`): the bolt part's elements are split by the side of the plane their centroid lies on. The nodes shared by both sides are duplicated
(new ids above the mesh nodes, bolts in order, cut nodes ascending: a `*NODE` card after the mesh nodes), the high-side elements are written with the copies, a reference node
(`*NODE, NSET=PTN_n`, above the duplicates) carries u, and per cut node and component c an `*EQUATION` `high_c - low_c + n_c u = 0` (n = unit section normal, from the
low to the high side). u is the shortening of the bolt (positive = tension). Step 1: `*CLOAD` `ref, 1, P`; later steps of a locked bolt: `*CLOAD ref, 1, 0` and `*BOUNDARY, FIXED`
`ref, 1, 1`; an unlocked bolt keeps the constant `*CLOAD`. Every step: `*NODE PRINT, NSET=PTN_n` `U, RF`.

Results (`contact_report`): per bolt and step `axialForce` (tension +), `shearForce`, `bendingMoment`, `torsion`, `shortening` (reference node U1 from the `.dat` table), `preload`;
force = sum over the cut faces of (sigma . area vector) . n with the nodal stress (frd `STRESS`) averaged between the low-side node and its duplicate, edge-midpoint rule (exact for a
linear stress field), moments about the area-weighted centroid. `clamp`: closed fraction of each pair's slave area within 1.5 bolt diameters of the axis, last increment of each step;
`separated`: first increment in which that zone is fully open (CPRESS = 0 at every node).

New codes: `CNT_PRELOAD_INVALID`, `CNT_PRETENSION_SECTION_INVALID` (plane outside the part, zero normal, one side only, more than one cut, a cut node in a constraint, load or probe
node set), `CNT_PRETENSION_STEP_ORDER`, `CNT_PRETENSION_NOT_FOUND`, `CNT_SEPARATED` (check_contact, fail), `CNT_PRELOAD_MISMATCH` (warning: section force after the preload step
differs from the preload by more than 5 %). `CNT_STEP_UNKNOWN` and `CNT_NUT_FACTOR_MISSING` are the §7.1 ones. `bolted_joint_check` is unchanged: D9 stands (no ultimate margin, `status: incomplete`
when the joint separates first; eq. 6-6 is not transcribed).

#### Decisions (M3)

| #   | Decision                                                                                                                                                                                                                                                                | Rejected option                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D13 | The pretension section is written explicitly (duplicate the cut nodes, `*EQUATION`s to a reference node), not with CalculiX `*PRE-TENSION SECTION`.                                                                                                                     | The keyword (TR-CNT-03 / 04 as drafted)                                     | Measured on CalculiX 2.21 with the exact keyword and a clean planar cut: a 1 x 1 x 2 steel bar of 12 Kuhn tets with a jump of 0.01 mm prescribed on the reference node gave an end reaction of **333.3 N**, a third of E A / L x 0.01 (1000 N); with a force of 10 000 N the 2 x 2 x 20 bar gave 946 N and the 849-node Netgen cylinder 596 N, plus lateral reactions. Cause: ccx renumbers only the elements that own a face of the surface (2 of the 6 tets of a Kuhn cube); the manual's rule that the surface must not touch edges of elements without a face on it cannot hold for a tet mesh, and the others bridge the cut. The same mechanism written explicitly gives the end reaction **10 000.0 N** exactly (the bar and the Netgen cylinder). The keyword stays right for hex meshes (not built). |
| D14 | The section is cut from the mesh at deck time by element-centroid side (jagged within one element size), with no OCCT imprint and no mesher change; `section` stays a plane (point, normal).                                                                            | Plane imprint in `llull-mesh` (TR-CNT-03), or snapping nodes onto the plane | `llull-mesh` does not implement `intersectPlane` (the 05 face imprint is not built); with explicit equations a jagged cut is exact: the high side is translated rigidly by -n u. Snapping would distort elements. The cut treats the mid-side nodes of C3D10 elements as shared nodes, so the quadratic-contact restriction of TR-CNT-03 (a ccx keyword rule) is not applied; second-order (C3D10) meshes are tested too (D27).                                                                                                                                                                                                                                                                                                                                                                               |
| D15 | Bolts live in `AnalysisCase.pretension`, separate from `contact`.                                                                                                                                                                                                       | `ContactSettings.pretensions` (§3)                                          | `contact` requires a formulation fixed by its first pair and at least one pair; the validation bar (VC-CNT-51) has no pair. A separate field keeps both slices valid on their own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D16 | `preloadStepId` must be the first step of the case (`CNT_PRETENSION_STEP_ORDER`); several bolts are tightened together there.                                                                                                                                           | Preload in any step                                                         | Before its preload the section is an open cut (u carries no load: a free mechanism), so a later preload would leave the bolt severed in the steps before it. A tightening sequence is V1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D17 | `lockAfter` absent = true, named in the summary. Locked = `*CLOAD ref, 1, 0` and `*BOUNDARY, FIXED` in every later step (the bolt length is held, external loads add to the preload through the joint stiffness); unlocked = the force stays (`*CLOAD` constant).       | Leave the first `*CLOAD` in place under FIXED                               | The load is zeroed so the fixed degree of freedom does not fight a persistent load. Measured (VC-CNT-51 lock case): stretching the bar by 0.01 mm adds 2773 N when locked (E A delta / L = 2738 N, +1.3 %) and 0 N when unlocked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D18 | The bolt force is the stress integral over the cut faces; the reaction of the reference node is not read.                                                                                                                                                               | RF of the reference node (TR-CNT-10)                                        | CalculiX prints RF = 0 for that degree of freedom whether it is free or fixed (it is an independent term of the equations; verified in a locked step), so it carries no force. (The duplicates do carry it: D25.) The stress integral gives axial force, shear and bending as well; one-sided nodal stress biased the bending (3200 N*mm for a pure axial case), the low / high mean removes it (47 N*mm).                                                                                                                                                                                                                                                                                                                                                                                                    |
| D19 | Separation = the whole clamp zone of a pair (slave nodes within 1.5 bolt diameters of the axis, the diameter from the cut area) is open (CPRESS = 0), first increment recorded; increments of the preload step before its last do not count; `CNT_SEPARATED` is a fail. | Whole-pair closure                                                          | A bolted joint opens locally; whole-pair closure would never trigger on a large plate. The preload step is skipped because a gap closes while the preload builds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D20 | The validation plan `cnt_pretension_bar` has one fixed constraint and one reaction probe per end.                                                                                                                                                                       | One `ends` constraint                                                       | The summed reaction of both ends is 0 (the plan's own note), so it could not show the 10 kN.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

#### VC-CNT-51 measured (CalculiX 2.21, Netgen 6.2.2604, 2026-11-08)

Bar r 3 mm, L 20 mm (faceted cylinder, 849 nodes, 3017 C3D4, cut of 63 faces, projected area 27.38 mm^2), E 200 GPa, P 10 000 N: section force **9974.0 N** (oracle 10 000, -0.26 %, tolerance 0.5 %),
end reactions **-10 000.0 / +10 000.0 N** (exact), shear 1.4 N, bending 47 N\*mm, bolt shortening 0.03596 mm. Lock case (top end driven 0.01 mm in step 2): locked +2773 N (oracle +2738 N), unlocked +0 N
with the shortening reduced by exactly 0.01 mm. Without `add_bolt_pretension` the same test fails (`CNT_PAIR_NOT_FOUND`, end reactions 0). Not built: the `pret1` to `pret7` decks of the ccx test suite
(not available offline; they exercise the keyword that D13 replaces). `joint_stiffness_from_fe` and `joint_from_fastener_stack` are M4 (§13.4).

#### Review round 1 (M3)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D21 | An element above several cuts takes the copy of every cut it lies above; two sections of one part that share a node are refused (`CNT_PRETENSION_SECTION_INVALID`, "keep the planes one element apart"). Deck-level invariant tested: every duplicate sits in an element, no element above a cut keeps a cut node, none below holds a copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The first version substituted only the first bolt's copies, which left the second cut bridged (found in review). Real ccx: two bolts in series on one bar, each section force equal to its own preload.          |
| D22 | `fea_import_results` accepts a CalculiX frd of a pretensioned case: the file may hold, besides the mesh nodes, exactly the duplicate nodes the case's bolts produce (`pretensionExtraNodes`, same numbering as the deck); reference nodes belong to no element, CalculiX does not write them, they are tolerated if present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `frdMeshProblem` refused such a file (`FEA_RESULTS_MESH_MISMATCH`).                                                                                                                                              |
| D23 | Result fields stay keyed by mesh node ids: a mesh node on the cut reads the LOW-side copy; the high-side copies are not mesh nodes and are left out of `fea_result_field` count / min / max / mean; renderers, vtu and fatigue fields read the low copy at the cut, so the high face of the cut is not drawn separately. Stated in the `fea_result_field` and `contact_report` descriptions and tested at a cut node.                                                                                                                                                                                                                                                                                                                                                                                                             | Mapping copies back for every consumer (vtu, fields, fatigue, views) is a cross-lane change; bolt forces, shear and bending come from `contact_report` on both faces. Revisit when a viewer needs the high face. |
| D24 | Unit conversion is tested with a centimetre document in a millimetre analysis (cut-node coordinates, plane, torque preload with D converted: 50 / (0.2 x 5 mm) = 50 N). A metre or inch document cannot be paired with N-mm-t-s (`FEA_UNITS_MISMATCH`), so cm is the only mm-analysis case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A dropped conversion makes the test fail (mutation shown).                                                                                                                                                       |
| D25 | The bolt readout carries `reactionForce` = -(sum of RF of the duplicate nodes) . n: CalculiX DOES report the equation (MPC) force as RF on the duplicates (measured: duplicates -10 000 N, low copies +10 000 N for a 10 kN preload), unlike the reference node (RF 0). The deck prints it per step (`*NODE PRINT, NSET=PTD_n, TOTALS=ONLY`, `RF`). D18 stays: the stress integral is the primary readout (it also gives shear and bending), RF the cross-check.                                                                                                                                                                                                                                                                                                                                                                  | Reviewer item 8, measured.                                                                                                                                                                                       |
| D26 | `CNT_SEPARATED` means no slave node of the pair inside the clamp zone is in contact; partial opening is not flagged (the spec §5.4 says "reaches 0"): `clamp.closedFraction` shows it. Stated in the message and the `contact_report` description.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | No closed-fraction threshold exists in the spec; inventing one would be an unsupported criterion.                                                                                                                |
| D27 | Second-order meshes are supported and tested: unit (all duplicates attached, mid-side nodes of the cut duplicated, 27 equations for a 9-node cut) and real ccx (C3D10 bar, section force 1 %, end reactions 0.5 %).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Quality-first: tested rather than refused.                                                                                                                                                                       |
| D28 | `llull-mesh` conformal bonding (`mesh_conformal`) fuses interface nodes between parts, so a cut node can belong to an element of another part. The cut refuses such a node (`CNT_PRETENSION_SECTION_INVALID`, "also a node of part ..."), and a part with a node without coordinates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The duplicate would leave the other part attached to the low copy only.                                                                                                                                          |
| D29 | Coordinate fallbacks removed: a missing node coordinate is a named refusal, no `?? [0,0,0]`. `check_contact`: no stress on any section face is an error, stress on some faces only a warning with the counts. The validation plan's displacement probe moved to z = 3 mm (a probe node on the cut is refused by the deck). Load validation of the slice is linear time (hostile-input entry `cae: pretensionErrors`: non-array order, reserved key, infinite section point).                                                                                                                                                                                                                                                                                                                                                      | Review items 5 to 7, 11.                                                                                                                                                                                         |
| D30 | M3b, per consumer of a pretensioned case's results. **VTU export** maps the high face: `writeVtu(..., cut)` (hook `pretensionResultMap`, `fea_export format vtu`) writes the duplicate nodes as extra points at the cut position, the high-side cells use them and every point array reads the copy's own value. **FE fatigue** (`fatigueFieldInput`) takes the mean of the low and high copies at a cut node (the unsplit nodal stress averages the elements on both sides; the same low / high mean as the bolt force readout, D18). **Margins** need no mapping: `compute_margins` refuses a `nonlinear_static` case for every stress criterion (`FEA_ANALYSIS_TYPE_UNSUPPORTED`, tested on a pretensioned case) and `limit_load` reads probe curves, not nodal fields. `fea_result_field`, renderers keep the low copy (D23). | Low side for all consumers; refuse fatigue on pretensioned cases                                                                                                                                                 | Quality-first: the VTU is the one consumer that draws both faces, fatigue would otherwise take one-sided extrapolation. Tests `tests/unit/cae/contact/pretensionConsumers.test.ts` (mutation: reading the low copy only fails the fatigue test). Deck + imperfection: `pretensionImperfection.test.ts` (duplicates take the imperfect coordinates). |

### 13.4 As built, M4: fastener-stack joints, joint stiffness, pin-in-hole, joint margins (2026-11-09)

Files in `packages/domain-cae/src/contact/`; plugin `cae`, toolset `analysis`.

| Command                              | Kind  | File                                                                                                                        |
| ------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| `joint_from_fastener_stack`          | M     | `jointFromStack.ts` (stack reader `stackRead.ts`, plate geometry `stackGeometry.ts`, frustum stiffness `stackStiffness.ts`) |
| `joint_stiffness_from_fe`            | Q     | `jointStiffnessCommand.ts` (bolt-force / load series `jointSeries.ts`)                                                      |
| `joint_margins`                      | Q     | `jointMargins.ts`                                                                                                           |
| `pin_in_hole` / `pin_bearing_report` | M / Q | `pinInHole.ts` (distribution maths `pinBearingMath.ts`)                                                                     |

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rejected option                                                | Why                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D31 | `joint_from_fastener_stack` reads `CadDocument.fasteners.stacks` as plain document data (`stackRead.ts`, structural validation, no import of `@aero`, L10); it needs no 08 query (§11 q3 answered: the slice is the public data). The stack record has no plate extents, so the plates' extents along the axis come from their bounds projected on it (`stackGeometry.ts`: exact for plates normal to the axis, an upper bound otherwise).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `list_fastener_stacks` in 08; importing the fasteners types    | The slice is already persisted, validated on load and versioned with the document; a new query would duplicate it.                                                                                 |
| D32 | The command takes `boltEntityId`, a SOLID part of the analysis, and does not create the bolt: the stack's bolt is an `instance` entity, which the mesher cannot mesh (`explode_instance`, then `set_part_idealization`). Washers and the nut instance are not modelled (named in the summary); the bolt part must carry a bearing face at each outer plate face. The set-up is: one pretension at the grip mid-plane normal to the axis, one pair per clamped interface (upper plate slave, lower plate master) and, with `bearing`, a head pair and a nut pair (plate slave, bolt master), all through `execute('add_bolt_pretension' / 'add_contact_pair')`, all or nothing (a refusal names the sub-command and passes its code). Face-selection points sit 0.65 hole diameters off the axis on the interface planes.                                                                                                                                                         | Creating the bolt solid, washer and nut parts and a thread tie | A faithful bolt / nut / thread model is a modelling choice the owner has not made; the explicit bolt part keeps the set-up honest. Open: a head / nut / thread idealisation (tied nut pair) is V2. |
| D33 | `joint_from_fastener_stack` returns a Shigley frustum stiffness estimate in `data.stiffness` (k_b, k_m in N/mm, phi): eq. 8-13 for a shank over the whole grip (thread in the grip ignored, k_b high, phi conservative for the bolt load) and eq. 8-18 for 30 degree cones from a 1.5 d bearing face meeting at mid-grip, series over the layers (eq. 8-20 for one material). Oracle: the closed form eq. 8-20 derived in `tests/unit/cae/contact/jointFromStack.test.ts` (1e-8) and the identity "two layers of one material = one layer of the total thickness". The worked numeric examples of the book were not available offline and are not used.                                                                                                                                                                                                                                                                                                                          | VDI 2230 sleeve method                                         | One published method, stated assumptions; VDI 2230 needs the thread / nut dimensions the stack does not hold.                                                                                      |
| D34 | `joint_stiffness_from_fe` fits the bolt axial force (section stress, D18) against the applied load (a curve probe, a reaction taken with the sign flipped) by least squares over the increments of ONE step after the preload step, from the last increment of the previous step, stopping before the first fully open increment (D19); `CNT_SEPARATED` when fewer than 2 remain. Reports nPhi, secant, r2 and the range used, phi = nPhi / n when n is given. Real CalculiX: the locked 6 x 20 mm bar of VC-CNT-51 under a driven end gives nPhi = 1 within 2 % (the whole load passes the one bolt: `server/tests/feaPretension.test.ts`).                                                                                                                                                                                                                                                                                                                                     | The secant between two increments                              | One noisy increment pair would set the factor.                                                                                                                                                     |
| D35 | `joint_margins` (FR-CNT-12) returns 05-style rows with `criterion` `joint_separation` and `fastener_ultimate`: MS_sep = P_sep / (FF FS_sep P_design) - 1 with P_sep the load of the last closed increment (a lower bound, or the largest load reached: basis lower_bound); MS_u = P_tu-allow / N - 1 with N the bolt force on the FE curve at the factored load FF FS_u P_design (no eq. 6-6: D9 stands for the analytic route). Factors, design load, allowable and their sources are required, none defaulted (`CNT_FACTORS_UNSET`). Rows are `reviewRequired`, FAIL / MARGINAL are `pending_human` through the 05 `dispositionOf`.                                                                                                                                                                                                                                                                                                                                            | Adding the criteria to `compute_margins`                       | `compute_margins` is a shared file under other lanes; the rows carry the same disposition fields but `dispose_margin` does not yet resolve a `joint` row key (left, below).                        |
| D36 | Pin in hole: `pin_in_hole` adds the contact pair (hole wall of the plate slave, pin wall master, selected at mid-thickness) for an EXPLICIT clearance (hole > pin diameter, else `CNT_PIN_FIT_INVALID`, an interference is `interference_fit`) and returns the closed-form bearing estimate when `pinLoad` is given: nominal P / (d t) and the rigid-pin cosine peak 4 P / (pi d t) (oracle derived in `pinInHole.test.ts`: the resultant of p0 cos(theta) over -90..90 degrees is p0 d t pi / 4). `pin_bearing_report` reads the FE: per hole-wall node the angle from the load direction, CPRESS, hoop stress e_theta . S . e_theta, the peak, the contact half-angle, the resultant along / across the load and the largest hoop stress. Tested on the cosine oracle (resultant within 0.5 % of P on a 72-gon wall) and a hoop oracle (sigma_yy = 100 gives 100 at 0 deg, 0 at 90 deg). A real pin / lug CalculiX run is not built. The analytic lug method (§11) stays open. | Analytic lug factors (Air Force stress manual / ESDU)          | Source not verified (§1).                                                                                                                                                                          |

Measured against the validation items: VC-CNT-64 partial (pairs and pretension created as listed, Shigley oracle, cosine oracle; no FE run of the 08 sample stack or of a pin in a lug); VC-CNT-52 (V1 bolted flange FE vs `bolted_joint_check`) not built.

Not built in M4: `joint_slip` as an FE margin row; `dispose_margin` / `compute_margins` integration of the `joint` rows (FR-CNT-12 last clause); the nut / washer / thread idealisation; a CalculiX run of `joint_from_fastener_stack` on a meshed bolted flange; the `llull guide` section; UI overlays.

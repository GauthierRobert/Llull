# PHY-06: Nonlinear contact, friction and bolt preload — technical specification

Gap id **PHY-06** · prefix **CNT** · status: specification · written 2026-10-15 · functional spec:
[`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit for this gap |
| ---- | ----------- | ---- | ------------------ |
| Assemblies (today) | `create_component`, `insert_instance`; kinematic joints and `motion_study` without forces | `packages/core/src/commands/assembly/`, `commands/motion/` | No contact mechanics |
| Interference check (today) | `motion_study` returns per-step AABB interference pairs between instances | `packages/core/src/commands/motion/motionStudy.ts` | Bounding-box overlap only, no contact mechanics |
| Aerospace 05 FEA (baseline) | Analysis model, targets (`facesNear` …), Gmsh, INP writer, ccx, FRD/DAT readers, margins, `check_analysis`; **V2 hook only**: linear tied contact and bolted joints | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §4, §10 | This pack supersedes the V2 hook |
| Aerospace 08 MAT (baseline) | Fastener catalogue (`FastenerFamily`, `FastenerSize` dims), `FastenerStack { axis, layers, fastener, washers, nut, holeStepRef, checks }` in the `@aero` plugin; V2 `joint_capacity` | `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md` §3.3–3.4, §4.2 | No preload, separation or slip |
| PHY-05 (baseline) | `nonlinear_static`, steps with load / displacement control, curve probes, increment parsing, `check_nonlinear` | `docs/physics/05-nonlinear-structural/TECHNICAL_SPEC.md` §3–§5 | No contact |
| PHY-02 (baseline) | `ConstitutiveSet` per part; material cards through the `MaterialCardWriter` | `docs/physics/02-constitutive-models/TECHNICAL_SPEC.md` §2–§3 | — |

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
imprint uses the 05 `intersectPlane` mechanism through Gmsh `occ.fragment`, not a new kernel op), L10.

### 2.1 Technical requirements

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-CNT-01 | MUST | `AnalysisCase.contact?: ContactSettings` only on `nonlinear_static` cases (PHY-05); plugin `validate` enforces one `formulation` per case. |
| TR-CNT-02 | MUST | Contact surfaces are element-face sets built from 05 `FeaTarget`s (physical groups); a nodal slave is used only for `node_to_surface` with linear elements. |
| TR-CNT-03 | MUST | Pretension section: plane (point, normal) intersected with the bolt part in Gmsh (`occ.fragment`, as 05 `intersectPlane`), element faces on one side collected; the deck writer refuses a section adjacent to quadratic contact faces (ccx rule) with `CNT_PRETENSION_SECTION_INVALID`. |
| TR-CNT-04 | MUST | Preload step order: (1) pretension force applied, external loads at 0; (2) reference DOF locked at its step-1 value (`*BOUNDARY, FIXED` on the reference node — exact keyword spelling verified in a ccx run, VC-CNT-50); (3) PHY-05 load steps. |
| TR-CNT-10 | MUST | `contactReader.ts` parses `*CONTACT PRINT` tables and `*CONTACT FILE` frd blocks per increment; bolt force = reaction on the pretension reference node (`*NODE PRINT … RF`). Formats are taken from pinned `.dat.ref` fixtures, not prose. |
| TR-CNT-20 | MUST | `checks/hertz.ts`, `lame.ts`, `nasa5020.ts` match the generator at 1e-9 relative. |
| TR-CNT-30 | MUST | `bolted_joint_check` carries the standard edition (`"NASA-STD-5020 (2012)"`) in every result; a later edition is a new rule-table version, never a silent change. |
| TR-CNT-40 | MUST | Agent contract on every query (AF-10/11/31–36). |

## 3. Data model

```ts
// packages/core/src/model/analysis.ts — additions owned by PHY-06
export type ContactFormulation = 'node_to_surface' | 'surface_to_surface' | 'mortar';
export type ContactBehaviour =
  | { readonly kind: 'hard' }                                     // ccx HARD (penalty defaults, named) / mortar: no *SURFACE BEHAVIOR
  | { readonly kind: 'linear'; readonly slope: number; readonly tensionAtLargeClearance?: number; readonly c0?: number }
  | { readonly kind: 'exponential'; readonly c0: number; readonly p0: number }
  | { readonly kind: 'tied'; readonly slope: number; readonly stickSlope: number };  // surface_to_surface only
export interface ContactPair {
  readonly id: string; name: string;
  slave: FeaTarget; master: FeaTarget;
  behaviour: ContactBehaviour;
  friction?: { readonly mu: number; readonly stickSlope?: number };   // absent stickSlope => ccx default, returned named
  adjust?: { readonly kind: 'clearance'; readonly value: number } | { readonly kind: 'none' };
  smallSliding?: boolean;                                            // node_to_surface only
  activeSteps?: readonly string[];                                   // PHY-05 step ids; absent = all (=> *MODEL CHANGE)
}
export type PreloadSpec =
  | { readonly kind: 'force'; readonly value: number }                                   // analysis force unit
  | { readonly kind: 'torque'; readonly torque: number; readonly nutFactor: number; readonly diameter: number;
      readonly nutFactorSource: string };                                                // P = T / (K D), NASA-STD-5020 A.2-1
export interface BoltPretension {
  readonly id: string; name: string;
  entityId: EntityId;                               // the bolt part
  section: { readonly point: Vec3; readonly normal: Vec3 };
  preload: PreloadSpec;
  preloadStepId: string;                            // PHY-05 step in which the force is applied
  lockAfter: boolean;                               // TR-CNT-04 (default true, returned named)
}
export interface ContactSettings {
  formulation: ContactFormulation;
  pairs: Record<string, ContactPair>; pairOrder: string[];
  pretensions: Record<string, BoltPretension>; pretensionOrder: string[];
  penetrationTolerance?: { value: number; source: string };          // for check_contact; no default (AF-31)
  results?: ContactResultsSummary;
}
export interface ContactResultsSummary {
  readonly resultsHash: string; readonly inputHash: string;
  readonly perPairStep: readonly {
    pairId: string; stepId: string; closedAreaFraction: number; slidingAreaFraction: number;
    maxPressure: { value: number; at: Vec3 }; meanPressure: number; maxPenetration: number; maxSlip: number;
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
  nutFactor?: { value: number; source: string; tested: boolean };       // required for torque control
  nominalDiameter: Q;
  preloadNominal?: Q;                                                    // alternative to torque × nut factor
  gamma?: { value: number; source: string; statisticalBasis?: '90/95' }; // absent => standard default (named) unless separationCritical
  lubricated: boolean;
  fastenerCount: number;
  metallicJoint: boolean;                                                // Table 1: 5 % relaxation vs test value
  relaxation?: Q; creepLoss?: Q; thermalIncrease?: Q; thermalDecrease?: Q;
  stiffness: { phi: number; source: string } | { boltStiffness: Q; clampedStiffness: Q };
  loadingPlaneFactor: { value: number; source: string };                 // n, no default
  allowableTensile: Q;                                                   // Ptu-allow
  limitLoads: { tensionPerFastener: Q; shearJoint?: Q; tensionJoint?: Q; shearPerFastener?: Q };
  factors: { separation: number; ultimate: number; slip: number; fitting: number; source: string };   // no defaults
  friction?: { mu: number; surface: 'uncoated_clean_metal' | 'other'; testRecord?: string };
}
```

Document version: the `contact` field rides the 05 `analysis` slice (aerospace v3 envelope); no migration.

## 4. Commands

Plugin `contact`, toolset `analysis`. Pure `defineCommand`, snake_case; units in every `.describe()` (AF-04).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `add_contact_pair` / `update_contact_pair` / `delete_contact_pair` | M | `{ analysisId, name, slave: FeaTarget, master: FeaTarget, formulation?, behaviour, friction?, adjust?, smallSliding?, activeSteps? }` | @affects case.contact (created on first pair; `formulation` fixed by the first pair) · @invariant one formulation per case; `tied` only with surface_to_surface; `smallSliding` only with node_to_surface · @failure case not nonlinear → `NLS_CASE_NOT_NONLINEAR`; different formulation → `CNT_MIXED_CONTACT_TYPES`; tied with other formulation → `CNT_BEHAVIOUR_FORMULATION_MISMATCH`; μ ≤ 0 → `CNT_FRICTION_INVALID`; targets unresolved → `FEA_TARGET_UNRESOLVED`; slave = master face → `CNT_SELF_PAIR` |
| `add_bolt_pretension` / `delete_bolt_pretension` | M | `{ analysisId, name, entityId, section: { point, normal }, preload: PreloadSpec, preloadStepId, lockAfter? }` | @affects case.contact.pretensions · @invariant the plane cuts the bolt part in one closed section; torque preload needs `nutFactor` + `nutFactorSource` · @failure no / multiple section loops → `CNT_PRETENSION_SECTION_INVALID`; missing nut factor → `CNT_NUT_FACTOR_MISSING`; step unknown → `NLS_LOAD_CASE_UNKNOWN`-style `CNT_STEP_UNKNOWN` |
| `contact_report` | Q | `{ analysisId, pair?, step?, increments?: 'summary' \| 'all' }` | → per pair / step status, pressures, penetration, slip, bolt forces, separation events, `provenance`, `reviewRequired` · @failure stale → `FEA_RESULTS_STALE` |
| `check_contact` | Q | `{ analysisId }` | → pass / warn / fail items (§7.1) including PHY-05 `check_nonlinear` items |
| `hertz_contact` | Q | `{ inputs: { pair: 'sphere_sphere' \| 'sphere_plane' \| 'cylinder_cylinder' \| 'cylinder_plane', R1_mm, R2_mm?, E1_MPa, nu1, E2_MPa, nu2, load_N? \| loadPerLength_N_per_mm? \| approach_mm? }, units?: 'mm-N-MPa' \| 'in-lbf-psi' }` | → `{ a \| b, p0, approach, force?, subsurface: { tauMaxOverP0, depthOverA, unverified: true } }` + formula and source |
| `interference_fit` | Q | `{ inner: { innerRadius, outerRadius, E, nu }, outer: { outerRadius, E, nu }, radialInterference, plane: 'stress' \| 'strain' }` (lengths in mm, moduli in MPa) | → contact pressure, radial / hoop stresses at both bores; Lamé |
| `bolted_joint_check` | Q | `BoltedJointInput` (§3) | → `data` §5.3; status pass / warn / fail with codes · @failure separation-critical without test-derived Γ → `CNT_GAMMA_TEST_DATA_REQUIRED`; torque control without nut factor → `CNT_NUT_FACTOR_MISSING`; factors absent → `CNT_FACTORS_UNSET` |
| `joint_from_fastener_stack` | M (V1) | `{ analysisId, stackId, preload: PreloadSpec, preloadStepId, friction? }` | composes `add_contact_pair` / `add_bolt_pretension` through `execute` from the 08 stack geometry · @failure stack not found → `CNT_STACK_NOT_FOUND` |
| `joint_stiffness_from_fe` | Q (V1) | `{ analysisId, pretensionId, loadProbe, stepId }` | → `nPhi` = Δ(bolt force)/Δ(applied load) over the unseparated part of the step, range used; refuses if separated throughout (`CNT_SEPARATED`) |

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

| Quantity | Formula |
| -------- | ------- |
| Effective modulus / radius | 1/E* = (1 − ν1²)/E1 + (1 − ν2²)/E2; 1/R = 1/R1 + 1/R2 (plane: 1/R2 = 0) |
| Line contact, load P′ per length | b = √(4 P′ R / (π E*)); p0 = 2 P′/(π b) |
| Point contact, force P | a = (3 P R / (4 E*))^(1/3); p0 = 3 P/(2π a²); δ = a²/R |
| Point contact, approach δ | a = √(R δ); p0 = (2E*/π) √(δ/R); P = (4/3) E* √R δ^(3/2) |
| Subsurface (axis) | sphere: σz = −p0/(1 + ζ²), σr = −p0[(1 + ν)(1 − ζ atan(1/ζ)) − 1/(2(1 + ζ²))]; line: σx = −p0[(1 + 2ζ²)/√(1 + ζ²) − 2ζ], σz = −p0/√(1 + ζ²); τ = ½|σ1 − σ3| maximised numerically — **unverified** (Johnson 1985 not fetched) |
| Lamé | u(r) = A r + B/r, σr = E/(1 − ν²)[(1 + ν)A − (1 − ν)B/r²] (plane stress; plane strain by E → E/(1 − ν²), ν → ν/(1 − ν)); contact pressure p solves u_hub(b) − u_shaft(b) = δ_r by bisection |

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

| Value | Default | Applies | Source |
| ----- | ------- | ------- | ------ |
| Γ torque control | 0.25 lubricated, 0.35 non-lubricated / as received | max preload always; min preload only when not separation-critical | NASA-STD-5020 §6.1.d(1)A [R2] |
| Γ turn-of-nut / turn-angle | 0.25 (or test variation if greater) | same | §6.1.d(2)A |
| Γ bolt stretch control | 0.10 (or test variation if greater) | same | §6.1.d(3)A |
| Short-term relaxation | 5 % of minimum initial preload, all-metallic clamped parts | Pp-min | Table 1 |
| Friction cap | 0.2 clean uncoated metal; 0.1 all other surfaces | maximum allowed μ without test substantiation | §6.4 |

No default for: nut factor, φ, n, factors of safety, fitting factor, μ itself, limit loads. The separation factor of safety
logic of the standard's Figure 1 could not be read from the text extract, so `factors.separation` is always an input
(§11 q4).

`data` shape:

```json
{
  "standard": "NASA-STD-5020 (2012)", "units": { "force": "N", "torque": "N*m" },
  "preload": { "nominalN": 7874.01574803, "maxN": 10334.6456693, "minSeparationN": 5329.72440945, "minSlipN": 6662.15551181,
               "gamma": { "value": 0.25, "source": "NASA-STD-5020 6.1.d(1)A", "defaulted": true },
               "relaxation": { "value": 0.05, "source": "NASA-STD-5020 Table 1 (all-metallic)", "defaulted": true } },
  "linearTheory": { "nPhi": 0.125, "PsepPrimeN": 11811.023622, "PtuPrimeN": 77322.8346457, "separationBeforeRupture": true },
  "margins": [{ "criterion": "joint_separation", "ms": 1.22071850394, "equation": "6-23" },
              { "criterion": "joint_slip", "ms": 0.168799212598, "equation": "A.10-4" }],
  "status": "pass", "items": [{ "code": "CNT_DEFAULT_GAMMA_USED", "severity": "warning" }],
  "unverified": true, "unverifiedReasons": ["nut factor without test record"],
  "reviewRequired": true, "summary": "Separation MS 1.22, slip MS 0.17 (Γ defaulted 25 %). Computed by llull, not approved — needs a qualified engineer."
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

| Item | Value |
| ---- | ----- |
| Analytic checks vs generator | 1e-9 relative |
| Penetration warning | `penetrationTolerance` input (no default); unset → `CNT_PENETRATION_TOLERANCE_UNSET` |
| FE benchmarks | per case (2–5 %, README) |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| CalculiX INP contact / pretension keywords | out | `decks/contactInp.ts` (pure) |
| CalculiX `.dat` CONTACT PRINT, `.frd` CONTACT FILE | in | `results/contactReader.ts` |
| Joint check report | out | JSON / CSV via `--save` |
| Nastran (SOL 400 contact, BCTSET / BCPROP) | — | not in scope (no verified QRG; §11 q6) |

## 7. CLI / MCP / UI surfaces

- **CLI**: `llull <command>`; `llull guide` gains a joints section: minimal bolted-joint check, which inputs have no
  default, separation-critical rule, contact set-up order (pretension step → lock → loads), end with `check_contact`.
- **MCP**: toolset `analysis`; prompt `bolted_joint_review`.
- **UI (review)**: contact overlay fields `cstatus`, `cpress`, `cslip` (05 overlay), joint table panel.

### 7.1 Stable codes (AF-11)

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `CNT_MIXED_CONTACT_TYPES` | error | second pair with another formulation | pair id | use one formulation per analysis (CalculiX rule) |
| `CNT_BEHAVIOUR_FORMULATION_MISMATCH` | error | `tied` not surface-to-surface, `smallSliding` not node-to-surface | pair id | change formulation or behaviour |
| `CNT_SELF_PAIR` | error | slave and master resolve to the same faces | pair id | pick distinct faces |
| `CNT_FRICTION_INVALID` | error | μ ≤ 0 or stick slope ≤ 0 | param path | positive values |
| `CNT_INITIAL_OVERCLOSURE` | warning | slave nodes penetrate the master at start beyond `adjust` | pair id, max overclosure | set `adjust` or fix geometry |
| `CNT_RIGID_BODY_BY_CONTACT_ONLY` | warning | a part is restrained only through contact | entity id | add a weak support or a displacement-controlled first step |
| `CNT_PRETENSION_SECTION_INVALID` | error | section plane misses the bolt, cuts it twice, or touches quadratic contact faces | pretension id | move the plane to a plain shank region |
| `CNT_NUT_FACTOR_MISSING` | error | torque preload without nut factor / source | param path | give the tested nut factor with its source |
| `CNT_STEP_UNKNOWN` | error | pretension step id not in the case | pretension id | add the PHY-05 step first |
| `CNT_CONTACT_NOT_CONVERGED` | error | contact iterations fail (ccx) | step, increment | smaller increments, `adjust`, check pair orientation |
| `CNT_PENETRATION_EXCESSIVE` | warning | max penetration > `penetrationTolerance` | pair id, value | raise penalty slope or use mortar |
| `CNT_PENETRATION_TOLERANCE_UNSET` | warning | no tolerance given | analysis id | give a tolerance with a source |
| `CNT_SEPARATED` | fail | a preloaded joint separates in a load step | pretension id, step | raise preload or redesign; reviewer decides |
| `CNT_SLIP` | warning / fail | sliding on a pair marked `noSlipRequired` | pair id, step | raise preload or add shear pins |
| `CNT_GAMMA_TEST_DATA_REQUIRED` | error | separation-critical joint without test-derived Γ (90/95) | `gamma` | torque-tension tests per the standard §6.1.b/c |
| `CNT_DEFAULT_GAMMA_USED` | warning | Γ defaulted from the standard | `gamma` | supply test data when available |
| `CNT_FRICTION_ABOVE_CAP` | fail | μ above 0.2 (clean uncoated metal) / 0.1 (other) without a test record | `friction.mu` | use the cap or a test-substantiated value |
| `CNT_FACTORS_UNSET` | error | factors of safety / fitting factor not given | `factors` | ask the owner / programme for the factors |
| `CNT_MS_NEGATIVE` | fail | a joint margin < 0 | criterion | redesign; only a qualified reviewer can disposition (05) |
| `CNT_STACK_NOT_FOUND` | error | V1 stack id unknown | stack id | check `check_fastener_layout` (08) |
| `CNT_SUBSURFACE_UNVERIFIED` | warning | Hertz subsurface values returned | — | formula source not yet verified |

Reused: `NLS_*` (PHY-05), `FEA_*` (05), `VNV_NO_CONVERGENCE_STUDY` (PHY-00), `MATL_EXPORT_UNSUPPORTED` (PHY-02).

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01…05 | registry commands, unit descriptions, guide section, plans |
| AF-10/12/13 | `contact_report`, `bolted_joint_check` shapes; paged increments; deterministic |
| AF-11 | §7.1 |
| AF-20/21 | `check_contact`; pressures, areas, margins as numbers |
| AF-30/31 | 5020 rule table with sources; named defaults §5.3; no defaults for safety factors |
| AF-32/33/35/36 | `unverified` for untested nut factors / μ; `reviewRequired`; equations in `provenance`; summary |
| AF-34 | negative joint margins → 05 `dispose_margin` (human gate) |
| AF-40/41/42 | PHY-05 progress; ccx bundled; `--dry-run` |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Analytic queries | < 10 ms each |
| SSNP154-size FE (plane-strain slice, ≈ 20k nodes) | ≤ 3 min (TBD — measure) |
| Contact convergence | ≥ 90 % of the validation plans converge with `ccx_default` and documented increments (production gate) |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit | commands happy / failure / pure; deck golden text for each formulation and pretension; `hertz`, `lame`, `nasa5020` vs JSON; reader on pinned `contact1` / `friction1` / `pret1` `.dat.ref` | 10–13 (analytic), 20, 30, 40, 60–63 |
| Integration (ccx) | SSNP154 and SSNV104 plans, interference fit, friction block, pretension bar, pinned ccx decks | 10, 11, 20, 30, 50, 51 |
| Harness | PHY-00 `run_benchmarks` | all A-grade |
| Production gate | US-1 and US-3 unattended | — |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `hertz_contact`, `interference_fit`, `bolted_joint_check` (pure), codes, guide section | PHY-05 M1 types | 1.5 w |
| M2 | Contact pairs, friction, deck writer, contact reader, `contact_report`, `check_contact`, VC-10/11/20/30/50 | PHY-05 M2 | 3 w |
| M3 | Pretension (section imprint, lock), bolt forces, separation detection, VC-51 | M2, 05 face imprint | 2 w |
| M4 (V1) | `joint_from_fastener_stack`, pin-in-hole template, `joint_stiffness_from_fe`, joint margins in 05 | M3, 08 M6 stacks | 2 w |

## 11. Open questions / decisions needed

1. **Edition**: equations and defaults come from the 2012 baseline of NASA-STD-5020 (fetched). 5020B (2021, revalidated
   2026 per search) could not be opened; a human must diff the two before the rule table is frozen.
2. **Lock keyword**: confirm the ccx way to hold the pretension reference DOF after the preload step (`*BOUNDARY, FIXED`
   is the expected form; verify on `pret*` decks).
3. **08 stack access**: `joint_from_fastener_stack` needs an 08 query returning stack geometry (none is specified in 08
   §4.2 beyond `check_fastener_layout`); add `list_fastener_stacks` to 08 or extend `check_fastener_layout` data.
4. **Separation factor of safety**: the standard's Figure 1 logic flow was not readable; `factors.separation` stays an
   input until a human transcribes it.
5. **Eq. 6-6** (ultimate MS when separation precedes rupture) text was not captured in the extract; implement after a
   transcription check.
6. **Lug analysis method**: AFFDL stress manual / ESDU 91008 not verified; keep FE template only.
7. **Subsurface Hertz formulas**: fetch Johnson (1985) or an equivalent open source to lift `CNT_SUBSURFACE_UNVERIFIED`.

## 12. References

- [R1] CalculiX User's Manual and test suite — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R2] NASA-STD-5020 (2012-03-12) — NASA — https://imlive.s3.amazonaws.com/Federal%20Government/ID22733872581604231767905658536785766455/NASA-STD-5020.pdf (accessed 2026-10; sha256 ea1b5b03e9a1c00ba166715fe88c493c58a7d8ef35a44d1dbf09623acb41100a)
- [R3] code_aster SSNP154 — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnp154a.comm (accessed 2026-10)
- [R4] code_aster SSNV104 — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnv104a.comm (accessed 2026-10)
- [R6] K. L. Johnson, Contact Mechanics (1985) — not fetched
- Repo: `.dependency-cruiser.cjs`, `docs/aerospace/05-fea-cae-handoff/`, `docs/aerospace/08-materials-standards-libraries/`, `docs/physics/05-nonlinear-structural/`, `docs/physics/02-constitutive-models/`.

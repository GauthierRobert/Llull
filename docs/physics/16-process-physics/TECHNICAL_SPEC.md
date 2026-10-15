# PHY-16: Manufacturing process physics — technical specification

Gap id **PHY-16** · prefix **PRC** · status: specification · written 2026-10-15 · functional spec:
[`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit for this gap |
| ---- | ----------- | ---- | ------------------ |
| Materials (today) | `Material { name, density, color, metalness, roughness, finish? }` | `packages/core/src/model/types.ts` | No E or yield |
| Aerospace 07 FTR (baseline) | Plugin `sheetmetal` (`@mfg`, toolset `manufacturing`): `SheetMetalRule`, `SheetMetalPart` (flats + bends), `flat_pattern` (`data.bends[] { id, angleDeg, insideRadius, direction, ba, bd, ossb, kFactor }`), `sheet_metal_calc`, `check_sheet_metal` (`FTR_BEND_RADIUS_BELOW_MIN`, `FTR_BEND_RADIUS_NO_TABLE_ROW`) | `docs/aerospace/07-sheet-metal-machined-features/TECHNICAL_SPEC.md` §3.3, §4.2, §7.2 | No springback (07 FUNCTIONAL_SPEC §4.2 out of scope) |
| Aerospace 08 MAT (baseline) | `MaterialRecord` with E, ν, Fty, … with basis / provenance / `unverified` | `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md` §3.1 | — |
| PHY-01 / PHY-02 (baseline) | `PropertyModel` (`model/propertyModel.ts`, `resolvePropertyModel` / `evaluatePropertyModel` / `tabulatePropertyModel`); `MaterialModel { model: MaterialLaw }` (`elastic_isotropic`, `j2_plasticity`, …) in `ConstitutiveSet`s; `add_material_model` | `docs/physics/01-property-models/`, `docs/physics/02-constitutive-models/` TECHNICAL_SPEC §3 | — |
| Aerospace 05 / PHY-05 / PHY-06 (baseline) | Meshing, ccx, `nonlinear_static` with steps and probes, contact pairs, `*MODEL CHANGE` for contact pairs | respective TECHNICAL_SPECs | No element activation by layer, no inherent strain, no forming tools |
| Kernel (today) | `GeometryKernel.topology` faces `{ index, surface, area }`; 01 KRN adds `faceQuery?.faceDetails` (centroid, normal) | `packages/core/src/geometry/kernel.ts`; aerospace 01 TECHNICAL_SPEC §5.9 | Face normals needed for overhang come from 01 KRN or tessellation |

A grep of `packages/` for `springback`, `inherent strain` and `overhang` finds nothing.

**CalculiX capabilities relied on** (manual at commit `fd588701…` [R1]):

- `*MODEL CHANGE, TYPE=ELEMENT, ADD[=STRAIN FREE | WITH STRAIN] | REMOVE` — activate / deactivate elements per step; STRAIN
  FREE (default) adds elements with artificial initial strains so their stress is zero at activation; 1D/2D expanded elements
  cannot be removed in the first step (dummy first step). `TYPE=CONTACT PAIR, ADD | REMOVE`. `MECHSTRAINTORESIDUAL` turns the
  mechanical strain of the last step into residual strain.
- `*EXPANSION, TYPE=ISO | ORTHO | ANISO, ZERO=` — thermal strain α(T)(T − T_ref) − α(T0)(T0 − T_ref): used as the
  inherent-strain carrier with α = ε* and a unit temperature increment (thermal analogy).
- `*INITIAL CONDITIONS, TYPE=STRESS | PLASTIC STRAIN | TEMPERATURE` — initial residual stress for machining distortion.
- `*ORIENTATION` for build-direction-aligned orthotropic expansion (keyword in the manual; exact use verified in VC-PRC-31).

## 2. Target architecture

```
packages/core/src/model/analysis.ts   (05) AnalysisType += 'forming_springback' | 'am_build_distortion' (V1)
                                           | 'machining_distortion' (V2); ProcessSettings types (§3)
packages/domain-physics/src/process/   (@phys; placement Proposal A of PHY-05 §2.1 / PHY-03 §2.1, pending README §5.1)
   forming/  CadPlugin 'process_forming', toolset 'manufacturing':
             springback_calc, springback_compensation, check_process
   am/       CadPlugin 'process_am', toolset 'analysis':
             am_build_setup, set_inherent_strain, add_release_step, check_am_overhang, process_report,
             am_calibrate_inherent_strain (V1), set_initial_residual_stress (V2)
             extension.ts  AnalysisTypeExtension for 'am_build_distortion' / 'machining_distortion' (layer sets,
                           *MODEL CHANGE steps, *EXPANSION carrier, release steps)
   forming/extension.ts  AnalysisTypeExtension for 'forming_springback' (reuses PHY-05 steps, PHY-06 contact)
   lib/      springback.ts, layeredBeam.ts, overhang.ts   (pure; identical to validation/generate_prc_reference.py)
```

Placement follows the shared proposal (core analysis extension port; fallback: disciplines inside the 05 FEA package),
**pending README §5.1**. Reading 07 data never imports `@mfg` (L10, `.dependency-cruiser.cjs`
`plugins-and-kernels-depend-on-core-only`): `springback_compensation` composes 07 `flat_pattern` through `execute`
(`ctx.registry`), and `check_process` relays 07 `check_sheet_metal` findings the same way. Writing a compensated flat
pattern (V2) also goes through 07 commands via `execute`, as a new feature step.

**Laws respected:** L1 (queries + analysis set-up commands; solves through 05 transports), L2, L3, L4, L5, L8 (layer sets
derived from mesh + build data on replay, not stored element lists), L9 (overhang reads face normals via `ctx.kernel`,
`requiresKernel`), L10.

### 2.1 Technical requirements

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-PRC-01 | MUST | `springback.ts` implements §5.1 exactly (both the moment-curvature path and the closed form, asserted equal to 1e-12 in tests). |
| TR-PRC-02 | MUST | Material inputs resolved from the 08 record (`E`, `nu`, yield = the property named by the caller, e.g. `Fty` or a PHY-01 `PropertyModel` evaluated at the forming temperature) or given explicitly as `{ value, unit, source }`; the resolved values and their provenance are echoed. |
| TR-PRC-03 | MUST | `springback_compensation` reads bends only through `execute(doc, 'flat_pattern', { id })` and keys results by 07 bend id; a missing 07 plugin ⇒ `PRC_SHEET_METAL_UNAVAILABLE`. |
| TR-PRC-10 | MUST | Compensation solves R_i by bisection on the monotone map R_i → R_f (300 iterations, relative bracket 1e-15), angle by arc-length conservation. |
| TR-PRC-20 | SHOULD (V1) | Layer sets: elements are assigned to layer k when their centroid height h (along the build direction, from the plate top) satisfies (k − 1)·t_L ≤ h < k·t_L; empty layers are skipped and reported. Layer steps: `*MODEL CHANGE, TYPE=ELEMENT, ADD=STRAIN FREE` of layer k, then a temperature increment of 1 on layer k's nodes only… see §5.3 for the carrier choice and its open question. |
| TR-PRC-21 | SHOULD (V1) | Before step 1, all layers are removed (`*MODEL CHANGE, REMOVE`) in a dummy step (manual restriction for expanded elements). |
| TR-PRC-22 | SHOULD (V1) | Release steps remove the plate and / or support element sets; the plate's bottom constraint is replaced by a minimal statically determinate support on the part (3-2-1, named nodes) so the released part is not singular. |
| TR-PRC-30 | MUST | `overhang.ts`: downskin angle per tessellated facet α = 90° − ∠(n, −b) for facets with n·b < 0 (b = build direction, unit), aggregated per B-rep face (area-weighted min, max, mean); bands configurable; facets with n·b ≥ 0 are not downskin. |
| TR-PRC-40 | MUST | Agent contract (AF-10/11/31–36) on every query. |

## 3. Data model

```ts
// core model/analysis.ts additions owned by PHY-16
export type AnalysisType = /* 05, PHY-03, PHY-05, … */ | 'forming_springback' | 'am_build_distortion' | 'machining_distortion';

export interface FormingSettings {                       // 'forming_springback' (V1); uses PHY-05 NonlinearSettings for steps
  mode: 'end_rotation' | 'tools';
  endRotation?: { readonly fixedTarget: FeaTarget; readonly rotatedTarget: FeaTarget; readonly angleDeg: number };
  tools?: { readonly punchEntityId: EntityId; readonly dieEntityId: EntityId; readonly rigid: boolean;
            readonly strokeTarget: FeaTarget; readonly stroke: number };       // contact via PHY-06 pairs
  measure: { readonly points: readonly Vec3[] };          // ≥ 3 points on each leg to fit angle / radius after release
}

export interface AmBuildSettings {                       // 'am_build_distortion' (V1)
  buildDirection: Vec3;                                    // unit vector in document axes
  plateEntityId: EntityId; supportEntityIds: readonly EntityId[];
  layerHeight: number;                                     // lumped layer, analysis length unit (no default)
  inherentStrain: { readonly exx: number; readonly eyy: number; readonly ezz: number;   // build frame, z = build direction
                    readonly source: string; readonly calibrated: boolean };           // AF-31/32
  releaseSteps: readonly { readonly name: string; readonly remove: readonly ('plate' | 'supports')[] }[];
  probes: readonly { readonly name: string; readonly point: Vec3; readonly dof: 'ux' | 'uy' | 'uz' | 'magnitude' }[];
  results?: AmResultsSummary;
}
export interface AmResultsSummary {
  readonly resultsHash: string; readonly inputHash: string;
  readonly layers: number; readonly emptyLayers: readonly number[];
  readonly perStep: readonly { step: string; probe: string; value: number }[];
  readonly maxDistortion: { value: number; at: Vec3; step: string };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
}

export interface MachiningDistortionSettings {           // V2
  initialStress: { readonly kind: 'uniform'; readonly sigma: readonly [number, number, number, number, number, number] }
               | { readonly kind: 'through_thickness'; readonly direction: Vec3;
                   readonly table: readonly { depth: number; sigma: readonly [number, number, number, number, number, number] }[] };
  stockEntityId: EntityId; finishedEntityId: EntityId;     // removed region = stock − finished (boolean, derived)
  stressSource: string;
}

// Query result (springback_calc / compensation rows)
export interface SpringbackRow {
  readonly bendId?: string;
  readonly thickness: number; readonly insideRadius: number; readonly angleDeg: number;
  readonly u: number; readonly regime: 'plastic' | 'elastic';
  readonly formedRadius: number | null; readonly formedAngleDeg: number | null; readonly springbackDeg: number | null;
  readonly toolRadius?: number; readonly toolAngleDeg?: number; readonly overbendDeg?: number;
  readonly inputs: { E: Named; Y: Named; nu?: Named; stressState: 'uniaxial' | 'plane_strain' };
  readonly method: 'elastic_perfectly_plastic_pure_bending';
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
}
type Named = { readonly value: number; readonly unit: string; readonly source: string; readonly defaulted: boolean };
```

Document version: settings ride the 05 `analysis` slice (aerospace v3 envelope); no migration.

## 4. Commands

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `springback_calc` | Q (`manufacturing`) | `{ inputs: { thickness_mm, insideRadius_mm, angle_deg, E: {value, unit, source}, yield: {value, unit, source}, nu?, stressState: 'uniaxial' \| 'plane_strain' } \| { …, material: { recordId, yieldProperty } } }` | → `SpringbackRow`; @invariant pure; @failure missing E / Y / source → `PRC_MATERIAL_INPUT_MISSING`; plane strain without ν → `PRC_POISSON_MISSING`; T, R ≤ 0, angle ∉ (0, 180] → `PRC_GEOMETRY_INVALID` |
| `springback_compensation` | Q (`manufacturing`) | `{ id?: sheet part id, targets?: [{ formedRadius_mm, formedAngle_deg }], material, stressState, nu? }` | → rows keyed by bend id (via 07 `flat_pattern`) or by target; @failure no bends → `PRC_NO_BENDS`; target unreachable (needs u ≥ 1/2) → `PRC_BEND_ELASTIC` per row |
| `check_process` | Q (`manufacturing`) | `{ id, material, stressState }` | → findings: `PRC_BEND_ELASTIC`, `PRC_SPRINGBACK_LARGE` (threshold explicit or warning `PRC_THRESHOLD_UNSET`), relayed `FTR_BEND_RADIUS_BELOW_MIN` / `FTR_BEND_RADIUS_NO_TABLE_ROW` (07 `check_sheet_metal` via `execute`), `PRC_MATERIAL_UNVERIFIED` |
| `am_build_setup` | M (V1, `analysis`) | `{ analysisId, buildDirection, plateEntityId, supportEntityIds?, layerHeight, probes? }` | @affects case.am · @invariant case type `am_build_distortion`; buildDirection unit; layerHeight > 0 explicit · @failure → `PRC_BUILD_SETUP_INVALID` |
| `set_inherent_strain` | M (V1) | `{ analysisId, exx, eyy, ezz, source, calibrated }` | @invariant source mandatory (AF-31) · @failure missing source → `PRC_INHERENT_STRAIN_SOURCE_MISSING` |
| `add_release_step` | M (V1) | `{ analysisId, name, remove: ('plate' \| 'supports')[], support321: { points: [Vec3, Vec3, Vec3] } }` | @failure release without determinate support → `PRC_RELEASE_UNSUPPORTED` |
| `process_report` | Q (V1) | `{ analysisId }` | → per-layer and per-release-step probe values, max distortion, curvature fit for beam-like parts, `unverified`, `reviewRequired` |
| `am_calibrate_inherent_strain` | Q (V1) | `{ analysisId (coupon case), measured: { probe, value, unit, source }, fit: 'scalar' \| 'orthotropic_xy' , bounds }` | → fitted ε* (secant iteration over solves through the 05 transport; host-side loop) + residual; result can be stored with `set_inherent_strain` and on the 08 record as a PHY-01 property (agent's choice, explicit) |
| `check_am_overhang` | Q (`analysis`, `requiresKernel`) | `{ id, buildDirection, bandsDeg?: number[] (named default [0, 15, 30, 45, 60, 90] as reporting bands only), threshold?: { downskinDeg, source } }` | → per face: min / max / mean downskin angle, area; area per band; faces below threshold · @failure no threshold → result plus `PRC_OVERHANG_THRESHOLD_UNSET` (warning) |
| `set_initial_residual_stress` | M (V2) | `MachiningDistortionSettings` | @invariant stressSource mandatory |
| (05) ✱ `fea_mesh` / `fea_solve` | transport | unchanged | layer sets built in the deck section, not in the mesh |

Descriptions follow AF-02, e.g. `springback_calc`: "Predicts the formed radius and angle of a sheet bend after the tool is
removed, for an elastic-perfectly plastic sheet in pure bending (no hardening, no thinning). Lengths in mm, angle bent
through in degrees, E and yield with units and a source (or an 08 record). Refuses missing material data; returns
regime=elastic when the bend never yields. Next: springback_compensation for tool values, or the FE route for hardening
materials."

## 5. Algorithms

### 5.1 Springback (identical to the generator)

```
k_i = 1/R_i,  k_y = 2Y/(E T)                     (uniaxial; plane strain: E' = E/(1-ν²), Y' = 2Y/√3)
if k_i ≤ k_y: regime = elastic, R_f = ∞ (PRC_BEND_ELASTIC)
M = (Y T²/6) · 1.5 · (1 − (k_y/k_i)²/3)          per unit width
Δk = M / (E T³/12);  k_f = k_i − Δk;  R_f = 1/k_f
closed form: u = R_i Y/(E T);  R_i/R_f = 4u³ − 3u + 1  (u < 1/2)   — "Gardiner (1957)" form, re-derived
θ_f = θ_i (R_i + T/2)/(R_f + T/2);  springback = θ_i − θ_f
compensation: bisection R_i ∈ (1e-6 T, R_f,target) with R_f(R_i) monotone; θ_i = θ_f (R_f + T/2)/(R_i + T/2)
```

Test-material reproduction (E 72 GPa, Y 300 MPa, T 1.6 mm — test inputs): R_i 4.8 → R_f 4.98697 mm, 90° → 87.092°;
compensation for R_f 4.8 / 90° → tool 4.62654 mm / 92.877°.

### 5.2 FE springback (V1)

Two PHY-05 steps: `form` (displacement control: end rotation of a plane-strain strip, or punch stroke with PHY-06 contact)
and `release` (rotation released by removing the prescribed DOF — ccx: new step with `*BOUNDARY, OP=NEW` keeping only the
fixed end — or tool contact removed by `*MODEL CHANGE, TYPE=CONTACT PAIR, REMOVE`). NLGEOM on. Formed radius and angle fitted
from the measure points (least-squares circle and line fits, pure TS). The pure-bending variant is compared with the
plane-strain closed form (VC-PRC-11).

### 5.3 Inherent strain, layer by layer (V1)

```
step 0 (dummy):  *MODEL CHANGE, TYPE=ELEMENT, REMOVE  all layer sets L1..Ln (and supports, if built with the part)
                 *INITIAL CONDITIONS, TYPE=TEMPERATURE  all nodes 0
for k in 1..n:   *STEP  *STATIC
                 *MODEL CHANGE, TYPE=ELEMENT, ADD=STRAIN FREE   L_k
                 *TEMPERATURE   nodes of L_k → 1 (nodes shared with L_{k−1} keep 1 already)
release steps:   *MODEL CHANGE, TYPE=ELEMENT, REMOVE  plate / supports;  *BOUNDARY OP=NEW  3-2-1 nodes
material:        *EXPANSION, TYPE=ORTHO (α1, α2, α3) = (εxx, εyy, εzz) with *ORIENTATION aligned to the build frame
```

Carrier caveat (open question §11 q2): with nodal temperatures, nodes shared between layer k − 1 and k receive T = 1 when
layer k is added, so the top face of layer k − 1 already carries inherent strain before k exists; with T = 1 applied at
activation of each layer this is the same final state for uniform ε*, but the per-layer history differs by one layer.
Alternatives are element-wise initial strain (`*INITIAL CONDITIONS, TYPE=PLASTIC STRAIN` on the new layer, or
`MECHSTRAINTORESIDUAL`). The deck test VC-PRC-31 decides; the generator models the ideal (element-wise) case.

Analytic check (beam theory, generator): substrate 4 mm, 10 layers × 0.2 mm, E 200 GPa, ε* = −0.002 (test inputs), ν = 0
in the FE comparison. Curvature after layer 1 −1.29576e-4 /mm (equals the Timoshenko bimetal form), after 10 layers
−9.20109e-4 /mm, all at once −4.44444e-4 /mm (ratio 2.07), substrate removal adds −1.11217e-3 /mm.

### 5.4 Overhang (MVP)

Facet normals from `ctx.kernel.tessellate` (exact face normals from 01 KRN `faceDetails` when available); α = 90° −
∠(n, −b) for facets with n·b < 0; per B-rep face, area-weighted statistics; areas per band; the threshold comparison is
done only with an explicit `threshold` (no default — machine / material rules differ; the DfAM standard is paywalled).

### 5.5 Tolerances

| Item | Value |
| ---- | ----- |
| Analytic vs generator | 1e-9 relative |
| FE springback vs closed form (pure bending, plane strain) | 5 % on R_f (VC-PRC-11) |
| Layered beam FE vs beam theory (ν = 0) | 3 % (VC-PRC-30) |
| Overhang angles | 1e-6° on planar faces |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| Compensation table | out | JSON / CSV via `--save`; 07 sheet table column extension (V1) |
| CalculiX INP (forming, AM, machining sections) | out | extension deck sections (pure) |
| AM build data (layer height, direction) | in | plan params; no external build-file import in scope (3MF / slice files: open question q5) |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands; `llull guide` gains a process section (springback assumptions, compensation, inherent strain
  needs calibration, overhang threshold must come from a rule).
- **MCP**: sheet queries in toolset `manufacturing` (07), AM and FE in `analysis` (05); each tool in exactly one toolset.
- **UI (review)**: 07 bend table columns; AM per-layer slider and distortion overlay; overhang map.

### 7.1 Stable codes (AF-11)

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `PRC_MATERIAL_INPUT_MISSING` | error | E or yield missing or without source | param path | give values with a source or an 08 record with E and the yield property |
| `PRC_POISSON_MISSING` | error | plane strain without ν | `nu` | give ν |
| `PRC_GEOMETRY_INVALID` | error | T or R ≤ 0, angle ∉ (0, 180] | param path | fix the geometry |
| `PRC_BEND_ELASTIC` | warning | R_i ≥ E T/(2Y): bend does not yield | bend id | smaller radius or accept full springback |
| `PRC_SPRINGBACK_LARGE` | warning | springback above the explicit threshold | bend id | consider FE route / coining |
| `PRC_THRESHOLD_UNSET` | warning | no springback threshold given | — | give a company rule |
| `PRC_MATERIAL_UNVERIFIED` | warning (not suppressible) | 08 values `unverified` | record id, property | use sourced values |
| `PRC_NO_BENDS` | error | sheet part without bends / not a sheet part | id | — |
| `PRC_SHEET_METAL_UNAVAILABLE` | error | 07 plugin not installed | — | install the sheet-metal plugin |
| `PRC_BUILD_SETUP_INVALID` | error | build direction not unit, layer height ≤ 0, plate missing | param path | fix the set-up |
| `PRC_LAYER_MESH_MISMATCH` | warning | empty layers (mesh coarser than layer height) | layer indices | refine in build direction or lump layers |
| `PRC_INHERENT_STRAIN_SOURCE_MISSING` | error | `set_inherent_strain` without source | — | cite calibration or owner data |
| `PRC_INHERENT_STRAIN_UNCALIBRATED` | warning | `calibrated: false` | analysis id | run `am_calibrate_inherent_strain` |
| `PRC_RELEASE_UNSUPPORTED` | error | release step without determinate support | step | give 3-2-1 points |
| `PRC_OVERHANG_THRESHOLD_UNSET` | warning | no threshold for `check_am_overhang` | — | give the machine / company rule with source |
| `PRC_OVERHANG_BELOW_THRESHOLD` | fail | faces below the threshold without support | face ids, area | add supports or re-orient |

Relayed: 07 `FTR_BEND_RADIUS_BELOW_MIN`, `FTR_BEND_RADIUS_NO_TABLE_ROW`; PHY-05 `NLS_*`; PHY-06 `CNT_*`; 05 `FEA_*`.

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01…05 | registry commands with units; guide section; plans |
| AF-10/12/13 | `SpringbackRow`, `process_report`, overhang data; deterministic |
| AF-11 | §7.1 |
| AF-20/21 | `check_process`, `check_am_overhang`; angles and areas as numbers, colour map optional |
| AF-30/31 | 07 radius table relayed; no defaults for material, inherent strain, threshold |
| AF-32/33/35/36 | `unverified`; `reviewRequired`; method + formula in `provenance`; summary |
| AF-34 | release of compensation data via 09 PLM approval |
| AF-40/41/42 | 05 transports; `--dry-run` |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| `springback_compensation`, 50 bends | < 50 ms (pure) plus the 07 `flat_pattern` time |
| `check_am_overhang`, 200k facets | < 500 ms |
| AM build, 200 lumped layers, 100k nodes | TBD — measure (one ccx step per layer; production gate) |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit | `springback.ts` (both paths), compensation, `layeredBeam.ts`, `overhang.ts` on hand-built facets; command happy / failure / pure; codes | 10, 20, 30 (analytic), 50–54 |
| Integration (ccx) | pure-bending strip springback; layered beam with `*MODEL CHANGE`; carrier decision test | 11, 30, 31 |
| Harness | PHY-00 `run_benchmarks` | A-grade |
| Optional | AM-Bench AMB2018-01 reproduction after the data release is read | 40 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `springback_calc`, `springback_compensation`, `check_process` (07 relay), codes, guide | 07 M3 (`flat_pattern`), 08 M2 | 1.5 w |
| M2 | `check_am_overhang` | 01 KRN face details or tessellation | 1 w |
| M3 (V1) | FE springback (end rotation, then tools) | PHY-05 M2, PHY-06 M2 | 2 w |
| M4 (V1) | AM inherent strain build + release + `process_report` + calibration helper | PHY-05 M2, 05 transports | 3 w |
| V2 | hardening springback, compensated flat pattern via 07, machining distortion | PHY-02 V1 | — |

## 11. Open questions / decisions needed

1. **Placement** — shared proposal (core analysis extension port; fallback inside the 05 FEA package), pending README §5.1;
   two plugins (`process_forming` in `manufacturing`, `process_am` in `analysis`) because a plugin has one toolset.
2. **Inherent-strain carrier** (§5.3): nodal temperature vs element-wise initial strain; decided by VC-PRC-31.
3. **Gardiner (1957)** original not fetched; the formula is derived independently — confirm the citation wording.
4. **AM-Bench** data release (per-ridge deflections, geometry, process) must be read before VC-PRC-40 becomes a gate;
   licence of the data for redistribution in fixtures to check.
5. **Build-file import** (3MF build items, slice files) — out of scope unless requested.
6. **Yield property for forming**: forming uses the annealed / W temper yield, not the final temper; which 08 property key
   and temper the agent must use is a process-owner rule to capture as data.

## 12. References

- [R1] CalculiX User's Manual — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R2] Aerospace 07 FTR — `docs/aerospace/07-sheet-metal-machined-features/TECHNICAL_SPEC.md`
- [R3] Gardiner 1957 (citation via search) — re-derived in `validation/generate_prc_reference.py`
- [R4] Modified inherent strain method (OSU seminar abstract, search) — https://mae.osu.edu/events/2021/03/modified-inherent-strain-method-predicting-residual-distortion-and-stress-laser
- [R5] NIST AM-Bench 2018 — https://www.nist.gov/node/1339701 (search); https://github.com/usnistgov/ambench (git, commit 77adb06c…)
- [R6] ISO/ASTM 52911-1 — catalogue search https://www.iso.org/search.html?q=52911-1 (not fetched)
- Repo: `.dependency-cruiser.cjs`, physics PHY-01/02/03/05/06 specs, aerospace 05/07/08 specs.

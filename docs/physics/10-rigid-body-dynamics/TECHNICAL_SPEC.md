# PHY-10: Rigid-body dynamics with forces — technical specification

Gap id **RBD** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull (read in code, 2026-10-15)

| Area | What exists | Path | Limit for dynamics |
| ---- | ----------- | ---- | ------------------ |
| Joint model | `Joint = (JointBase<'revolute'> & { angle }) \| (JointBase<'prismatic'> & { displacement })`; `JointBase { id, kind, a: JointMateRef, b: JointMateRef, axis: 'x'\|'y'\|'z'\|Vec3 }`; `JointMateRef { instanceId, frame?: 'origin'\|'axis-x'\|'axis-y'\|'axis-z' }`; doc keeps `joints` + `jointOrder` | `packages/core/src/model/types.ts` (≈ lines 547–567, 621–622) | Two kinds only; no pivot point; `axis` is world-space |
| Joint commands | `add_joint` (anchor `a`, moving `b`, both `InstanceEntity`), `delete_joint` (cascades drive relations), `set_joint_value` (radians / document units, expressions resolved via `resolveNumeric`) | `commands/motion/jointsEdit.ts` | — |
| Drive relations | `add_drive_relation` driven = driver × ratio + offset, acyclic (`detectCycleOnAdd`), `delete_drive_relation` | `commands/motion/jointsDrive.ts` | Kinematic coupling only |
| Kinematic evaluation | `evaluateMotionInternal(doc, overrides)`: (1) joint values, (2) drive relations in topological order, (3) per joint in `Object.values(doc.joints)` order: revolute rotates b's position about **a's stored position** (Rodrigues) and sets b's Euler rotation to `bRot + axis × value`; prismatic sets b's position to **a's position + axis × value** | `commands/motion/jointsKinematics.ts` | (i) the pivot is the anchor instance origin, the `frame` selector is never read (grep: no use in `motion/`); (ii) chains do not propagate: the pivot uses `instanceA.position` from the document, not the updated pose; (iii) rotations compose by adding Euler angles, correct only for a single rotation about one axis from zero; (iv) prismatic overwrites b's offset from a; (v) no loop closure |
| Queries | `evaluate_motion` (read-only, `metaHistory`), `motion_study` (sweep of one joint or parameter, steps clamped to [2, 360], optional AABB interference), `bake_motion` (writes poses) | `commands/motion/jointsDrive.ts`, `motionStudy.ts` | No time, mass or force |
| Animation | `animate` clips, "No physics; the viewport player evaluates these per-frame as a render overlay" | `commands/motion/animation.ts` | Presentation |
| Assemblies | `create_component` (entities → component + instance at origin), `insert_instance` (position, Euler XYZ rotation in radians, scale), `explode_instance`, `bill_of_materials` | `commands/assembly/assemblies.ts`, `billOfMaterials.ts` | — |
| Mass properties | `mass_properties`: volume and mass (g); density g/(doc unit)³ from the entity's material, else the `density` param; instances summed recursively with per-part materials. **No centroid, no inertia** | `commands/inspect/measureSolid.ts` | Inertia comes with aerospace 01 KRN TR-KRN-40 (`massProperties` kernel method: centroid, inertia at centroid / origin, principal axes) |
| Material | `Material { name, density, color, metalness, roughness, finish? }`, density > 0 | `model/types.ts` | Density only; friction coefficients are not material data here (they are pair data, §3) |
| MCP | Motion commands are in toolset `assembly` | `packages/mcp/src/toolsets.ts` | Plugin commands join a plugin toolset |

Conclusion: PHY-10 must build its own dynamic topology from instances and joints, add joint geometry (pivot), and
leave the kinematic evaluator unchanged (FR-RBD-20). Fixing the kinematic limits (ii)–(iv) is a separate core
bug-fix item reported to the core owner (open question 2), not part of this pack.

## 2. Target architecture

```
src/ui  (study playback, reaction plots)                      server/  (CLI/MCP host; caches study results by hash)
        │ dispatch                                                    │
        ▼                                                             ▼
src/app installDefaultPlugins() + physicsMechanismPlugin
        ▼
packages/domain-physics/src/mechanism   (@phys/mechanism)   CadPlugin "physics-mechanism", toolset "analysis"
   commands/: set_body_properties, set_ground, set_gravity, set_mechanism_mode, set_joint_geometry,
              add_spring_damper, add_applied_load, add_joint_actuator, set_joint_friction, set_initial_conditions,
              delete_force_element, save_dynamics_study, dynamics_study, check_mechanism, mechanism_quick_check,
              export_joint_loads, export_joint_load_history (V1), bake_dynamics_frame (V1)
   engine/:   topology.ts (bodies, joints → constraint set), constraints/{revolute,prismatic,fixed,spherical,actuator}.ts,
              assembly.ts (consistent initial state), genalpha.ts (index-3 generalised-α), friction.ts (stick-slip),
              reactions.ts, redundancy.ts (rank-revealing QR), energy.ts, linalg.ts (dense + sparse LDLᵀ/LU, deterministic)
   quick/:    pendulum.ts, sliderCrank.ts, smd.ts, coulomb.ts
        ▼ (public core API: model, lib, commands/{schema,types,noop,registry}; @cae public types for exports)
packages/core  joints / instances / materials (read)   ·   ctx.kernel.massProperties (01 KRN) for geometry masses
```

Laws respected:

- **L1/L5.** Every change is a command; `dynamics_study` is a pure read-only query (same document back, `data`).
  Exports are mutating commands that re-run the deterministic study (or take it from the host's content-hash cache,
  which is an optimisation, never a source of truth).
- **L2.** No DOM, process or file access in the engine; heavy outputs are written by the CLI `--save` path.
- **L3.** Pure; `is pure` tests on every command.
- **L4.** The mechanism slice `CadDocument.physics.mechanism` is the only dynamic state; results are not stored in
  the document (they are recomputable), except the provenance stamped into exported 05 loads.
- **L7.** 2D sketches play no role; planar mode is a dynamic setting, not a 2D model.
- **L8.** Commands record `FeatureStep`s; ids step-scoped (`fe-<step>.<k>` for force elements); a saved study is
  identified by name and by `studyHash` = sha256(canonical study inputs + engine version).
- **L9.** Geometry masses read `ctx.kernel.massProperties` only (`requiresKernel: true` on `dynamics_study` and
  `check_mechanism` when any body uses `mass: 'geometry'`; explicit masses need no kernel).
- **L10.** Plugin `packages/domain-physics/src/mechanism` (README §6.2 proposal).

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-RBD-01 | MUST | Plugin `{ name: 'physics-mechanism', toolset: 'analysis', commands, document }`; `document.validate` / `restore` handle `physics.mechanism`; a deleted instance or joint referenced by mechanism data makes the reference `unresolved` (reported by `check_mechanism`), never a crash. |
| TR-RBD-02 | MUST | Joint geometry overlay `set_joint_geometry { jointId, pivotMm, axis? }` until core gains a `pivot` field (open question 1). Without it, the pivot defaults to the anchor instance origin **and** `check_mechanism` warns `RBD_PIVOT_DEFAULTED` (AF-31). |
| TR-RBD-10 | MUST | Body mass resolution: explicit `{ massKg, centroidMm, inertiaKgM2 }` (about the centroid, world axes at the instance's current pose) or `geometry` via 01 KRN `massProperties` with per-part densities converted from g/(doc unit)³ to kg/m³ (density from the 08 record through the PHY-01 API `resolvePropertyModel(record, { property: 'density' })` + `evaluatePropertyModel` at the study temperature, default the record's reference condition, named; `Material.density` only when the material has no record; the evaluation's `unverified` propagates); zero-mass bodies allowed only when the rank test of §5.6 shows the mechanism is kinematically determined. |
| TR-RBD-11 | MUST | Force elements (§3) evaluated in SI; joint spring-dampers act on the joint coordinate; translational springs act along the current line between the two points (force zero when length < 1e-12 m, with `RBD_SPRING_DEGENERATE` event). |
| TR-RBD-20 | MUST | Coordinates: absolute (Cartesian) — spatial: position r ∈ ℝ³ + unit quaternion p ∈ ℝ⁴ per body with the normalisation constraint pᵀp − 1 = 0; planar: (x, z, θ) per body. Joints contribute holonomic constraints Φ(q, t) = 0 (§5.2). |
| TR-RBD-21 | MUST | Integrator: generalised-α for index-3 systems after Arnold & Brüls [R5] (§5.3), fixed step h, Newton with tolerance 1e-10 on the scaled residual, ≤ 20 iterations, then `RBD_NEWTON_FAILED` at that time. ρ∞ ∈ [0, 1], default 0.9 named. |
| TR-RBD-22 | MUST | Consistent initial state (§5.4): Newton projection of the given pose and joint values onto Φ = 0, velocities onto Φ_q v = −Φ_t, and initial accelerations and multipliers from the index-1 system. Residual > 1e-9 m after projection ⇒ `RBD_INITIAL_INCONSISTENT`. |
| TR-RBD-23 | MUST | Output `constraintResidualM` = max over output steps of the position-constraint norm (translational rows, m) and `constraintResidualRad` (rotational rows); gate 1e-9 m (named). |
| TR-RBD-24 | MUST | Determinism: fixed iteration order (bodies by `order`, joints by `jointOrder`, force elements by creation), no `Math.random`, no parallel reductions, dense pivoting with a stable tie rule (lowest index), numbers serialised with `Number.prototype.toString` after rounding to 12 significant digits in `data`. |
| TR-RBD-30 | MUST | Joint reactions from multipliers: (F, M) on body b = −(Φ_q,bᵀ λ_joint) mapped to the joint frame at the pivot (§5.5); components in redundant directions are reported `indeterminate: true`. |
| TR-RBD-31 | MUST | Actuator efforts: the multiplier of the prescribed-motion constraint (position / velocity mode) or the input (force mode), in N or N·m. |
| TR-RBD-40 | MUST | Coulomb friction with stick-slip by constraint switching (§5.7): slip ⇒ friction force −F_c sign(v) − c v; stick ⇒ extra constraint v_joint = 0 while \|λ_stick\| ≤ F_s = staticFactor × F_c; events at transitions located by bisection on the step to 1e-9 s. |
| TR-RBD-41 | MUST | No smoothing of the sign function in the default law (a smoothed law is optional, named `regularised`, and flagged in `data.provenance`). |
| TR-RBD-50 | MUST | `check_mechanism` items (§7.1) computed from the same topology and Jacobian as the study. |
| TR-RBD-60 | MUST | `export_joint_loads` creates 05 `FeaLoad`s (force + moment, `referencePoint` at the pivot, distributing coupling to the given 05 targets on the part, `category: 'limit'`) with `provenance: { studyName, studyHash, timeS, jointId, frame, engineVersion }`; `export_joint_load_history` (V1) writes a PHY-09 `LoadHistory` (`physics.dynamics.histories`) with `source.fromPhy10 = { studyHash, jointId, component }`. Both refuse when the re-computed `studyHash` differs from the one named (`RBD_STUDY_STALE`). |
| TR-RBD-70 | MUST | Budgets (§8) checked before integration; refusal `RBD_BUDGET_EXCEEDED`. |
| TR-RBD-80 | MUST | Agent-first result contract: unit-suffixed fields, `provenance`, `unverified`, `reviewRequired`, codes §7.1. |

## 3. Data model

```ts
// packages/domain-physics/src/mechanism/model.ts  (plugin types; core references none)
import type { Vec3 } from '@core/model/types';

export interface SourceNote { readonly citation: string; readonly grade?: 'A' | 'B' | 'C'; readonly unverified?: boolean }
type Mat3 = readonly [Vec3, Vec3, Vec3];

export type BodyMass =
  | 'geometry'                                                    // 01 KRN massProperties + material densities
  | { readonly massKg: number; readonly centroidMm: Vec3; readonly inertiaKgM2: Mat3 };   // about centroid, world axes at current pose

export interface BodySpec { readonly instanceId: string; readonly mass: BodyMass; readonly source?: SourceNote }

export interface JointGeometry { readonly jointId: string; readonly pivotMm: Vec3; readonly axis?: 'x' | 'y' | 'z' | Vec3 }

export type Profile =
  | { readonly kind: 'constant'; readonly value: number }
  | { readonly kind: 'ramp'; readonly from: number; readonly to: number; readonly t0S: number; readonly t1S: number }  // smoothstep-free linear ramp, C0
  | { readonly kind: 'sine'; readonly amplitude: number; readonly frequencyHz: number; readonly phaseRad?: number; readonly offset?: number }
  | { readonly kind: 'table'; readonly timeS: readonly number[]; readonly values: readonly number[] };               // linear interpolation, constant extrapolation

export type ForceElement =
  | { readonly id: string; readonly kind: 'translational_spring_damper'; readonly a: { instanceId: string; pointMm: Vec3 };
      readonly b: { instanceId: string; pointMm: Vec3 }; readonly stiffnessNPerM: number; readonly dampingNsPerM: number;
      readonly freeLengthMm?: number /* absent = initial length */; readonly preloadN?: number; readonly source?: SourceNote }
  | { readonly id: string; readonly kind: 'joint_spring_damper'; readonly jointId: string;
      readonly stiffness: number /* N/m or N*m/rad */; readonly damping: number /* N*s/m or N*m*s/rad */;
      readonly freeValue: number /* mm or rad */; readonly preload?: number; readonly source?: SourceNote }
  | { readonly id: string; readonly kind: 'applied_load'; readonly load: 'force' | 'torque'; readonly instanceId: string;
      readonly pointMm?: Vec3; readonly vector: Vec3 /* N or N*m */; readonly frame: 'world' | 'body'; readonly profile?: Profile }
  | { readonly id: string; readonly kind: 'joint_actuator'; readonly jointId: string; readonly mode: 'position' | 'velocity' | 'force';
      readonly profile: Profile /* rad|mm, rad/s|mm/s, N*m|N */ };

export interface JointFriction {
  readonly jointId: string;
  readonly coulomb: { readonly forceN?: number; readonly torqueNm?: number }      // V1: { mu, pinRadiusMm }
  readonly staticFactor: number;           // F_static = staticFactor * F_coulomb (>= 1); no default (AF-31)
  readonly viscous?: number;               // N*s/m or N*m*s/rad
  readonly law: 'switching' | 'regularised';
  readonly source: SourceNote;
}

export interface DynamicsStudyDef {
  readonly name: string;
  readonly durationS: number; readonly outputStepS: number;
  readonly integrator: { readonly method: 'generalized_alpha'; readonly rhoInf?: number; readonly stepS?: number;
                         readonly newtonTol?: number; readonly maxIterations?: number };
}

/** CadDocument.physics?.mechanism — absent until the first mechanism command. */
export interface MechanismModel {
  readonly mode: { readonly kind: 'spatial' } | { readonly kind: 'planar'; readonly planeNormal: 'x' | 'y' | 'z' };
  readonly ground: readonly string[];                         // instance ids fixed in space
  readonly gravity: Vec3;  // m/s², default [0, 0, -9.81]; [0, 0, 0] = weightless (as built: set_gravity { gravity })
  readonly bodies: Readonly<Record<string, BodySpec>>;
  readonly jointGeometry: Readonly<Record<string, JointGeometry>>;
  readonly forceElements: Readonly<Record<string, ForceElement>>; readonly forceElementOrder: readonly string[];
  readonly friction: Readonly<Record<string, JointFriction>>;
  readonly initial: { readonly jointValues: Readonly<Record<string, number>>; readonly jointRates: Readonly<Record<string, number>> };
  readonly studies: Readonly<Record<string, DynamicsStudyDef>>;
}

/** dynamics_study data (AF-10). Series only when requested (AF-12). */
export interface DynamicsStudyData {
  readonly studyHash: string; readonly engineVersion: string;
  readonly settings: { rhoInf: { value: number; defaulted: boolean }; stepS: number; newtonTol: number; mode: string };
  readonly dof: number; readonly redundantConstraints: number;
  readonly constraintResidualM: number; readonly constraintResidualRad: number;
  readonly energy: { initialJ: number; finalJ: number; nonConservativeWorkJ: number; balanceErrorJ: number };
  readonly peaks: readonly {
    quantity: 'joint_reaction' | 'actuator_effort' | 'joint_value' | 'joint_rate' | 'body_acceleration';
    id: string; component: string; value: number; unit: string; timeS: number }[];
  readonly events: readonly { timeS: number; kind: 'stick' | 'slip' | 'crossing' | 'singular' | 'spring_degenerate'; id: string; detail?: string }[];
  readonly series?: { readonly timeS: readonly number[]; readonly columns: Readonly<Record<string, { unit: string; values: readonly number[] }>> };
  readonly page?: { readonly offset: number; readonly limit: number; readonly total: number };
  readonly massProperties: readonly { instanceId: string; massKg: number; centroidMm: Vec3; source: string; unverified: boolean }[];
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean; readonly reviewReason?: string;   // true when reactions/efforts are requested or exported
  readonly provenance: { readonly formulation: 'index-3 absolute coordinates'; readonly integrator: 'generalized-alpha (Arnold & Bruls 2007)';
                         readonly frictionLaw?: string; readonly inputsHash: string };
}
```

**Document version.** `physics.mechanism` is optional and absent until used; no migration (aerospace v3 envelope).
Units stored as named in field suffixes; the engine converts doc units (`units` of the document) to SI once.

## 4. Commands

Plugin `physics-mechanism`, toolset `analysis` (open question 4). Mutating commands are idempotent per key
(re-setting a body or joint replaces it). All params state units (AF-04).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `set_body_properties` | mutating | `{ instanceId, mass: 'geometry' \| { massKg, centroidMm, inertiaKgM2 }, source? }` | @affects mechanism.bodies · @invariant instance exists; massKg ≥ 0; inertia symmetric, positive semi-definite, triangle inequalities on principal moments · @failure `RBD_INSTANCE_UNKNOWN`, `RBD_INERTIA_INVALID` |
| `set_ground` | mutating | `{ instanceIds: string[] }` | @invariant ≥ 1 existing instance · @failure `RBD_INSTANCE_UNKNOWN` |
| `set_gravity` | mutating | `{ gravity: [x, y, z] }` (m/s²; `[0, 0, 0]` = weightless) | @invariant finite · named in results |
| `set_mechanism_mode` | mutating | `{ mode: 'spatial' \| 'planar', planeNormal? }` | @invariant planar joints' axes ∥ planeNormal (revolute) or ⟂ (prismatic) · @failure `RBD_PLANAR_AXIS_MISMATCH` |
| `set_joint_geometry` | mutating | `{ jointId, pivotMm, axis? }` | @failure `RBD_JOINT_UNKNOWN` |
| `add_spring_damper` | mutating | `{ kind: 'translational', a, b, stiffnessNPerM, dampingNsPerM, freeLengthMm?, preloadN?, source? } \| { kind: 'joint', jointId, stiffness…, damping…, freeValueMm \| freeValueRad, preload? }` | @affects forceElements (id `fe-<step>.<k>`) · @invariant stiffness, damping ≥ 0 · @failure `RBD_SPRING_INVALID` |
| `add_applied_load` | mutating | `{ load: 'force' \| 'torque', instanceId, pointMm?, vector (N \| N·m), frame, profile? }` | @failure `RBD_PROFILE_INVALID` |
| `add_joint_actuator` | mutating | `{ jointId, mode: 'position' \| 'velocity' \| 'force', profile, unit }` | @invariant at most one actuator per joint; unit matches mode · @failure `RBD_ACTUATOR_CONFLICT` |
| `set_joint_friction` | mutating | `{ jointId, coulomb: { forceN \| torqueNm }, staticFactor, viscous?, law?='switching', source }` | @invariant F ≥ 0, staticFactor ≥ 1, citation non-empty · @failure `RBD_FRICTION_INVALID` |
| `set_initial_conditions` | mutating | `{ jointValues?: { [jointId]: rad \| mm }, jointRates?: { [jointId]: rad/s \| mm/s } }` | consistency checked at study time (TR-RBD-22) |
| `delete_force_element` | mutating, destructive | `{ id }` | — |
| `save_dynamics_study` | mutating | `{ name, durationS, outputStepS, integrator? }` | @invariant 0 < outputStepS ≤ durationS; stepS ≤ outputStepS and divides it within 1e-12 · @failure `RBD_STEP_INVALID` |
| `dynamics_study` | query (`readOnly`, `requiresKernel` iff geometry masses) | `{ name? \| inline def, outputs?: { bodies?, joints?, actuators?, forceElements?, series?: boolean, offset?, limit?, events? } }` → `DynamicsStudyData` | @invariant document unchanged; deterministic · @failure `RBD_GRAVITY_UNSET`, `RBD_MASS_MISSING`, `RBD_INITIAL_INCONSISTENT`, `RBD_CONSTRAINTS_INCONSISTENT`, `RBD_BUDGET_EXCEEDED`, `RBD_NEWTON_FAILED` (data up to the failure time is returned with the code) |
| `check_mechanism` | query | `{}` → `{ status, dof, redundant, items[{ code, severity, ids, message, remediation }] }` | AF-20 |
| `mechanism_quick_check` | query | `{ kind: 'pendulum' \| 'compound_pendulum' \| 'spring_mass_damper' \| 'slider_crank' \| 'coulomb_oscillator', inputs }` | pure closed forms of `generate_rbd_reference.py` |
| `export_joint_loads` | mutating | `{ study, jointIds, at: 'peak_resultant' \| { timesS: number[] }, targetAnalysisId, targets: { [jointId]: FeaTarget }, loadCasePrefix? }` | @affects 05 case loads · @invariant study re-computed, hash matches; target analysis is static · @failure `RBD_STUDY_STALE`, `RBD_TARGET_NOT_STATIC`, 05 target codes |
| `export_joint_load_history` | mutating (V1) | `{ study, jointId, component, name }` | @affects `physics.dynamics.histories` (PHY-09) |
| `bake_dynamics_frame` | mutating (V1) | `{ study, timeS }` | @affects instance position / rotation (like `bake_motion`) |

## 5. Algorithms

### 5.1 Engine choice

| Option | Licence (read in LICENSE at HEAD) | Fit for llull | Determinism | Verdict |
| ------ | --------------------------------- | ------------- | ----------- | ------- |
| **Own TS engine in `@phys`** | llull | Pure function → registry query, runs in CLI / MCP / UI / web without a host process; small mechanisms (≤ 50 bodies) | Full control (TR-RBD-24) | **MVP** |
| Project Chrono [R10] | BSD-3-Clause | C++ library with HHT / DAE solvers; would need a native or Python host process on the desktop; no official JS/WASM build found (not verified) | Not assessed | V2 cross-check transport candidate |
| MuJoCo [R11] | Apache-2.0 | C library with JS/WASM bindings listed in its README; constraints are **soft by design** (its computation chapter models soft constraints), so position-level closure and exact reactions differ from an index-3 DAE | Docs: "MuJoCo simulations are deterministic" (same integration state ⇒ same output) | Not for reactions of record; possible cross-check |
| Rapier [R12] | Apache-2.0 | Rust + JS/WASM (`@dimforge/rapier3d`), impulse-based game physics; `enhanced-determinism` cargo feature | Feature claims cross-platform determinism (not verified beyond Cargo.toml) | Not suited to load-of-record joint reactions |

### 5.2 Constraints (TR-RBD-20)

Body i: position rᵢ, rotation Aᵢ = A(pᵢ). Joint between bodies a, b with pivot point s (world, at assembly) and
axis e: body-fixed vectors s′ₐ = Aₐᵀ(s − rₐ), s′_b = A_bᵀ(s − r_b), axis e′ₐ, e′_b, and two vectors h′ₐ₁, h′ₐ₂ ⟂ e′ₐ.

```
spherical:   r_a + A_a s'_a − r_b − A_b s'_b = 0                                  (3)
revolute:    spherical + (A_a h'_a1)·(A_b e'_b) = 0, (A_a h'_a2)·(A_b e'_b) = 0     (5)
prismatic:   d = r_b + A_b s'_b − r_a − A_a s'_a;  (A_a h'_a1)·d = 0, (A_a h'_a2)·d = 0,
             3 relative-rotation locks (A_a h'_a1)·(A_b h'_b2) = 0, (A_a h'_a1)·(A_b e'_b) = 0, (A_a h'_a2)·(A_b e'_b) = 0   (5)
fixed:       spherical + 3 relative-rotation locks                                 (6)
actuator:    joint coordinate θ(q) − θ_prescribed(t) = 0 (position) or its velocity form (velocity mode, non-holonomic, index 2)
planar mode: (x, z, θ) per body; revolute = 2 equations, prismatic = 2 equations
quaternion:  p_iᵀ p_i − 1 = 0 per body (spatial)
```

Joint coordinates θ (revolute angle about e from the assembly pose, prismatic displacement along e) are computed
from the body poses for outputs, springs, friction and actuators.

### 5.3 Generalised-α for index-3 systems (TR-RBD-21)

Equations: M(q) q̈ + Φ_qᵀ λ = Q(q, q̇, t), Φ(q, t) = 0. With ρ∞ (default 0.9):
α_m = (2ρ∞ − 1)/(ρ∞ + 1), α_f = ρ∞/(ρ∞ + 1), γ = ½ + α_f − α_m, β = ¼(γ + ½)² (Chung & Hulbert [R6]).
Per step (Arnold & Brüls [R5]): unknowns q̈ₙ₊₁, λₙ₊₁ and the auxiliary acceleration aₙ₊₁:

```
(1 − α_m) a_{n+1} + α_m a_n = (1 − α_f) q̈_{n+1} + α_f q̈_n
q_{n+1} = q_n + h q̇_n + h² (½ − β) a_n + h² β a_{n+1}
q̇_{n+1} = q̇_n + h (1 − γ) a_n + h γ a_{n+1}
residual: M q̈_{n+1} + Φ_qᵀ λ_{n+1} − Q = 0,  Φ(q_{n+1}) / (β h²) = 0     (constraint row scaled by 1/(βh²) for conditioning)
Newton on (q̈_{n+1}, λ_{n+1}) with iteration matrix [M + C γ'/... ; Φ_q] (exact tangent incl. ∂(Φ_qᵀλ)/∂q, ∂Q/∂q, ∂Q/∂q̇)
```

Second order for q and λ [R5]; the position constraint holds at every step to the Newton tolerance, so there is no
drift (contrast VC-RBD-04, which shows the fine-step index-1 reproduction stays at 1.6e-13 m only because of the
small step). Baumgarte stabilisation [R7] is not used (its parameters are problem dependent); it may be offered as
a documented alternative for the index-1 quick reproduction only.

### 5.4 Consistent initial conditions (TR-RBD-22)

1. Set joint coordinates of `initial.jointValues` as targets (extra equations θ_j(q) − θ_j⁰ = 0), Newton on Φ = 0
   in least squares from the assembly pose (Gauss-Newton, damped, ≤ 50 iterations).
2. Velocities: solve Φ_q q̇ = −Φ_t with the given joint rates as extra equations (least squares, minimum norm).
3. Accelerations and multipliers: solve [M Φ_qᵀ; Φ_q 0][q̈; λ] = [Q; −(Φ_q q̇)_q q̇ − 2Φ_qt q̇ − Φ_tt].
   VC-RBD-03 checks step 3 on Andrews' squeezer (q̈ and λ of the test set to 1e-9).

### 5.5 Reactions (TR-RBD-30)

For joint j with multipliers λ_j and Jacobian blocks Φ_{j,r_b}, Φ_{j,p_b}: generalised constraint force on body b
Q_c = −Φ_{j,q_b}ᵀ λ_j; translational part = force F_b (world, N); rotational part mapped from quaternion space to a
moment about the pivot: M_b = ½ G(p_b) Q_c,p − (s − r_b) × F_b (G the quaternion velocity matrix). Reported on body b
in world axes and in the joint frame (e, h₁, h₂). Planar mode: F in the plane, M about the normal. Rows removed by
the redundancy reduction make their components `indeterminate`.

### 5.6 Mobility and redundancy (TR-RBD-50)

At the assembly pose: Φ_q (m × n). Rank r by Householder QR with column pivoting (deterministic tie-break,
tolerance 1e-10 × ‖Φ_q‖). DOF = n − r (minus actuator constraints); redundant = m − r; the dependent rows map back
to joint ids. Inconsistency: after projection, residual of the dropped rows > 1e-9 ⇒ `RBD_CONSTRAINTS_INCONSISTENT`.
Massless bodies: M singular is accepted iff [M Φ_qᵀ; Φ_q 0] is non-singular at t₀ (rank test), else
`RBD_MASSLESS_UNDETERMINED`.

### 5.7 Friction (TR-RBD-40, TR-RBD-41)

Per friction joint: state slip(+), slip(−) or stick. Slip: generalised force −F_c sign(v) − c_v v. A sign change
of v within a step triggers bisection to the zero crossing (1e-9 s), then a stick trial: add v_joint = 0 as a
constraint and solve; if \|λ_stick\| ≤ staticFactor × F_c keep stick, else slip in the direction of λ. In stick,
leave when \|λ_stick\| > staticFactor × F_c (break-away event). VC-RBD-40 is the exact piecewise reference.

### 5.8 Energy and outputs

Kinetic ½ q̇ᵀ M q̇; gravity potential −Σ mᵢ g·rᵢ; spring ½ k (ℓ − ℓ₀)²; non-conservative work ∫ (damper, friction,
actuator) power dt (trapezoidal on output steps). `balanceErrorJ` is reported; > 1e-3 relative of the initial
energy (named rule) adds warning `RBD_ENERGY_DRIFT`.

### 5.9 Quick checks (closed forms, identical to the generator)

Pendulum T = 4 √(L/g) K(sin(θ₀/2)), K by AGM (60 iterations); compound pendulum with equivalent length I/(m d);
spring-mass-damper closed form; slider-crank x = r cos θ + √(l² − r² sin²θ) with analytic derivatives and
τ = m ẍ dx/dθ; Coulomb oscillator turning points xₙ₊₁ = −sign(xₙ)(\|xₙ\| − 2F/k) until \|x\| ≤ F/k.

### 5.10 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Newton (scaled residual) | 1e-10 |
| Position constraint residual gate | 1e-9 m / 1e-9 rad |
| Initial projection | 1e-9 m |
| Rank tolerance | 1e-10 × ‖Φ_q‖ |
| Event location | 1e-9 s |
| Andrews angles at 0.03 s | 1e-6 rad (VC-RBD-01) |
| Pendulum period over ≥ 10 periods | 1e-5 relative |

## 6. Interop & persistence

| Item | Direction | Implementation |
| ---- | --------- | -------------- |
| Mechanism slice | persist | `physics.mechanism` JSON in `.llull` |
| Study series | out | `dynamics_study … --save file.json` (CLI writes `data.series`); CSV via `--save file.csv` (columns with units) |
| 05 load cases | out (in-document) | `export_joint_loads` → 05 `FeaLoad` with provenance |
| PHY-09 histories | out (in-document, V1) | `export_joint_load_history` → `physics.dynamics.histories` |
| Andrews fixture | test | `validation/andrews_reference.json` (parameters, initial state, reference, reproduction) |
| External engines | V2 | Chrono / MuJoCo model export for cross-check only (format TBD) |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands; `dynamics_study` long runs honour `--timeout` and print `--progress` from the host
  (the host runs the pure engine in a worker and reports step counts). `llull guide` gains a mechanism section
  (units, gravity explicit, planar mode, joint geometry, minimal plan, end with `check_mechanism`).
- **MCP**: `analysis` toolset; prompt `mechanism_loads` (model → check → study → export → margins).
- **UI**: study playback from `data.series` (viewport player source), reaction/effort plots, mass table; review only.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `RBD_INSTANCE_UNKNOWN` | error | instance id not an `InstanceEntity` | id | use an instance id (`insert_instance` / `create_component`) |
| `RBD_JOINT_UNKNOWN` | error | joint id not in `doc.joints` | id | `add_joint` first |
| `RBD_MASS_MISSING` | error | moving body without density or explicit mass | instance id | `assign_material` or `set_body_properties` |
| `RBD_MASS_UNVERIFIED` | warning (not suppressible) | density / geometry flagged unverified (08 / 01 KRN) | instance id | replace with a verified record |
| `RBD_INERTIA_INVALID` | error | not symmetric / not PSD / triangle inequality | param path | correct the tensor |
| `RBD_GROUND_MISSING` | error | no ground instance | — | `set_ground` |
| `RBD_GRAVITY_UNSET` | error | gravity not set | — | `set_gravity gravity=[0,0,-9.80665]` (or `[0,0,0]` for none) |
| `RBD_PIVOT_DEFAULTED` | warning | joint without `set_joint_geometry` | joint id | set the pivot (the anchor origin is used) |
| `RBD_PLANAR_AXIS_MISMATCH` | error | joint axis incompatible with the plane | joint id | fix axis or use spatial mode |
| `RBD_REDUNDANT_CONSTRAINTS` | warning | m − r > 0 | joint ids | planar mode or replace joints (e.g. spherical) |
| `RBD_CONSTRAINTS_INCONSISTENT` | error | redundant rows not satisfiable | joint ids, residual | correct pivots / axes |
| `RBD_INITIAL_INCONSISTENT` | error | projection residual > 1e-9 m | joint ids | consistent initial joint values |
| `RBD_MASSLESS_UNDETERMINED` | error | singular augmented matrix with massless bodies | instance ids | give mass or add actuators |
| `RBD_SPRING_INVALID` | error | negative stiffness / damping, unknown points | param path | correct |
| `RBD_PROFILE_INVALID` | error | table not increasing, lengths differ | param path | correct |
| `RBD_ACTUATOR_CONFLICT` | error | second actuator on a joint, or actuator + drive relation on the driven joint | joint id | remove one |
| `RBD_FRICTION_INVALID` | error | F < 0, staticFactor < 1, no citation | param path | correct; cite the coefficient |
| `RBD_STEP_INVALID` | error | step ≤ 0, does not divide output step, output > duration | param path | correct |
| `RBD_STEP_TOO_LARGE` | warning | h > T_min/20 (stiffest spring or joint mode) | element id | reduce `stepS` |
| `RBD_NEWTON_FAILED` | error | no convergence in 20 iterations | time, step | smaller step; check singular configuration |
| `RBD_SINGULAR_CONFIGURATION` | error | Jacobian rank drops during the run | time, joints | avoid toggle position; change geometry |
| `RBD_ENERGY_DRIFT` | warning | energy balance error > 1e-3 relative | — | smaller step / ρ∞ closer to 1 |
| `RBD_BUDGET_EXCEEDED` | error | bodies > 50, steps > 2·10⁶, output points > 10⁵ per column | limit | narrow outputs / page / coarser output step |
| `RBD_STUDY_UNKNOWN` | error | study name not saved | name | `save_dynamics_study` |
| `RBD_STUDY_STALE` | error | recomputed study hash ≠ named | study name | re-run and re-export |
| `RBD_TARGET_NOT_STATIC` | error | export target not a 05 static case | analysis id | create a static case |
| `RBD_HUMAN_GATE` | error | agent tries to complete a 05 disposition based on exported loads | row id | qualified reviewer |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03 | registry commands, unit-stating descriptions, `llull guide` mechanism section |
| AF-04 | unit suffixes in every param (`…Mm`, `…Kg`, `…N`, `…Nm`, `…S`, `…MPerS2`) |
| AF-05 | full set-up in one plan (`validation/plans/*.plan.json`) |
| AF-10 | `DynamicsStudyData` |
| AF-11 | §7.1 |
| AF-12 | series opt-in, paging, `--save` |
| AF-13 | TR-RBD-24 (VC-RBD-51) |
| AF-20 | `check_mechanism` |
| AF-21 | peaks, events, residuals as numbers; playback optional |
| AF-22 | `render_view` of a baked frame (V1 `bake_dynamics_frame`) |
| AF-23 | validation CLI harness |
| AF-30 | step and energy rules as named data |
| AF-31 | gravity, friction, static factor explicit; ρ∞ and pivot defaults named |
| AF-32 | mass / spring / friction `unverified` propagation |
| AF-33 | `reviewRequired` on reactions, efforts, exports |
| AF-34 | 05 disposition gate (`RBD_HUMAN_GATE`) |
| AF-35 | provenance (formulation, integrator, inputs hash, mass sources) |
| AF-36 | summary order |
| AF-40 | progress + timeout via host worker; budgets |
| AF-41 | no external tool needed |
| AF-42 | `--dry-run` on mutating commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Andrews' squeezer, 0.03 s at h = 1e-5 s | ≤ 2 s on the reference machine (TBD: measure) |
| 20 spatial bodies, 25 joints, 2 s at h = 1e-3 s | ≤ 10 s (TBD: measure) |
| Hard limits | ≤ 50 bodies, ≤ 2·10⁶ steps, ≤ 10⁵ output points per column (refusal `RBD_BUDGET_EXCEEDED`) |
| `check_mechanism` | ≤ 200 ms for 50 bodies |
| Quick checks | ≤ 20 ms |
| Memory | series stored only for requested columns |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit `tests/unit/physics/mechanism/*` | every command happy / failure / `is pure`; constraint Jacobians by finite differences; generalised-α on SMD and pendulum; friction switching; redundancy QR; quick checks vs `expected_results.json` | 10–12, 20, 21, 30, 31, 40, 41 |
| Benchmark (unit, pure) | Andrews' squeezer: a test-only builder turns `andrews_reference.json` into bodies, pivots and spring (M3 task: derive the pivot coordinates from the test-set geometry and check them against Φ(q₀) = 0, residual 1.4e-17 in the reduced form) | 01–04 |
| Golden | the five draft plans once commands exist; replay equality; data hash stable | 51 |
| Contract | `toToolSchemas()` snapshot; plugin validate / restore; toolset membership | — |
| Agent-first | codes, defaults named, unverified, review, export provenance, human gate | 50, 52–54 |
| PHY-00 harness | `run_benchmarks` over this pack's `expected_results.json` | all A-grade |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Plugin skeleton, data model, mechanism set-up commands, `check_mechanism` (DOF / redundancy / masses / gravity), quick checks, unit tests | 01 KRN TR-KRN-40 (inertia) for geometry masses; explicit masses work without it | 2.5 w |
| M2 | Engine: planar + spatial constraints, assembly, generalised-α, reactions, energy; pendulum / compound / SMD / slider-crank VCs | M1 | 3.5 w |
| M3 | Friction stick-slip, actuators, Andrews benchmark builder and VC-01…04, determinism golden, budgets | M2 | 2.5 w |
| M4 | Exports to 05 load cases, MCP prompt, guide section, playback data contract for the UI, production-gate scenario | M3, 05 M1 | 1.5 w |
| M5 (V1) | Reaction-dependent friction, cylindrical / universal joints, adaptive step, gears as constraints, histories to PHY-09, `bake_dynamics_frame` | M4, PHY-09 M5 | 3 w |
| V2 | Flexible bodies (05 modes), contacts / end stops, external engine cross-check | 05, PHY-06 | — |

MVP ≈ 10 weeks of one Lane-1 agent (plus small Lane-2 UI playback work).

## 11. Open questions / decisions needed

1. **Joint pivot and new kinds in core.** Add optional `pivot?: Vec3` (document units) to `JointBase` and kinds
   `fixed`, `spherical` to the core `Joint` union (core owner), or keep the plugin overlay `set_joint_geometry`
   permanently? Proposal: core field in a later core change; the overlay migrates into it.
2. **Kinematic evaluator limits** (anchor-origin pivot, non-propagating chains, Euler-angle addition, prismatic
   overwrite of b's offset; §1). Report to the core owner as a `fix-bug` item; PHY-10 does not depend on it.
3. **Mass units.** `Material.density` is g/(doc unit)³ and `mass_properties` returns grams; dynamics needs kg and
   kg·m². Confirm the conversion lives in `@phys` (proposal) and that 01 KRN returns inertia in g·(doc unit)².
4. **Toolset.** Put mechanism commands in `analysis` (physics) or in a new `mechanism` toolset next to core
   `assembly`? `TOOLSET_NAMES` must change either way (mcp owner).
5. **Friction data source.** Joint friction is pair data, not material data; should 08 MAT host a sourced
   friction-coefficient table (with grades) that `set_joint_friction` can cite? No open dataset was verified.
6. **Cross-platform determinism** of `Math.sin` / `Math.cos` across JS engines and versions (AF-13 is "same engine
   version"); decide whether golden hashes are per platform or tolerance-based across platforms.
7. **Andrews geometry builder.** The test set gives the problem in 7 relative angles; building it from llull
   bodies and pivots needs the body-fixed pivot coordinates from Hairer & Wanner's figure (not read). Until then
   VC-RBD-01…04 can also be run through a reduced-coordinate adapter in the test suite.

## 12. References

- [R1] Bari IVP Test Set, problem "andrews" — https://archimede.uniba.it/~testset/problems/andrews.php (via [R2]; host not fetched)
- [R2] deTestSet 1.1.7.4 `src/Ex_andrews.f` (GPL) — https://github.com/cran/deTestSet/blob/d5c4cbe821920ad0a2ac36ec03c6175531316213/src/Ex_andrews.f (accessed 2026-10)
- [R3] Hairer & Wanner, Solving ODE II — as cited by [R2], [R4]
- [R4] SolveDAE `examples/daes/andrews.py` — https://github.com/SolveDAE/solve_dae (accessed 2026-10)
- [R5] Arnold & Brüls, Multibody Syst. Dyn. 18:185–202, 2007 — https://orbi.uliege.be/handle/2268/27094 (accessed 2026-10, search)
- [R6] Chung & Hulbert, J. Appl. Mech. 60:371–375, 1993 (accessed 2026-10, search)
- [R7] Baumgarte, Comput. Methods Appl. Mech. Eng. 1:1–16, 1972, doi:10.1016/0045-7825(72)90018-7 (accessed 2026-10, search)
- [R8] NIST DLMF §22.19 — https://dlmf.nist.gov/22.19 (accessed 2026-10, search)
- [R10] Project Chrono — https://github.com/projectchrono/chrono (LICENSE BSD-3, HEAD 60b3938a, accessed 2026-10)
- [R11] MuJoCo — https://github.com/google-deepmind/mujoco (LICENSE Apache-2.0; `doc/programming/simulation.rst` "MuJoCo simulations are deterministic"; `doc/computation/index.rst` soft constraints; HEAD 0d1406da, accessed 2026-10)
- [R12] Rapier — https://github.com/dimforge/rapier (LICENSE Apache-2.0; `crates/rapier3d/Cargo.toml` `enhanced-determinism`; HEAD 475caa3f, accessed 2026-10)
- llull: `packages/core/src/commands/motion/*`, `packages/core/src/commands/assembly/*`, `packages/core/src/model/types.ts`, `packages/core/src/commands/inspect/measureSolid.ts`, `packages/mcp/src/toolsets.ts`, `../../aerospace/01-exact-brep-kernel/TECHNICAL_SPEC.md` §5.4, `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`, `../09-structural-dynamics/TECHNICAL_SPEC.md`

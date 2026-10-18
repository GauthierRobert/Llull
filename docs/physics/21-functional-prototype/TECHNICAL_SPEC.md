# PHY-21: Functional digital prototype — technical specification

Gap id **PHY-21** · prefix **FPR** · status: specification · written 2026-10-16 · functional spec:
[`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md)

## 1. Current state in llull (read in code, 2026-10-16)

| Area | What exists | Path | Limit for PHY-21 |
| ---- | ----------- | ---- | ---------------- |
| Dynamics model | `DynamicsModel { gravity, bodies, joints, gears, motors, propellers }`. `RigidBody { entityIds, fixed, density?, massKg? }`. `DynamicJoint { kind: 'revolute' \| 'prismatic', parent, child, anchor, axis, damping, friction, initialVelocity }` | `packages/core/src/model/dynamics.ts` | Invariant "each body is the child of at most one joint", so no loops; no spherical kind; motors are torque curve or speed governor only |
| Engine boundary | `PhysicsEngine.simulate(SimulationModel, SimulationOptions): SimulationTrace`. Bodies ordered parent before child, each with `joint \| null`. `gears` and `servos`. Pure `loads(state)` callback for joint and body forces | `packages/core/src/dynamics/physicsEngine.ts` | Tree only; trace has positions, velocities, poses and servo force, but **no constraint or reaction forces** |
| MuJoCo adapter | MJCF from the tree, RK4, **no geoms** (no contacts). Gears = `<joint>` equality, `solref = 2·dt`, `solimp 0.9999 0.9999 0.001`. Servos = `intvelocity`. Loads at the step midpoint | `packages/physics-mujoco/src/{mjcf,mujocoPhysics}.ts` (`@mujoco/mujoco` 3.14.0) | No `connect` equalities; `mj_rnePostConstraint`, `efc_*`, `cfrc_int` not read |
| Force laws | `motorForce` (torque curve × throttle, governor), `propellerOutput` (static Ct, Cp) | `packages/core/src/dynamics/forceLaws.ts` | No cylinder pressure |
| Report | Final rpm, settle time, engine and propeller output, measured gear ratios, tip Mach and figure-of-merit warnings; `detail: summary \| series \| poses` | `packages/core/src/dynamics/simulationReport.ts` | No reactions, no crank-angle axis, no energy closure |
| Kinematic joints | Separate model `doc.joints` (instances, `add_joint`, `motion_study` sweep, AABB interference) | `packages/core/src/commands/motion/*` | AABB only; a second mechanism model next to `doc.dynamics` |
| Model check | `check_model`: degenerate sizes, open profiles, dangling references, far from origin, parameter errors | `packages/core/src/commands/inspect/checkModel.ts` | Nothing physical |
| Kernel | `GeometryKernel { supports, evaluate(ShapeRecipe), tessellate, topology, exportStep }`. Recipes include `boolean` (union / subtract / intersect) and `place`. `ShapeTopology { solids, faces: { index, surface, area }[], edges, vertices, volume }` (OCC only) | `packages/core/src/geometry/kernel.ts`, `model/types.ts` ≈ l. 717 | No distance query, no validity status, no lump count on Manifold, no face axis or radius (joint realisation needs them) |
| Mass properties | Mesh-based mass, centre of mass and inertia per body | `packages/core/src/geometry/massProperties.ts`, `dynamics/simulationModel.ts` | — |
| Materials | `doc.materials` (`Material { name, density, color, metalness, roughness, finish? }`), `assign_material`, `BaseEntity.materialId`. `RigidBody.density` falls back to steel 7850 kg/m³ | `packages/core/src/model/types.ts` ≈ l. 644, `commands/document/materials.ts`, `model/dynamics.ts` | No source or grade on a material; the steel fallback is silent (an aluminium piston without a material weighs 2.9 × too much) |
| Losses | Joint `damping` and `friction` per dynamic joint; no engine friction, no gear efficiency | `model/dynamics.ts` | No FMEP, no brake values |
| UI | Mechanisms tab: Constraints, Joints, Drive relations, Physics (simulate, rpm chart `SpeedChart`, playback `DynamicsPlayer` + `dynamicsPlaybackStore` with speeds 1…1/100). Loads & forces review list + `DynamicsLoadsOverlay` (uncommitted work in progress) | `src/ui/panels/{MechanismsPanel,PhysicsSection,PhysicsLoadsSection,SpeedChart}.tsx`, `src/ui/viewport/3d/{DynamicsPlayer,DynamicsLoadsOverlay,MechanismOverlay,ClippingPlane}.tsx` | No checklist, findings, mechanism graph, crank-angle axis or Explain |
| Mesh acceleration | `three-mesh-bvh` in the UI (`bvhSetup.ts`) | `src/ui/viewport/3d/bvhSetup.ts` | Core may not import three (`.dependency-cruiser.cjs` L2 rule) |
| Human gate | None: no `ctx.caller`, no signature (09 PLM not built) | — | FR-FPR-31/33 need an interim gate (§11 Q5) |
| Spec overlap | PHY-10 specifies its own index-3 generalised-α solver with exact reactions and `check_mechanism`. The merged code uses MuJoCo instead | `docs/physics/10-rigid-body-dynamics/*` | PHY-21 builds on the MuJoCo code that exists; reconciliation is §11 Q1 |

## 2. Target architecture

```
src/ui/panels/review/*  Review tab: checklist, findings, mechanism graph, Explain, sign-off          (Lane 2)
src/ui/components/TimelineDock.tsx + charts   ·   src/ui/viewport/3d/{Findings,Thickness,TracePath,JointGlyph}Overlay.tsx
        │ dispatch (queries return data; dispositions / intents are mutating commands)
        ▼
packages/core/src/commands/
   inspect/   check_assembly · check_motion_clearance · check_prototype                 (query, requiresKernel)
   dynamics/  add_body_joint (loops, spherical) · add_cylinder_pressure · set_dynamics_solver ·
              engine_quick_check (query) · inspect_dynamics (+ mobility) · simulate_motion (+ reactions, engine)
   review/    allow_interference · set_part_grounded · set_review_disposition · sign_prototype_review   (new feature catalog)
packages/core/src/geometry/
   assemblyCheck/  partValidity.ts · pairClassify.ts · connectivity.ts · thickness.ts · jointRealisation.ts
   meshBvh.ts (deterministic AABB tree over MeshData) · triangleQueries.ts (tri–tri intersect / distance, ray–tri)
                   — the reference and small-case path (RS1 §2 rule 4)
   geometryQueries.ts  GeometryQueryEngine port (batch distance / ray queries); TS default on meshBvh, host-installed
                   native implementation = `llull-compute geomq` (§2.1)
packages/core/src/dynamics/
   topology.ts (spanning tree + loop closures) · mobility.ts (Gruebler + Jacobian rank) · cylinderPressure.ts ·
   engineReport.ts (crank-angle series, MEP, energy closure, ripple) · reactions.ts (frames, derived engine loads)
   engineLosses.ts (PNH / Chen–Flynn / table FMEP) · singleZone.ts (Wiebe + Woschni) · gearLoss.ts ·
   propellerTable.ts (C_T(J), C_P(J)) · accuracy.ts (Accuracy envelope, validation level) · referenceCompare.ts
packages/core/src/model/   materials catalogue with sources (al_4032, steel_4340) · reference data sets (Rotax, Lycoming)
   commands/dynamics/  set_engine_losses · add_reference_data · compare_to_reference (query)
packages/core/src/geometry/kernel.ts   + analyze · distance  (optional methods; null = unsupported)
packages/kernel-manifold · packages/kernel-occt        implement them
packages/physics-mujoco                                  connect equalities, solver settings, reactions in the trace
server/ + desktop                                        install the native GeometryQueryEngine when `llull-compute` is present
solver/crates/llull-geomq on llull-bvh                   clearance and wall-thickness batches, wgpu traversal + Rust-CPU twin (RS1 RS-6)
```

Laws respected:

- **L1/L5.** Every capability is a command. The four checks are pure read-only queries returning `data`. Intents,
  grounding, dispositions and sign-off are mutating commands. UI menus and MCP schemas come from the registry.
- **L2.** Core gains no DOM or three.js. Mesh queries use an own deterministic BVH in `geometry/meshBvh.ts` (three-mesh-bvh
  stays a UI-only optimisation); large batches go through the injected `GeometryQueryEngine` port, whose native
  implementation lives outside `packages/*` (§2.1). File output stays in the CLI `--save` path.
- **L3.** Pure, with `is pure` tests on every new command.
- **L4.** New document slice `doc.prototype` (§3.3) holds intents, grounding, dispositions and signatures. Check results
  are **not** stored in the document: they are recomputable, cached by the host by `inputsHash`, and saved to a file by
  `--save`.
- **L7.** Only 3D solids and instances take part. 2D entities are ignored, and the result says how many were skipped.
- **L8.** New commands record `FeatureStep`s; new ids are step-scoped (`fit-<step>.<k>`, `cyl-<step>.<k>`).
- **L9.** Exact geometry only through `ctx.kernel`: the existing `evaluate` plus two optional methods (§5.1). Physics
  only through `ctx.physics`. The MuJoCo-specific settings stay in `packages/physics-mujoco`; core passes
  engine-neutral `SimulationSolver` settings.
- **L10.** Placement is core, next to the existing dynamics and inspect catalogs: the capabilities are generic CAD and
  multibody. Only the cylinder-pressure law is engine-specific; it follows `add_propeller`, which is already in core.
  §11 Q3 asks whether to move both to a plugin.

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-FPR-01 | MUST | Kernel interface: optional `analyze(shape): ShapeAnalysis \| null` and `distance(a, b, maxDistance): ShapeDistance \| null` (§5.1). Both kernels implement them; a kernel returning null makes the dependent items `not_run` with `FPR_KERNEL_UNSUPPORTED`, never a pass. |
| TR-FPR-02 | MUST | `ShapeTopology.faces[i]` gains optional `axis?: { origin: Vec3; direction: Vec3; radius?: number }` for cylinder, cone and revolution faces and `normal?: Vec3` for planes (OCC: `BRepAdaptor_Surface`). Used by joint realisation. Backward compatible. |
| TR-FPR-03 | MUST | Interference volume through the existing recipe path: `evaluate({ op: 'boolean', boolean: 'intersect', a, b })` then `analyze(...).volume`. No new boolean API. |
| TR-FPR-04 | MUST | `geometry/meshBvh.ts`: AABB tree over a `MeshData` in its local frame, median split on the longest axis, leaf size 8, deterministic tie rule (lower triangle index). Queries take a rigid transform (rotation matrix + translation) for the other mesh: `intersects`, `minDistance(maxDistance)` with witness points, `rayCast(origin, direction, maxT)`. |
| TR-FPR-05 | MUST | Dynamics topology (§5.3): spanning tree by BFS from `ground` over the body–joint graph. Order: joints sorted by `(isRevolute ? 1 : 0, creation order)` so prismatic joints enter the tree first. The tree is chosen Kruskal-style in that order (the last-declared joint of a loop closes it), then rooted by BFS from `ground`. Non-tree joints become `SimulationLoop`s. A prismatic joint that would have to be a loop closure is refused: `FPR_LOOP_PRISMATIC` (MuJoCo has no slide equality between bodies). |
| TR-FPR-06 | MUST | `SimulationModel` gains `loops: SimulationLoop[]` and `solver: SimulationSolver`. `SimulationTrace` gains `loopForce` (per loop, world N, per sample), `jointReaction` (per tree joint: force N and moment N·m at the anchor, world axes), and `loopResidual` (max over samples, m). All three are optional on the interface so another engine may omit them; the report then marks the items `not_run`. |
| TR-FPR-07 | MUST | MuJoCo adapter: revolute loop = two `connect` equalities at the anchor ± `axis · s` (s = half the shorter body's bounding-box extent along the axis, ≥ 5 mm, named); spherical loop = one `connect`. Each equality gets the loop `solref`/`solimp` from `solver` (§5.3). `<flag diagexact="enable"/>` when available. Reactions: `mj_rnePostConstraint` after each recorded step, `cfrc_int` moved from the subtree-COM frame to the joint anchor; loop forces from `efc_force` rows with `efc_type == mjCNSTR_EQUALITY` and matching `efc_id`, sign fixed by a static unit test; residual from `efc_pos`. |
| TR-FPR-08 | MUST | Cylinder pressure law (§5.4) is pure core code, evaluated in `loads(state)` as a generalised force on the piston's prismatic joint, so MuJoCo applies the reaction to the cylinder's body (the joint parent) automatically. The pressure–angle table is precomputed once per run on a 0.1° grid. |
| TR-FPR-09 | MUST | Mobility (§5.5) in core from the same topology: Gruebler count and numerical rank of the loop-constraint Jacobian at the initial pose (finite differences in tree coordinates, column-pivoted QR, rank tolerance 1e-6 relative = sqrt(eps), the noise floor of the differences; named). |
| TR-FPR-10 | MUST | `check_motion_clearance` (§5.6) rebuilds part poses from `SimulationTrace.bodyPosition/bodyOrientation` (or from `motion_study` steps) and runs the pose × pair distance batch through `ctx.geometryQueries` on the kernel tessellation (tessellation tolerance reported): `llull-compute geomq` when installed, else `meshBvh` within the TS budget (§8). The worst colliding pose is re-evaluated exactly through placed recipes for volume. |
| TR-FPR-11 | MUST | Determinism: fixed iteration orders (entity order, body order, joint creation order, pair `(i < j)` order), no `Math.random`, numbers in `data` rounded to 12 significant digits (PHY-10 TR-RBD-24 convention). |
| TR-FPR-12 | MUST | `inputsHash` per check = sha256 of the canonical JSON of everything the check reads: recipes' `recipeKey`, transforms, dynamics slice, intents, params, kernel and engine names. Uses `@lib/hash` over canonical JSON (keys sorted). Deviation: `@lib/hash` is a 64-bit FNV-style hash, not sha256 (core has no sha256 and may not use Node crypto); it identifies inputs but is not collision-resistant against an adversary. |
| TR-FPR-13 | MUST | Agent-first result envelope on every query: `{ status, items[], provenance, unverified, reviewRequired, inputsHash }`, unit-suffixed fields, `FPR_*` codes (§7.1). |
| TR-FPR-14 | MUST | `Accuracy` envelope (§3.4) attached to every scalar output of the engine report, the reactions and the comparison. It is built in `dynamics/accuracy.ts` from the model's inputs: each law declares its own band and basis (friction ±15 % [E-R9], combustion as calibrated, reactions inheriting the worst input band). Bands combine by root-sum-square of independent relative bands, named. A missing band propagates as `null` ("± ?"), never as 0. |
| TR-FPR-15 | MUST | Engine losses (§5.8) are a pure core law evaluated in `loads(state)`: a torque on the crank joint, T_f = −FMEP(n, p_max)·V_d/(4π)·s(ω), with s(ω) = tanh(ω/ω_s), ω_s = 1 rad/s (named), so the cycle-average loss equals FMEP·V_d exactly at steady speed. p_max is taken from the previous cycle (first cycle: the calibration value). |
| TR-FPR-16 | MUST | `singleZone.ts`: first-law single-zone ODE with Wiebe heat release and Woschni heat loss, RK4 on a 0.1° grid, precomputed per operating point (rpm enters through Woschni and burn scaling). The model is no longer linear in Q, so calibration uses a secant iteration on Q_total until \|brake target error\| ≤ 0.1 % (named), at most 30 iterations, else `FPR_CALIBRATION_FAILED`. |
| TR-FPR-17 | MUST | Gear loss: on each gear equality the transmitted torque is read from the equality force (`efc_force`, as for the loop reactions). The loss (1 − η)·\|T_in\| is applied as a load on the driven joint, against its velocity. Power flow direction comes from sign(T·ω) on the driving side. |
| TR-FPR-18 | MUST | `compare_to_reference`: per operating point, a governed run (full throttle, the point's rpm, settle + 2 cycles) or a free-equilibrium run with the propeller. It reports S from the last cycle, D, E, U_val and `origin` from the calibration set. U_num comes from the timestep-halving difference at the calibration point (FR-FPR-79); U_input comes from the input bands; U_D comes from the reference record. |
| TR-FPR-19 | MUST | `GeometryQueryEngine` port (`packages/core/src/geometry/geometryQueries.ts`, proposal): `minDistanceBatch(meshes, poses, pairs, maxDistance)` and `rayCastBatch(mesh, rays, maxT)`, results in input order. Default implementation = `meshBvh` (always available, browser included). The host may install the native one (`llull-compute geomq`, crate `llull-geomq` on `llull-bvh`); provenance names the engine, the device and `deterministic`. Numbers in `data` come from the Rust-CPU twin or fixed-order GPU reductions (RS1 §2 rule 3); a GPU-only fast pass may prune pairs but the reported minima are recomputed on a deterministic path. |

### 2.1 Stack amendment (RS1, 2026-10-18)

Decision [RS1](../../decisions/RS1-native-compute.md) step **RS-6** moves the two large mesh-query batches to native code:
`check_motion_clearance` (up to 4 000 poses × 200 pairs) and the wall-thickness rays of `check_assembly` (up to 200 000).
They run in `llull-compute geomq` (crate `llull-geomq` on the shared `llull-bvh`: deterministic BVH build, GPU traversal on
wgpu, Rust-CPU twin). What does not change:

- `meshBvh.ts` and `triangleQueries.ts` stay. They are the small-case path, the browser path and the test oracle;
  the native results must match them (VC-FPR-37).
- The checks stay pure registry queries; they read the batch engine from an injected port (TR-FPR-19), like
  `ctx.kernel` and `ctx.physics` (L9). Nothing in `packages/*` imports native code (RS1 §2 rule 1).
- MuJoCo stays the dynamics engine; OCC / Manifold stay the exact-geometry path (worst-pose volume, joint realisation).
- Without `llull-compute` everything works within the TS budgets of §8; above them the request is refused with
  `FPR_BUDGET_EXCEEDED` naming the limit (no silent truncation).

## 3. Data model

### 3.1 Dynamics additions (`packages/core/src/model/dynamics.ts`)

```ts
export interface DynamicJoint {
  readonly id: string;
  kind: 'revolute' | 'prismatic' | 'spherical';       // + spherical (loop closures, ball ends)
  parent: string;                                       // body id or GROUND
  child: string;
  anchor: Vec3;                                         // document units
  anchorOnChild?: Vec3;                                 // pin position on the child when it differs; the distance to `anchor` is the loop gap (FPR_LOOP_OPEN). Implemented: with one anchor per joint a loop is otherwise always closed at the start pose
  axis: Vec3;                                           // ignored for spherical
  damping: number; friction: number; initialVelocity: number;
}
// @invariant parent !== child; spherical joints have damping = friction = initialVelocity = 0;
//            a body may be the child of several joints (closed loops) — the tree is chosen by dynamics/topology.ts

/** Gas pressure on a piston (prismatic joint), driven by a crank (revolute joint) for the cycle angle. */
export interface CylinderPressure {
  readonly id: string;
  piston: string;                    // prismatic joint id
  crank: string;                     // revolute joint id
  boreMm: number;                    // > 0
  compressionRatio: number;          // > 1
  cycle: 'four_stroke' | 'two_stroke';
  firingOffsetDeg: number;           // which TDC crossing of this piston fires: 0 or 360 (implemented restriction; other values put the firing TDC off a TDC). Phasing between cylinders comes from the crank-pin geometry
  /** Crank joint angle (rad, from its t = 0 pose) at which this piston is at TDC; null = computed from geometry. */
  tdcCrankAngleRad: number | null;
  ambientPressurePa: number;         // default 101 325 (ISA sea level), named
  model:
    | { kind: 'table'; points: readonly (readonly [cycleDeg: number, gaugePa: number])[]; source?: string }
    | { kind: 'wiebe'; startDeg: number; durationDeg: number; a: number; m: number;
        compressionIndex: number; expansionIndex: number; intakePressurePa: number;
        heat: { kind: 'per_cycle_J'; value: number } | { kind: 'target_imep_Pa'; value: number };
        source?: string }
    | { kind: 'single_zone';                         // FR-FPR-72, realistic default
        burn: { ca50Deg: number; durationDeg: number; a: number; m: number; rpmExponent: number }  // 0.2 [E-R12]
            | { startDeg: number; durationDeg: number; a: number; m: number; rpmExponent: number };  // fixed spark
        woschni: { c1: number; c2Closed: number; c2Exchange: number; c3: number; tempExponent: number; wallTempK: number };
        intakePressurePa: number; intakeTempK: number;
        heat: { kind: 'per_cycle_J'; value: number }
            | { kind: 'calibrate_brake'; points: readonly { rpm: number; brakeTorqueNm: number }[] }
            | { kind: 'table_vs_rpm'; points: readonly (readonly [rpm: number, joulesPerCycle: number])[]; source?: string };
        source?: string };
}

/** FR-FPR-71: mechanical losses on a crank, reported as FMEP. */
export interface EngineLosses {
  readonly id: string;
  crank: string;                     // revolute joint id
  cylinders: string[];               // CylinderPressure ids (V_d, bore, stroke, p_max come from them)
  model:
    | { kind: 'component'; mainBearing: { diameterMm: number; lengthMm: number; count: number };
        rodBearing: { diameterMm: number; lengthMm: number };
        valvetrain: 'ohv_rocker' | 'sohc_finger' | 'sohc_rocker' | 'dohc_direct'; valvesPerCylinder: number;
        variant: 'pnh' | 'sandoval_heywood' }                    // [E-R9]
    | { kind: 'chen_flynn'; aPa: number; bRatio: number; cPaPerRpm: number; dPaPerRpm2: number; source: string }  // [E-R10]
    | { kind: 'fmep_table'; points: readonly (readonly [rpm: number, fmepPa: number])[]; source: string };
  oilTempFactor: number;             // 1 = hot; cold ≈ 2.1 [E-R9]
}

export interface DynamicsSolverSettings {
  timestepS: number | 'auto';        // auto = min(1 ms, 0.5° crank at the highest expected speed), named in provenance
  integrator: 'rk4' | 'implicitfast';
  loopTimeConstantSteps: number;     // solref timeconst = k · timestep, k ≥ 2 (MuJoCo refsafe), default 2
  loopImpedance: number;             // solimp d0 = dwidth, default 0.9999 (mjMAXIMP)
  loopResidualPassM: number;         // default 1e-6 (5 % of 0.020 mm diametral pin clearance [F-R19])
  loopResidualFailM: number;         // default 1e-5
  timestepSensitivityGate: number;   // default 0.01 (FR-FPR-79)
}

export interface DynamicsModel {
  gravity: Vec3; bodies; joints; motors;
  gears;                                         // GearPair gains efficiency (default 0.99 [E-R21]) and optional teeth: [number, number]
  propellers;                                    // Propeller gains table?: { points: [J, ct, cp][]; source; grade } and inertiaKgM2?
  cylinders: Record<string, CylinderPressure>;   // new, default {}
  losses: Record<string, EngineLosses>;          // new, default {}
  solver?: DynamicsSolverSettings;               // new, absent = defaults
}
```

`Material` (`model/types.ts`) gains optional `source?: string` and `grade?: 'A' | 'B' | 'C'`. A catalogue of sourced
materials (`al_4032` 2680 kg/m³ [E-R32], `steel_4340` 7850 kg/m³ [E-R31]) is offered by `assign_material` by name.
Bodies whose mass falls back to `RigidBody.density` or the 7850 default are reported (`FPR_MASS_DEFAULTED`).

Load validation (`commands/persistence/dynamicsValidation.ts`) accepts both new fields, and an old document without
them loads unchanged. The relaxed joint invariant is validated as: every body reachable from `ground` through joints
or `fixed`, otherwise `FPR_PART_FLOATING` at check time (not a load error).

### 3.2 Engine boundary (`packages/core/src/dynamics/physicsEngine.ts`)

```ts
export interface SimulationJoint { readonly kind: 'revolute' | 'prismatic' | 'spherical'; /* rest unchanged */ }
export interface SimulationLoop {
  readonly id: string;                 // the DynamicJoint id that closes the loop
  readonly kind: 'revolute' | 'spherical';
  readonly bodyA: string; readonly bodyB: string;   // bodyA = joint parent ('world' allowed), bodyB = child
  readonly anchor: Vec3; readonly axis: Vec3;       // world, m
}
export interface SimulationSolver {
  readonly integrator: 'rk4' | 'implicitfast';
  readonly loopTimeConstant: number;   // s
  readonly loopImpedance: number;
}
export interface SimulationModel { /* … */ readonly loops: readonly SimulationLoop[]; readonly solver: SimulationSolver }
export interface SimulationTrace {
  /* … existing … */
  readonly loopForce?: Record<string, Vec3[]>;                                   // on bodyB, world, N
  readonly jointReaction?: Record<string, { force: Vec3[]; moment: Vec3[] }>;    // on child at anchor, world
  readonly loopResidual?: number;                                                 // m, max over samples
}
```

### 3.3 Prototype slice (`packages/core/src/model/prototype.ts`, new)

```ts
export interface InterferenceIntent {
  readonly id: string;
  a: string; b: string;                               // entity or instance ids (unordered pair)
  kind: 'press_fit' | 'thread' | 'weld' | 'overlap_by_design';
  reason: string;                                     // non-empty
  declaredBy: 'agent' | 'human';                      // from the caller (§11 Q5); shown as a badge
}
export type DispositionStatus = 'not_reviewed' | 'relevant' | 'irrelevant' | 'accepted';
export interface Disposition {
  readonly findingKey: string;        // `${check}:${code}:${sorted ids}` — stable across runs
  status: DispositionStatus;
  comment: string;
  inputsHash: string;                 // of the check when the disposition was made
  by: 'agent' | 'human'; at: string;  // ISO time from ctx.clock (deterministic in tests)
}
export interface ReviewSignature {
  readonly id: string; reviewer: string; at: string;
  verdict: 'approved' | 'rejected'; checkHashes: Record<string, string>; comment: string;
}
/** FR-FPR-77: measured or datasheet data to validate against. */
export interface ReferenceData {
  readonly id: string;               // e.g. 'rotax_912uls_full_throttle'
  quantity: 'brake_torque_Nm' | 'brake_power_kW' | 'bmep_bar' | 'static_rpm' | 'propeller_rpm' | 'bsfc_g_per_kWh';
  condition: { throttle: 'full' | 'propeller_curve'; altitudeM: number; note?: string };
  points: readonly { rpm?: number; value: number; min?: number; max?: number; uncertainty?: number }[];  // window: min/max
  source: string; grade: 'A' | 'B' | 'C';
  digitised: boolean;                // read off a graph (uncertainty = reading error)
  calibrationRpm: number[];          // points used for calibration → origin 'calibrated'
  bandRel: number;                   // default 0.05 [E-R20]
}
export interface PrototypeModel {
  references: Record<string, ReferenceData>;          // new
  intents: Record<string, InterferenceIntent>;
  grounded: string[];                                 // entity / instance ids treated as attached to the world
  dispositions: Record<string, Disposition>;
  signatures: ReviewSignature[];
}
// CadDocument.prototype?: PrototypeModel — optional, created on first write; load validation in persistence/.
```

### 3.4 Check result envelope (shared by the four queries)

```ts
type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_run';
/** FR-FPR-70 / TR-FPR-14 — attached to every scalar output (values[key] ↔ accuracy[key]). */
interface Accuracy {
  band: { rel: number } | { abs: number; unit: string } | null;   // null = "no quantitative estimate available"
  basis: string;                                                   // source ref or method
  origin: 'input' | 'calibrated' | 'predicted' | 'verification';
  validationLevel: 0 | 1 | 2 | 3 | 4;                              // NASA-STD-7009 validation scale [F-R32]
  comparison?: { referenceId: string; s: number; d: number; e: number; uVal: number | null };
  warnings: string[];                                              // e.g. "rigid bodies: no torsional resonance"
}
interface CheckItem {
  code: string;                  // FPR_* (§7.1)
  status: CheckStatus;
  ids: string[];                 // entities / instances / joints / bodies
  findingKey: string;
  values: Record<string, number>;        // unit-suffixed keys: overlapVolumeMm3, minDistanceMm, thicknessMm, …
  accuracy?: Record<string, Accuracy>;   // same keys as values (physics outputs; geometry checks use tolerances)
  threshold?: { value: number; unit: string; source: string; grade: 'A' | 'B' | 'C'; defaulted: boolean };
  witness?: { pointsMm: Vec3[]; timeS?: number; crankDeg?: number };
  remediation: string;
  unverified?: boolean;
  disposition?: Disposition & { stale: boolean };   // joined from doc.prototype
}
interface CheckResult {
  check: 'assembly' | 'mechanism' | 'motion_clearance' | 'dynamics';
  status: CheckStatus;           // worst item, after allowed intents and accepted dispositions
  items: CheckItem[];
  provenance: { method: string; kernel?: string; engine?: string; tolerances: Record<string, number>; params: unknown };
  inputsHash: string;
  unverified: boolean;
  reviewRequired: true;
}
```

## 4. Commands

| Command | Kind | Params (sketch) | Tags |
| ------- | ---- | --------------- | ---- |
| `check_assembly` | query, `requiresKernel` | `{ scope?: 'all' \| { ids } \| { body } \| { component }, clearanceMm?, touchToleranceMm?, process?: ProcessId, minWallMm?, thickness?: 'off' \| 'ray', raysPerPart? (default 2000, max 20 000), includeJoints?: boolean (default true) }` | `@affects none` · `@invariant same doc back, affected []` · `@failure no kernel ⇒ FPR_KERNEL_UNSUPPORTED; budget ⇒ FPR_BUDGET_EXCEEDED` |
| `allow_interference` | mutating | `{ a, b, kind, reason }` | `@affects doc.prototype.intents` · `@failure a = b, unknown id, empty reason` |
| `remove_interference_intent` | mutating | `{ id }` | `@affects doc.prototype.intents` |
| `set_part_grounded` | mutating | `{ ids, grounded: boolean }` | `@affects doc.prototype.grounded` |
| `add_body_joint` (extended) | mutating | `+ kind: 'spherical'`; child may already have a joint | `@invariant parent ≠ child`; `@failure loop needs a prismatic closure ⇒ FPR_LOOP_PRISMATIC` |
| `add_cylinder_pressure` | mutating | `{ piston, crank, boreMm, compressionRatio, cycle?, firingOffsetDeg?, tdcCrankAngleDeg?, ambientPressurePa?, model }` | `@affects doc.dynamics.cylinders` · `@failure piston not prismatic, crank not revolute, bore ≤ 0, CR ≤ 1, table not covering the cycle, Wiebe a ≤ 0 or duration ≤ 0` |
| `set_engine_losses` | mutating | `{ crank, cylinders?, model, oilTempFactor? }` | `@affects doc.dynamics.losses` · `@failure crank not revolute; component model without bearing sizes; table without source` |
| `add_reference_data` | mutating | `ReferenceData` minus id + `{ id? }`; `preset?: 'rotax_912uls_full_throttle' \| 'rotax_912is_power_table' \| 'o320a_full_throttle' \| 'o320b_full_throttle' \| 'rotax_912_static_rpm_window'` | `@affects doc.prototype.references` · `@failure empty points, no source, band ≤ 0` |
| `compare_to_reference` | query, physics | `{ reference: id \| 'all', points?: rpm[], detail? }` | per point S, D, E, U_val, band, origin, status; `@failure no losses on a brake quantity ⇒ FPR_NO_LOSSES (brake vs indicated would mislead)` |
| `set_dynamics_solver` | mutating | `Partial<DynamicsSolverSettings>` | `@affects doc.dynamics.solver` · `@failure loopTimeConstantSteps < 2, impedance ∉ (0, 0.9999]` |
| `inspect_dynamics` (extended) | query | `+ mobility: boolean (default true)` | adds `data.topology { tree, loops }`, `data.mobility { gruebler, rank, dof, redundant[] }`, `data.loopGapsM` at the start pose |
| `engine_quick_check` | query | `{ cylinder?: id, crankRadiusMm?, rodLengthMm?, forceN?, anglesDeg?, rpm?, mepBar?, displacementCm3?, cycle? }`. Taken from the model when a cylinder id is given | analytic only (§5.4), no kernel or physics |
| `simulate_motion` (extended) | query, physics | `+ reactions?: 'off' \| 'peaks' \| 'series'` (default `peaks` when loops or cylinders exist), `+ crankAxis?: joint id` | adds `data.reactions`, `data.engineReport` (not `data.engine`: that key already holds the engine name string), `data.loops`; the reaction component along the axis of a driven joint includes the applied drive force (`cfrc_int` excludes `qfrc_applied`); unchanged output for models without loops or cylinders (FR-FPR-19) |
| `check_motion_clearance` | query, `requiresKernel` + physics | `{ source: 'simulation' \| { joint, startDeg, endDeg }, durationS? \| cycles?, clearanceMm?, pairs?: 'moving' \| 'all', maxSamples? (default 4000) }` | `@failure no poses ⇒ FPR_NO_MOTION` |
| `check_prototype` | query, `requiresKernel` + physics | `{ process?, minWallMm?, clearanceMm?, cycles? (default 1), settleS? }` | runs the four checks in order; `verdict`, `ownerSummary`, `checks[]` |
| `set_review_disposition` | mutating | `{ findingKey, status, comment }` | `@failure accepted on a fail by an agent ⇒ FPR_HUMAN_GATE` |
| `sign_prototype_review` | mutating, human gate | `{ reviewer, verdict, comment }` | `@failure open fails, stale dispositions, non-human caller ⇒ FPR_SIGNOFF_BLOCKED / FPR_HUMAN_GATE` |

Toolsets: the checks and `engine_quick_check` go in `analysis`, mirrored as next-call hints in `assembly` (FR-FPR-40).
The review commands go in a new `review` toolset; `sign_prototype_review` is hidden from MCP (callable only through
the UI path; §11 Q5).

## 5. Algorithms

### 5.1 Kernel additions (TR-FPR-01)

```ts
interface ShapeAnalysis {
  valid: boolean; status: string;          // Manifold ErrorStatus / OCC BRepCheck summary
  closed: boolean;                          // watertight solid(s)
  volume: number; area: number;             // document units³ / ²
  lumps: { volume: number; area: number; bounds: Bounds }[];   // disconnected pieces
  freeFaces: number;                        // OCC: faces not in a closed shell; Manifold: 0 (cannot hold sheets)
}
interface ShapeDistance { distance: number; pointA: Vec3; pointB: Vec3; inside: boolean }  // inside = one contains the other
```

| Method | Manifold (`manifold-3d` 3.5.4) | OCC (`opencascade.js` 1.1.1) |
| ------ | ------------------------------ | ---------------------------- |
| `analyze.valid/status` | `status() === 'NoError'`, `isEmpty()` [B-R29][B-R30] | `BRepCheck_Analyzer.IsValid()`; `BRepAlgoAPI_Check` (`BOPAlgo_ArgumentAnalyzer` is not in the 1.1.1 bindings) [B-R19][B-R20] |
| `analyze.lumps` | `decompose()` then `volume()/surfaceArea()/boundingBox()` per piece [B-R29] | explore `TopAbs_SOLID` + `BRepGProp.VolumeProperties` |
| `analyze.freeFaces/closed` | input that is not a closed 2-manifold fails `status()` (NotManifold), so it reports invalid | `ShapeAnalysis_FreeBounds` (open wires), `ShapeAnalysis_ShapeContents` free faces / shells [B-R25][B-R27] |
| `distance` | `minGap(other, maxDistance)` (0 when they intersect) [B-R29][B-R31]; witness points from the core BVH on the tessellation | `BRepExtrema_DistShapeShape` (`Value`, `PointOnShape1/2`, `InnerSolution`) [B-R22] |

### 5.2 `check_assembly`

1. **Collect parts**: 3D solid entities not consumed by a boolean or feature, plus instances expanded through
   `instanceExpansion` with their transforms. Recipes come from `shapeRecipe`. Skipped 2D entities are counted.
2. **Part validity** (FR-FPR-02): `analyze` each part. Rules: `!valid` → `FPR_PART_INVALID`; `volume ≤ ε_vol,abs` →
   `FPR_PART_EMPTY`; `lumps.length > 1` → `FPR_PART_DISCONNECTED`; `freeFaces > 0` or (`area > 0` and `2V/A < 1e-3 mm`)
   → `FPR_PART_SHEET`. The 2V/A proxy is the mean thickness of a thin plate (V = A_face·t, A ≈ 2·A_face).
3. **Broad phase**: world AABBs, inflated by `max(clearance, ε_touch)`, sweep-and-prune on x, then y and z overlap
   tests. Pairs inside the same rigid body are skipped unless `scope` asks for them (they are welded).
4. **Narrow phase per pair** (FR-FPR-03): `d = distance(a, b, clearance + ε_touch)`.
   - `d.inside` or `d.distance == 0` → `V = analyze(intersect(a, b)).volume`.
     `V ≥ 0.99·min(V_a, V_b)` → `containment`; `V > ε_vol` → `hard`; else `touch`.
   - `0 < d.distance ≤ ε_touch` → `touch`; `< clearance` → `clearance`; else no item.
   - Penetration-depth estimate for `hard`: `V / A_overlap,proj`, where A_overlap,proj is the projected area of the
     intersection's bounds on the plane normal to the witness direction (labelled `estimate`).
   - An intent on the pair turns `hard` / `containment` into `allowed` (status pass, intent shown).
5. **Connection graph** (FR-FPR-06): union–find over parts. Unite: same rigid body; joint parent/child (both models;
   the dynamic joint's bodies expand to their entities, kinematic joints to their instances); intents of kind `weld` /
   `thread` / `press_fit`; `touch`, `hard` or allowed contacts. Grounded set: entities of `fixed` bodies, children of a
   joint whose parent is `ground`, the grounded list, and the parents of kinematic joints that are not themselves a
   joint child. Results: components without a grounded member → `FPR_PART_FLOATING` (one item per component, listing
   its parts). Parts whose only links are `touch` → `FPR_PART_RESTING_ONLY`.
6. **Thickness, ray method** (FR-FPR-07): tessellate; build the BVH (`meshBvh`, or `llull-geomq` through `ctx.geometryQueries`, TR-FPR-19); sample `raysPerPart` triangle centroids,
   area-weighted, with a deterministic low-discrepancy sequence (Halton bases 2 and 3 over the cumulative area). From
   each sample, shoot a ray along the inward normal; the thickness is the first hit at t > 1e-6·diag. Exclude samples
   within `cornerExclusionMm` (default 0.5 × threshold, named) of a sharp edge (dihedral > 60°). Report min, 1st
   percentile and the location of the thinnest sample, the 10 thinnest clusters (samples grouped by 2 × threshold
   distance), and `method: 'ray'`. The ray method overestimates on non-parallel walls [B-R11]; V1 adds the
   inscribed-sphere method.
7. **Process thresholds** (`packages/core/src/model/processRules.ts`, data with sources, AF-30):

   | ProcessId | Min wall | Source (grade) |
   | --------- | -------- | -------------- |
   | `cnc_metal` | 0.794 mm | Xometry CNC thin walls [B-R14] (B) |
   | `injection_abs` / `_nylon` / `_pc` / `_pp` | 1.143 / 0.762 / 1.016 / 0.889 mm (range lows) | Protolabs injection moulding guide [B-R12] (B) |
   | `dmls_aluminium` | 0.762 mm (range low) | Protolabs [B-R15] (B) |
   | `sls` / `mjf` / `sla` | 0.762 / 0.508 / 0.4064 mm | Protolabs [B-R15] (B) |
   | `sand_cast_al` / `sand_cast_steel` | 2.54 / 3.30 mm (0.10 / 0.13 in) | Engineers Edge [B-R16] (B) |

   All are vendor guidance, not standards, so they are grade B and carry `defaulted: true` when picked by process.
8. **Joint realisation** (FR-FPR-08), OCC: for each revolute joint, among the faces of each side with
   `axis.direction` parallel to the joint axis within 0.5° and `|offset| ≤ 0.01 mm + 1e-4·radius`, take the closest
   pair across sides with opposite orientation (convex pin vs concave bore). Report diametral clearance =
   2·(r_bore − r_pin), engagement = overlap of their axial extents. On Manifold: fit a cylinder by least squares to the
   tessellation vertices within 1.5× the expected radius of the axis; `approximate: true`.

### 5.3 Closed loops in MuJoCo (TR-FPR-05…07)

- **Topology**: BFS from `ground` over the undirected body–joint graph, in the joint order of TR-FPR-05. The tree
  joint of each body is the first joint that reaches it. Remaining joints are loops. A tree joint whose
  parent/child are reversed relative to BFS keeps its declared sense: the MJCF nests the child under the parent
  declared in the BFS direction and flips the axis sign (reported in `topology.flipped`).
- **MJCF**: `connect` with `body1 = bodyA` (or world), `body2 = bodyB`, `anchor` = the world anchor expressed in
  bodyA's frame at the initial pose. A revolute loop adds a second `connect` at `anchor + s·axis`. MuJoCo documents
  two connects on the same pair as forming a hinge outside the tree [C-R2]. In a planar loop the out-of-plane rows are
  redundant; the solver's regularisation accepts them [C-R2] (the docs do not say this directly; covered by
  VC-FPR-13/20).
- **Stiffness**: `solref = (loopTimeConstantSteps · dt, 1)`, `solimp = (d, d, 0.001, 0.5, 2)` with `d = loopImpedance`.
  The steady violation under load is r = a₀(1 − d)·τ²·ζ² [C-R3]. The derived wrist-pin estimate is ≈ 2.6 m with
  defaults and ≈ 1e-8 m with dt = 2e-5 s, τ = 4e-5 s, d = 0.9999 [C §1.2]. Defaults are therefore overridden for
  every loop. The gear equality keeps its existing settings.
- **Timestep auto**: dt = min(1e-3, (0.5° in rad) / ω_max). ω_max is the largest of the governor targets,
  torque-curve end rpm, and 1.2 × the highest rpm reached in a 0.2 s pilot run when no governor exists. At
  5800 rpm this gives 14.4 µs; at 2700 rpm, 30.9 µs. Named in provenance.
- **Contacts**: the MJCF has no geoms (unchanged), so no parent–child contact filtering is needed [C-R1][C-R2].
- **Reactions**: after each recorded step, `mj_rnePostConstraint(m, d)` [C-R4]. Tree joint of body b: `cfrc_int[b]`
  = [torque(3), force(3)] about `subtree_com[root(b)]`, world axes. Moved to the anchor: F = f, M_anchor = τ + (c − p) × f.
  The binding name and layout of `subtree_com` are to be confirmed in 3.14.0 (TR test). Loop k: sum of `efc_force` over
  its EQUALITY rows (`efc_id == k`). These are world components because the residual is a world-position difference
  [C-R2]. Sign fixed by VC-FPR-12. Residual: max |`efc_pos`| over loop rows and samples [C-R5].
- **Fallback cross-check**: MuJoCo's slider-crank transmission (`cranksite`, `slidersite`, `cranklength`) gives the
  exact force-to-torque geometry without rod or piston bodies [C-R1][C-R2]. A test-only MJCF builds it for VC-FPR-11.

### 5.4 Cylinder pressure and engine report (TR-FPR-08)

Geometry from the model at t = 0. Crank radius r = |crank pin − crank axis| projected normal to the axis (the crank
pin is the rod's tree or loop joint on the crank). Rod length l = |crank pin − wrist pin|. Cylinder axis = the piston
joint axis. A = π·bore²/4. V_d = A·2r. V_c = V_d / (CR − 1). TDC crank angle: the crank angle at which the crank pin
lies on the cylinder axis on the head side, solved in closed form in the crank plane. Offset cylinders (cylinder axis
not through the crank axis) are handled by the same rule and flagged `offset`.

Kinematics and forces (exact, [C-R12]):

```
λ = r/l,  sin β = λ sin θ
x(θ)   = r(1 − cos θ) + l(1 − √(1 − λ² sin² θ))          piston travel from TDC
dx/dθ  = r[sin θ + λ sin 2θ / (2√(1 − λ² sin² θ))]
T      = F · dx/dθ = F r sin(θ + β)/cos β                 crank torque (virtual work)
F_rod  = F / cos β,   F_side = F tan β
V(θ)   = V_c + A·x(θ)
```

Pressure models, as a function of cycle angle φ = (θ − θ_TDC + firingOffset) mod 720° (four-stroke; 360° two-stroke),
with φ = 0 at firing TDC:

- **table**: linear interpolation of gauge pressure, periodic. The table must cover the full cycle
  (`FPR_PRESSURE_TABLE_GAP` otherwise).
- **wiebe** (single zone, no heat loss, no gas exchange modelled):
  - Intake (φ ∈ [360°, 540°]) at `intakePressurePa`; exhaust (φ ∈ [180°, 360°]) at ambient pressure.
  - Compression from BDC (540°) at intake pressure, polytropic with n_c: p = p_in·(V_bdc/V)^{n_c}.
  - From φ₀ = startDeg (negative = before TDC), integrate dp/dφ = [(γ − 1)·Q·dx_b/dφ − γ·p·dV/dφ] / V [C-R19], with
    γ = n_c during the burn. Wiebe burn: x_b = 1 − exp(−a((φ − φ₀)/Δφ)^{m+1}) [C-R15].
  - After φ₀ + Δφ, polytropic expansion with n_e until 180°.
  - Integration: RK4 on a 0.1° grid. Precomputed once per run (pressure depends on angle only).
  - The ODE is linear in (p, Q), so p(φ) = p_mot(φ) + Q·g(φ). Calibration to `target_imep_Pa` is therefore exact:
    Q = (IMEP·V_d − W_mot) / W_g, with W = ∮p dV. If Q < 0, the model refuses with `FPR_IMEP_UNREACHABLE`.
  - Defaults suggested in descriptions, never silent: a = 5, m = 2 for gasoline [C-R16]. n_c and n_e have no fetched
    primary source, so they must be given (no default).
- **Force**: F = (p_abs − p_ambient)·A along +axis toward the crank, applied as the prismatic joint's generalised
  force.
- **Engine report**: per cylinder and total torque vs crank angle (resampled at 1° over the last full cycle); mean
  torque; indicated power P = T_mean·ω; IMEP = W/V_d per cylinder; cycle-energy closure
  ε = |∮T_gas dθ − Σ W_k| / Σ W_k (named gate 0.5 %), with T_gas the SIMULATED torque (gas force against the simulated piston speed) and, when a speed governor is the only other load, also against the governor work plus the crank kinetic energy change; the analytic torque is reported separately (`analyticMeanTorqueNm`); speed ripple δ = (ω_max − ω_min)/ω_mean and the analytic
  ΔE/(I·ω₀²) [C-R25]; peak pressure and its crank angle; peaks of the derived loads.

### 5.5 Mobility (TR-FPR-09)

Gruebler: DOF_G = 6·(movable bodies) − Σ constraints (revolute 5, prismatic 5, spherical 3) [A-R59]. Rank method:
tree coordinates q (one per tree joint). Loop residual Φ(q): for each loop, the position difference of the anchor seen
from both bodies (3 rows), plus 2 axis-alignment rows for revolute loops. Then J = ∂Φ/∂q by central differences
(h = 1e-7 rad or m), and QR with column pivoting. DOF = n_q − rank(J). Redundant rows = rows − rank. Each is reported
as the loop and component with the smallest pivot ("loop `wrist_j`: rotation about x is already fixed by the tree").
The suggestion is `kind: 'spherical'` when the redundancy is rotational at a revolute loop. A start-pose residual
above the gate gives `FPR_LOOP_OPEN`.

### 5.6 Motion clearance (TR-FPR-10)

1. Poses: body b at sample i is the rigid motion (COM translation + quaternion relative to t = 0) applied to its
   entities. Instances in a kinematic sweep use the `motion_study` transforms.
2. Pairs: every pair with at least one moving part, after per-sample AABB pruning. Pairs inside one body are skipped.
3. Per pair and sample: `minDistance(maxDistance = clearance + ε_touch)`, then `intersects` when the distance
   is 0, as one batch through `ctx.geometryQueries` (`meshBvh` or `llull-compute geomq`, TR-FPR-19).
4. **No tunnelling** (FR-FPR-21): the displacement bound of part b between samples is
   δ = |Δc| + |Δθ|·R_b (COM travel plus rotation angle times bounding radius). When δ exceeds the clearance (or
   ε_touch), the interval is subdivided with poses interpolated (lerp COM, slerp orientation), up to `maxSamples`.
   Hit intervals are bisected to 1e-3 of the sample interval.
5. **Worst pose**: re-evaluate the two placed recipes and compute the exact intersection volume through the kernel.
6. Output: per pair, min clearance with time, crank angle and witness points; collision intervals with start/end
   time and angle, max penetration estimate and the volume at the worst pose; the achieved resolution. Pairs joined by
   a joint whose min distance ≈ the realised clearance are `touch` (pin in bore), not a failure.

### 5.7 `check_prototype`

Order: `check_assembly` → `inspect_dynamics` (mobility) → `simulate_motion` (duration = settle + cycles·(720°/ω), with
`reactions: 'peaks'`) → `check_motion_clearance` (same run) → realism checks (materials, plausibility, timestep
halving) → `compare_to_reference` (when `doc.prototype.references` is non-empty). It stops at the first `fail` that makes later checks
meaningless: an invalid part, a floating moving body, or an open loop. Each skipped check is reported as `not_run`
with the reason. Verdict: `ready_for_review` when no `fail` remains after intents and human-accepted dispositions;
otherwise `blocked`. `ownerSummary` (AF-36) is one sentence each: what was done, what passed (with the key numbers),
what needs a human, and how far to trust the numbers (calibrated vs predicted, the largest band). It ends with
"Computed by llull, not approved — needs a qualified engineer."

### 5.8 Realism laws (FR-FPR-70…79)

- **Losses** (`engineLosses.ts`). FMEP is evaluated per cycle at the mean rpm of the previous cycle.
  - `component`: the sum of crankshaft, reciprocating (with gas-load term), valvetrain, auxiliary and pumping terms
    [E-R9]. It is implemented **only after** the equations are checked against the primary source (§11 Q8). Until
    then, VC-FPR-29 is the reference for the reconstructed form.
  - `chen_flynn`: A + B·p_max + C·n + D·n² [E-R10].
  - `fmep_table`: linear interpolation, clamped, with `FPR_OUTSIDE_VALIDATED_RANGE` outside the table.
  - The torque is applied as in TR-FPR-15.
  - Report: FMEP and its components, BMEP = IMEP − FMEP, brake torque = BMEP·V_d/(4π) (cross-checked against the
    simulated mean crank torque), and η_m = BMEP/IMEP [E-R11].
- **Single zone** (`singleZone.ts`):
  - The ODE is dp/dθ = −k·(p/V)·dV/dθ + ((k−1)/V)·(dQ_in/dθ − dQ_loss/dθ) [E-R8], with k = 1.35 (named), and
    dQ_loss/dθ = h·A_w·(T − T_w)/ω.
  - h follows Woschni [E-R17][E-R18]. T comes from the ideal gas with the trapped mass, set at intake closing (BDC,
    `intakePressurePa`, `intakeTempK`).
  - Burn: given CA50, θ₀ = CA50 − Δθ·(ln 2/a)^{1/(m+1)} [E §2.1]. Δθ(n) = Δθ_ref·(n/n_ref)^0.2 [E-R12].
  - Gas exchange (360–540°, 180–360°) at intake and ambient pressure, as before.
- **Calibration**: secant iteration on Q_total (TR-FPR-16) against the brake target at each calibration point,
  including the FMEP at that point. With several points, Q is interpolated linearly in rpm, and the result is
  `heat: table_vs_rpm` with `origin: calibrated` at those points only.
- **Gear loss** (`gearLoss.ts`): see TR-FPR-17. With teeth, the ratio is z₂/z₁, exact (51/21 [E-R4]).
- **Propeller table** (`propellerTable.ts`):
  - J = V/(nD), with n in rev/s.
  - C_T and C_P come from the table by monotone cubic (PCHIP) interpolation. J = 0 uses the static coefficients.
  - Thrust T = C_T·ρn²D⁴, power P = C_P·ρn³D⁵, torque Q = P/(2πn), applied against rotation [C §5].
- **Timestep halving** (FR-FPR-79): the same calibration point at dt/2. The change in mean brake torque and in peak
  wrist-pin force gives U_num, which is reported.
- **Reference comparison** (TR-FPR-18): E = S − D. U_val = √(U_num² + U_input² + U_D²); missing terms are left
  out and listed. The status uses the band: |E/D| ≤ band → pass. A miss is a fail (`FPR_REFERENCE_MISMATCH`) when
  the reference is grade A/B and the point is a hold-out; otherwise it is a warn. Calibration points have status
  `info`.

### 5.9 Numerical tolerances (named, in provenance)

| Name | Default |
| ---- | ------- |
| ε_touch | max(1e-3 doc units, kernel tolerance) |
| ε_vol (relative) | 1e-6 × smaller part volume |
| containment ratio | 0.99 |
| loop residual tiers | pass ≤ 1e-6 m, warn ≤ 1e-5 m, fail above (FR-FPR-15) |
| energy-closure gate | 0.5 % |
| timestep-halving gate | 1 % |
| calibration tolerance | 0.1 % on the brake target, ≤ 30 secant iterations |
| reference band (default) | ±5 % per point [E-R20] |
| friction smoothing ω_s | 1 rad/s |
| mobility rank tolerance | 1e-6 × max |pivot| (central-difference noise floor) |
| thickness ray start offset | 1e-6 × part diagonal |
| corner exclusion | 0.5 × threshold |
| tessellation tolerance | kernel default, reported |

## 6. Interop & persistence

- `doc.dynamics.cylinders`, `doc.dynamics.solver` and `doc.prototype` serialise with the document. Load validation is
  extended in `commands/persistence/{dynamicsValidation,validation}.ts`, and a golden save/reload round trip is added
  (the existing load-validation pattern).
- `check_prototype --save review.json` writes the full result (checks, items, provenance, hashes). The Review tab can
  open that file without re-running the checks. `simulate_motion --save` writes series as CSV for charts.
- The aerospace 05 / PHY-10 load export of reactions is V1 (FR-FPR-14 provides the data).

## 7. CLI / MCP / UI surfaces

**CLI/MCP**: registry commands only (AF-01). Descriptions state units and the next call. `llull guide` gains a
"Functional prototype" section: the plan of §6.1 in the functional spec, the codes, and how to fix each. The
production gate's agent driver runs the reference engine scenario (validation/README §4).

**UI** (Lane 2, `src/ui/**`, presentation only, L1):

| Component | Path | Data |
| --------- | ---- | ---- |
| `ReviewPanel` (rail tab `review`) | `src/ui/panels/review/ReviewPanel.tsx` | dispatches `check_prototype`; holds the last result in `reviewStore` (UI state, not the document) |
| `ReadinessChecklist`, `ChecklistRow` | `src/ui/panels/review/ReadinessChecklist.tsx` | `CheckResult[]`; status icon + word; Explain link |
| `FindingsList` | `src/ui/panels/review/FindingsList.tsx` | items, filters, sort, grouping; dispatches `set_review_disposition` |
| `MechanismGraph` | `src/ui/panels/review/MechanismGraph.tsx` | `inspect_dynamics.data.topology/mobility`; SVG layered layout rooted at ground; selection synced with `useStore` |
| `ExplainDrawer` | `src/ui/panels/review/ExplainDrawer.tsx` | `provenance` + item; "copy as CLI" builds the query string from the command name and params |
| `SignOffBar` | `src/ui/panels/review/SignOffBar.tsx` | enabled state from the result + `doc.prototype`; dispatches `sign_prototype_review` |
| `TimelineDock`, `SeriesChart` (generalises `SpeedChart`) | `src/ui/components/TimelineDock.tsx`, `src/ui/panels/SeriesChart.tsx` | one cursor from `dynamicsPlaybackStore` (add `cursorTime`, `axis: 'time' \| 'crank'`); event markers |
| `FindingsOverlay` | `src/ui/viewport/3d/FindingsOverlay.tsx` | isolate and ghost, overlap volume mesh (tessellated intersection recipe), witness segments with labels |
| `ThicknessOverlay` | `src/ui/viewport/3d/ThicknessOverlay.tsx` | per-vertex colours from thickness samples (cividis; diverging around the threshold) |
| `TracePathOverlay`, joint glyphs | `src/ui/viewport/3d/TracePathOverlay.tsx`, extend `MechanismOverlay.tsx` | poses from the run; glyph per joint kind; loop joints dashed |
| Reaction arrows | extend `DynamicsLoadsOverlay` + `src/ui/dynamicsLoads.ts` | new layer `reactions` from `data.reactions` at the cursor time |

Colours: Okabe-Ito tokens for categories, added to `src/ui/styles` as CSS variables in light and dark. Status icons
use distinct shapes (✔ ▲ ✖ ○ ◌) with text [D-R43][D-R44].

### 7.1 Stable codes (AF-11)

| Code | Status | Meaning → remediation |
| ---- | ------ | --------------------- |
| `FPR_PART_INVALID` | fail | kernel says the solid is invalid → rebuild the feature; see `status` |
| `FPR_PART_EMPTY` | fail | zero volume → check booleans that removed everything |
| `FPR_PART_DISCONNECTED` | fail | N lumps in one part → split into parts or join with material |
| `FPR_PART_SHEET` | fail | zero-thickness surface or open shell → give it thickness (`shell`, extrude) |
| `FPR_PAIR_HARD` | fail | overlap volume V → move/resize, or `allow_interference` with a reason |
| `FPR_PAIR_CONTAINED` | fail | part inside another → remove the duplicate or subtract |
| `FPR_PAIR_TOUCH` | info | touching (zero volume) |
| `FPR_PAIR_CLEARANCE` | warn | gap below the required clearance |
| `FPR_PAIR_ALLOWED` | pass | overlap matches a declared intent (shown with its reason) |
| `FPR_PART_FLOATING` | fail | component not attached to anything grounded → joint, fasten, ground or remove |
| `FPR_PART_RESTING_ONLY` | warn | held only by contact → add a joint or fastener |
| `FPR_WALL_THIN` | fail | min wall below the threshold (value, threshold, source) |
| `FPR_JOINT_NOT_REALISED` | warn (MVP) | no pin/bore coaxial with the joint → model the journal and the bore |
| `FPR_JOINT_REALISED` | pass | pin and bore found (diametral clearance, engagement) — added by slice A |
| `FPR_NO_PARTS` | not_run | the document or scope has no 3D parts → add solids or instances (an empty check is never a pass) |
| `FPR_STALE_REFERENCE` | info | `doc.prototype` refers to deleted entities; they were ignored → remove the intent or release the part |
| `FPR_WALL_MEASURED` | info | wall thickness measured without a threshold → give `process` or `minWallMm` — added by slice A |
| `FPR_SPHERICAL_TREE` | refusal | a spherical joint would carry a body alone (it can only close a loop; accepted at declaration, reported by inspect/simulate) → add a revolute or prismatic joint |
| `FPR_JOINT_DANGLING` | refusal | a joint references a body that does not exist → delete the joint or restore the body |
| `FPR_PRESSURE_MODEL_INVALID` | refusal | pressure model leaves its valid range (burn outside the stroke, integration left the physical range) → change phasing or constants |
| `FPR_LOOP_PRISMATIC` | refusal | loop would close through a prismatic joint → re-order or make that joint a tree joint |
| `FPR_LOOP_OPEN` | fail | loop gap at the start pose → fix the anchors or geometry |
| `FPR_REDUNDANT_CONSTRAINT` | warn | redundant direction at a loop → use `spherical` for that joint |
| `FPR_LOOP_DRIFT` | warn / fail | residual 1–10 µm (warn) or > 10 µm (fail) → smaller timestep, `set_dynamics_solver` |
| `FPR_MASS_DEFAULTED` | warn | body mass from the default density → `assign_material` with a sourced material |
| `FPR_UNREALISTIC` | warn | value outside its plausibility band (value, band, source) → check the input named in the item |
| `FPR_OUTSIDE_VALIDATED_RANGE` | warn | operating point outside the propeller table / reference / friction data |
| `FPR_REFERENCE_MISMATCH` | fail / warn | hold-out point outside its band (S, D, E, U_val) → review the model input with the largest band |
| `FPR_TIMESTEP_SENSITIVE` | warn | halving dt changes results by > 1 % → smaller timestep |
| `FPR_CALIBRATION_FAILED` | refusal | brake target not reached (target, best, iterations) |
| `FPR_NO_LOSSES` | refusal | brake comparison without `set_engine_losses` |
| `FPR_ENERGY_CLOSURE` | fail | ∮T dθ ≠ Σ∮p dV beyond the gate → timestep or loop settings |
| `FPR_PRESSURE_TABLE_GAP` | refusal | table does not cover the cycle |
| `FPR_IMEP_UNREACHABLE` | refusal | target IMEP below the motored work |
| `FPR_NO_MOTION` | fail | no poses to check → run `simulate_motion` or give a sweep |
| `FPR_SAMPLING_COARSE` | warn | resolution not reached within the budget |
| `FPR_KERNEL_UNSUPPORTED` | not_run | the installed kernel lacks `analyze`/`distance`/topology axes |
| `FPR_BUDGET_EXCEEDED` | refusal | limit and how to narrow the request |
| `FPR_HUMAN_GATE` | refusal | the act needs a human reviewer |
| `FPR_SIGNOFF_BLOCKED` | refusal | open fails or stale dispositions (listed) |

## 8. Performance & robustness budgets

| Item | Budget (named) |
| ---- | -------------- |
| Parts per `check_assembly` | 500; pairs after broad phase 20 000 |
| Thickness rays | 2000 per part by default, 200 000 total (TS path); native `geomq`: higher cap, target set from VC-FPR-37 measurement — TBD measure |
| `check_motion_clearance` | 4000 samples × 200 pairs; reference engine < 5 s on the desktop (TS path); native `geomq`: target ≥ 10× the pose × pair product in the same time (target, TBD — measure) |
| Simulation | 2 × 10⁶ steps (reference engine: 2 cycles at 5800 rpm, dt 14.4 µs ≈ 2900 steps) |
| `compare_to_reference` | ≤ 12 operating points × (settle + 2 cycles); Rotax curve (9 points) < 30 s on the desktop; the timestep-halving run is counted once |
| Review tab | open a saved result < 300 ms; playback ≥ 30 fps with overlays |

## 9. Test strategy (VC mapping)

| Layer | Tests | VCs |
| ----- | ----- | --- |
| Unit, core geometry | `meshBvh` (intersects, distance, ray) against brute force on random meshes, with a seeded generator stored in the test; pair classification on boxes; thickness on plates; connectivity graphs | VC-FPR-01…08 |
| Unit, kernels | `analyze` and `distance` on both kernels with the same cases; coincident-face cases; joint-realisation cylinders (OCC) | VC-FPR-01…05, 09 |
| Unit, dynamics | topology (BFS order, prismatic preference, flips), mobility rank on slider-crank and four-bar, Wiebe calibration linearity, exact slider-crank formulas vs `engine_quick_check` | VC-FPR-15, 20 |
| MuJoCo integration (`tests/unit/mujocoPhysics*.test.ts`) | kinematics, static torque, reactions, residual, energy closure, gear ratio, flywheel ripple | VC-FPR-10…17, 21 |
| Motion clearance | rotating bar vs block: analytic clearance and contact interval | VC-FPR-18, 19 |
| Unit, realism laws | PNH terms (VC-29), material mass (VC-30), gear loss (VC-27), single-zone calibration convergence, PCHIP propeller table, accuracy band propagation (RSS, `null` stays `null`), E/U_val with synthetic S (VC-31), loop tiers (VC-35) | VC-FPR-27, 29…31, 34…36 |
| MuJoCo integration, realism | motored inertia torque (VC-28), brake calibration (VC-15), timestep halving (VC-33), friction torque cycle average = FMEP·V_d (TR-FPR-15) | VC-FPR-15, 28, 33 |
| Validation (V1, production gate) | four-cylinder Rotax-class reference against the full-throttle curve and the static rpm window; result recorded, misses listed (KPI, not a CI gate) | VC-FPR-31, 32 |
| Contract | `toToolSchemas()` snapshot gains the new commands; load validation of the new slices; `is pure` on every command | VC-FPR-23 |
| Native (`npm run native:check`; `server/tests` with `llull-compute`) | `llull-bvh` / `llull-geomq` vs brute force; GPU vs Rust-CPU twin where an adapter exists (skip logged otherwise); native vs `meshBvh.ts` on VC-FPR-07, 08, 18, 19 and seeded random meshes | VC-FPR-37 |
| Golden | `build_project` plan of the reference engine → id-normalised snapshot + replay equality | VC-FPR-24 |
| Component (Testing Library) | checklist row (icon + word + value + source), findings filter and disposition dispatch, sign-off disabled reason, Explain content, mechanism graph rendering | VC-FPR-22, 25 |
| E2E (Playwright) | open the Review tab on the reference engine, click a finding → isolated, scrub → chart cursor moves, crank axis | VC-FPR-26 |
| Production gate | agent driver runs the reference scenario CLI-only and compares to `expected_results.json` | VC-FPR-24 |

## 10. Delivery plan

| M | Content | Lanes | Depends on | Effort |
| - | ------- | ----- | ---------- | ------ |
| M1 | Kernel `analyze` + `distance` (both kernels), `meshBvh`, `check_assembly` (validity, pairs, connectivity, ray thickness, process table), intents and grounding commands, codes, unit tests VC-01…08 | 1 (core + kernels) | — | 2 w |
| M2 | Dynamics topology, loops in MJCF, solver settings, reactions + residual in the trace, mobility in `inspect_dynamics`, VC-10…13, 20, 21 | 1 + physics | — (parallel with M1) | 2 w |
| M3 | `add_cylinder_pressure` (table, Wiebe, calibration), engine report, `engine_quick_check`, VC-14…17 | 1 | M2 | 1.5 w |
| M3b | Realism: `Accuracy` envelope, materials with sources + `FPR_MASS_DEFAULTED`, `set_engine_losses` (after Q8), single-zone Woschni + brake calibration, gear efficiency, propeller C_T(J)/C_P(J) + inertia check, plausibility checks, `add_reference_data` presets, `compare_to_reference`, timestep halving; VC-15, 27…36 | 1 | M3 | 2.5 w |
| M4 | `check_motion_clearance`, `check_prototype`, joint realisation (OCC topology axes), VC-09, 18, 19, 24; reference engine plan | 1 | M1, M3b | 1.5 w |
| M5 | Review tab: checklist, findings + overlay, mechanism graph, timeline dock with crank axis + `SeriesChart`, reaction arrows, thickness map, Explain, dispositions + interim sign-off; component + e2e tests VC-22, 25, 26 | 2 (+3 for overlays) | M1 data shapes (can start on fixtures after M1), M4 | 2.5 w |
| RS-6 | `GeometryQueryEngine` port + TS default; `llull-compute geomq` (clearance batch, thickness rays) on `llull-bvh`, host installation, VC-FPR-37 | 1 + 4 (server) | M4, RS-0 (`solver/` workspace) | 2 w (share of RS1 RS-6) |
| V1 | Fits on joints, inscribed-sphere thickness, swept volume, Rotax-class 4-cylinder reference with gearbox validated against the full-throttle curve and static rpm window, load-dependent joint friction, cycle-to-cycle variation, bsfc, reaction export to 05 / PHY-10 | 1, 2 | MVP | 3.5 w |

M5 also covers the accuracy badges, the "Matches reality" row and the reference overlays on charts (FR-FPR-62/63),
within its 2.5 w. MVP is about 12 weeks of agent lane time. M1 and M2 run in parallel; M5 starts on fixtures after M1.

## 11. Open questions / decisions needed

1. **PHY-10 vs MuJoCo. Decided 2026-10-16 (owner): "reflect reality, not 100 % exact but accurate".**
   - PHY-21 delivers on MuJoCo. Its constraint error is gated against the physical pin clearance (FR-FPR-15) and
     its convergence is checked by timestep halving (FR-FPR-79).
   - The effort goes into realism (§5.8) and validation against real data.
   - PHY-10's exact solver is not a prerequisite. It is reconsidered only if an FEA load export needs reactions of
     record.
2. **Two mechanism models.** `doc.joints` (kinematic, instances) and `doc.dynamics` (bodies). PHY-21 reads both.
   Should a later change derive one from the other (mature tools reuse assembly mates as joints [A-R18][A-R43])?
   Proposal: a separate core task after PHY-21.
3. **Placement. Decided 2026-10-16 (owner): core for now, in its own folder.**
   - The engine-specific parts (`add_cylinder_pressure`, `engine_quick_check`, `set_engine_losses`, reference data,
     the cylinder-pressure, loss and engine-report laws) live in `packages/core/src/dynamics/engine/` and
     `packages/core/src/commands/dynamics/engine/`. Generic dynamics code never imports from them.
   - A plugin cannot contribute force laws today (`CadPlugin` has commands, guards and document data only), and
     these laws run in `loads(state)`. Extract to a plugin package when a second engine domain appears or a plugin
     force-law extension point exists; with the folder boundary that is a move.
   - `add_propeller` stays where it is; it moves with the engine folder if that is extracted.
4. **Kernel interface growth. Decided 2026-10-16 (owner): approved.** Optional `analyze` and `distance` plus face
   axes on `GeometryKernel` (§5.1, TR-FPR-01/02), as built in FPR-A. A kernel returning null makes the dependent
   items `not_run`.
5. **Human gate before 09 PLM. Decided 2026-10-16 (owner): no sign-off in the MVP.**
   - `sign_prototype_review`, `SignOffBar` (FR-FPR-33, the sign button of FR-FPR-58) and `FPR_SIGNOFF_BLOCKED` are
     deferred until 09's signature path exists.
   - `set_review_disposition` stays. Without `ctx.caller` the agent check of FR-FPR-31 cannot be enforced, so
     `FPR_HUMAN_GATE` is deferred too. An `accepted` disposition is recorded but never turns a fail into a pass:
     the verdict reports it as "fail (accepted)". VC-FPR-22 is reduced to that rule.
6. **Reference engine geometry.** The user's existing propeller model was not found in the repo. Use the
   single-cylinder demonstrator (validation/README §4) for MVP and a Rotax-912-class 4-cylinder for V1? Engine data
   that is not public (rod length, masses, pressure trace) stays stated test input, `unverified`.
7. **MuJoCo version. Decided 2026-10-16 (owner): migrate to the latest (3.16.0).** Done after FPR-B merges, as its
   own change (`packages/physics-mujoco` and `server` pins together), re-running VC-FPR-10…17 and the dynamics suite.
8. **Friction equations. Decided 2026-10-16 (owner): skipped for now, no source available.**
   - The PNH / Sandoval–Heywood forms in note E were reconstructed from an OCR scan [E-R9] and are unchecked
     against SAE 890836 / 2003-01-0725 or Heywood ch. 13.
   - MVP ships `fmep_table` and `chen_flynn` only. `component` is refused as unsupported, never approximated.
   - Revisit when someone can check the equations against one of those sources.
9. **Real data for the target design. Decided 2026-10-16 (owner): none available.**
   - Validation is limited to the public Rotax and Lycoming curves (FR-FPR-77) and the rpm windows.
   - The MVP demonstrator is the single-cylinder engine (Q6). Piston and rod masses stay test values, `unverified`.

10. **Native batch engine call style (RS1).** The `GeometryQueryEngine` port is synchronous like the other ports. The host
    implementation can run the `geomq` job and wait (the CLI command blocks, progress on stderr), or the CLI can route the
    large case as a job and return the same envelope. Proposal: blocking call in the MVP of RS-6; revisit if the UI needs
    cancellation.

## 12. References

See [`validation/sources.md`](validation/sources.md) and the research notes in [`validation/research/`](validation/research/).
